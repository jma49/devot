//! Automatic local backups: a snapshot of the database in `<app data>/backups/` when the last one
//! taken is a day old, keeping the last `KEEP`. Until sync exists these are the only second copy of
//! the notes. Snapshots run on their own thread and connection; restoring first copies the current
//! data aside.
//! Backups go in the order they were taken, which the number in their names keeps, never by the
//! time beside it: the clock can be set back or ahead, and a backup taken then must neither be the
//! first to go nor stay the newest.

use crate::atomic_file::{self, Place, TempDir};
use crate::{logs, storage};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

pub const DIR: &str = "backups";
pub const KEEP: usize = 7;
/// Safety copies kept, apart from the backups: enough to restore every
/// backup in turn and still go back to the notes from before the first.
pub const KEEP_SAFETY: usize = KEEP;
const DAY_MS: i64 = 86_400_000;
/// By a clock that setting the time does not move.
const DAY: Duration = Duration::from_secs(86_400);
const PREFIX: &str = "devot-";
const SUFFIX: &str = ".sqlite";
const SAFETY: &str = "-before-restore";
const STAMP_LEN: usize = 24;
const FIRST_CHECK: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(3600);
pub const FAILED_EVENT: &str = "devot://backup-failed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Backup,
    Safety,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub created_at: i64,
    pub size: u64,
    #[serde(skip)]
    pub seq: u64,
    #[serde(skip)]
    pub kind: Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Name {
    pub created_at: i64,
    pub seq: u64,
    pub kind: Kind,
}

fn stamp(ms: i64) -> String {
    logs::utc_iso(ms).replace([':', '.'], "-")
}

/// `devot-2026-10-10T12-34-56-789Z-42.sqlite`: the UTC time, then the
/// backup's number, then `-before-restore` for a safety copy.
pub fn file_name(ms: i64, seq: u64, kind: Kind) -> String {
    let tag = match kind {
        Kind::Backup => "",
        Kind::Safety => SAFETY,
    };
    format!("{PREFIX}{}-{seq}{tag}{SUFFIX}", stamp(ms))
}

fn unnumbered_name(ms: i64) -> String {
    format!("{PREFIX}{}{SUFFIX}", stamp(ms))
}

fn epoch_ms(year: i64, month: i64, day: i64, secs_of_day: i64, millis: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    (days * 86_400 + secs_of_day) * 1000 + millis
}

fn parse_stamp(stamp: &str) -> Option<i64> {
    let b = stamp.as_bytes();
    if b.len() != STAMP_LEN || b[10] != b'T' || b[23] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| stamp.get(from..to)?.parse::<i64>().ok();
    Some(epoch_ms(
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)? * 3600 + num(14, 16)? * 60 + num(17, 19)?,
        num(20, 23)?,
    ))
}

/// A name from before backups were numbered counts as number 0, so it comes before every numbered
/// one.
pub fn parse_name(name: &str) -> Option<Name> {
    let rest = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    let created_at = parse_stamp(rest.get(..STAMP_LEN)?)?;
    let (seq, kind, written) = match rest.get(STAMP_LEN..)? {
        "" => (0, Kind::Backup, unnumbered_name(created_at)),
        tail => {
            let tail = tail.strip_prefix('-')?;
            let (number, kind) = tail
                .strip_suffix(SAFETY)
                .map_or((tail, Kind::Backup), |number| (number, Kind::Safety));
            let seq = number.parse().ok()?;
            (seq, kind, file_name(created_at, seq, kind))
        }
    };
    // Only names this module writes: anything else fails the round trip.
    (written == name).then_some(Name {
        created_at,
        seq,
        kind,
    })
}

pub fn list(dir: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut backups: Vec<BackupInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            let name = parse_name(&id)?;
            let size = entry.metadata().ok()?.len();
            Some(BackupInfo {
                id,
                created_at: name.created_at,
                size,
                seq: name.seq,
                kind: name.kind,
            })
        })
        .collect();
    // Unnumbered names among themselves by their time, the best there is.
    backups.sort_by_key(|b| std::cmp::Reverse((b.seq, b.created_at)));
    backups
}

fn next_seq(dir: &Path) -> u64 {
    list(dir)
        .iter()
        .map(|b| b.seq)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

/// Due when the last backup taken is a day old by the wall clock (`now`) and this process has not
/// taken one within the last day (`since_last`, see `monotonic`; `None` before its first). A backup
/// from the future means the clock was set back and its age is unknown: then only the second rule
/// applies. So a clock set back, or set right after running slow, costs a backup a day, never one
/// an hour.
pub fn due(backups: &[BackupInfo], now: i64, since_last: Option<Duration>) -> bool {
    let a_day_since_ours = since_last.is_none_or(|ran| ran >= DAY);
    match backups.first() {
        None => true,
        Some(last) if last.created_at > now => a_day_since_ours,
        Some(last) => a_day_since_ours && now - last.created_at >= DAY_MS,
    }
}

/// A clock that setting the time does not move and that keeps counting while the Mac sleeps
/// (`Instant` stops then).
fn monotonic() -> Duration {
    #[cfg(target_os = "macos")]
    if let Some(since_boot) = crate::native::macos::time_since_boot() {
        return since_boot;
    }
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed()
}

/// Keeps the last `KEEP` backups and, apart from them, the last `KEEP_SAFETY` safety copies;
/// `taken`, the backup just taken, always stays. So does the first safety copy taken after each
/// backup kept: it holds the notes from before a run of restores, which no backup has. It goes once
/// the backup before it has. Only names this module writes go, and only from `dir`.
pub fn prune(dir: &Path, taken: &str) {
    let backups = list(dir);
    let kept: Vec<&str> = backups
        .iter()
        .filter(|b| b.kind == Kind::Backup)
        .take(KEEP)
        .map(|b| b.id.as_str())
        .collect();
    let mut first_copies = Vec::new();
    let mut after_kept = false;
    for b in backups.iter().rev() {
        match b.kind {
            Kind::Backup => after_kept = kept.contains(&b.id.as_str()),
            Kind::Safety if after_kept => {
                first_copies.push(b.id.as_str());
                after_kept = false;
            }
            Kind::Safety => {}
        }
    }
    for (kind, keep) in [(Kind::Backup, KEEP), (Kind::Safety, KEEP_SAFETY)] {
        let old = backups.iter().filter(|b| b.kind == kind).skip(keep);
        for old in old.filter(|b| b.id != taken && !first_copies.contains(&b.id.as_str())) {
            if std::fs::remove_file(dir.join(&old.id)).is_err() {
                log::warn!("W_BACKUP_PRUNE_FAILED");
            }
        }
    }
    tidy(dir);
}

/// Removes the folder of a snapshot that never finished (the app quit or crashed during it), an
/// older build's partial file, and the side files of a backup that is gone. A running snapshot
/// keeps its folder locked (see `take`); callers hold `Backups::lock` too, which keeps this
/// process's snapshots safe where the file system cannot lock. Only what is in `dir` goes, never
/// what a link there points to.
pub fn tidy(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        // The entry itself: a link is neither a folder nor a file here.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let path = entry.path();
        let removed = if meta.is_dir() && atomic_file::is_temporary(&name) {
            match remove_unfinished(&path) {
                Some(removed) => removed,
                None => continue,
            }
        } else if meta.is_file() && (is_old_partial(&name) || is_orphan_side_file(dir, &name)) {
            std::fs::remove_file(&path)
        } else {
            continue;
        };
        if removed.is_err() {
            log::warn!("W_BACKUP_TIDY_FAILED");
        }
    }
}

const SIDE_FILES: [&str; 3] = ["-journal", "-wal", "-shm"];

fn side_file_of(name: &str) -> Option<&str> {
    SIDE_FILES.iter().find_map(|side| name.strip_suffix(side))
}

/// A side file of a backup that is gone (older snapshots were in WAL mode).
fn is_orphan_side_file(dir: &Path, name: &str) -> bool {
    side_file_of(name).is_some_and(|main| parse_name(main).is_some() && !dir.join(main).exists())
}

/// The partial file an older build wrote beside the backups
/// (`.devot-2026-10-10T12-34-56-789Z.sqlite.partial`).
fn is_old_partial(name: &str) -> bool {
    side_file_of(name)
        .unwrap_or(name)
        .strip_prefix('.')
        .and_then(|partial| partial.strip_suffix(".partial"))
        .and_then(parse_name)
        .is_some()
}

/// On a file system that cannot lock, the folder goes.
fn remove_unfinished(folder: &Path) -> Option<std::io::Result<()>> {
    let handle = std::fs::File::open(folder).ok()?;
    if let Err(std::fs::TryLockError::WouldBlock) = handle.try_lock() {
        return None;
    }
    Some(std::fs::remove_dir_all(folder))
}

/// `tidy` leaves a locked folder alone, whoever calls it. `None` where the file system cannot lock
/// (the snapshot goes on).
fn lock_folder(folder: &Path) -> Option<std::fs::File> {
    let handle = std::fs::File::open(folder).ok()?;
    handle.try_lock().ok()?;
    Some(handle)
}

const PARTIAL: &str = "backup.sqlite";

/// SQLite makes the file by its path (see `atomic_file::TempDir`), then it is moved into `dir`
/// under the next number, never over another file. A quit leaves the folder, locked until then, for
/// `tidy`. The caller holds `Backups::lock`, so no other snapshot takes the same number.
pub fn take(db_path: &Path, dir: &Path, now: i64, kind: Kind) -> Result<BackupInfo, &'static str> {
    std::fs::create_dir_all(dir).map_err(|_| "E_BACKUP_DIR")?;
    let seq = next_seq(dir);
    let id = file_name(now, seq, kind);
    let partial = TempDir::new_in(dir).map_err(|_| "E_BACKUP_DIR")?;
    // Dropped before the folder: locked until the file is in place or gone.
    let _writing = lock_folder(partial.path());
    if storage::snapshot(db_path, &partial.path().join(PARTIAL)).is_err() {
        return Err("E_BACKUP_SNAPSHOT_FAILED");
    }
    let target = dir.join(&id);
    partial
        .persist(PARTIAL, &target, Place::New)
        .map_err(|_| "E_BACKUP_RENAME_FAILED")?;
    let size = std::fs::metadata(&target).map_or(0, |m| m.len());
    Ok(BackupInfo {
        id,
        created_at: now,
        size,
        seq,
        kind,
    })
}

pub struct Backups {
    db_path: PathBuf,
    dir: PathBuf,
    lock: Mutex<()>,
    last_error: std::sync::Mutex<Option<&'static str>>,
}

impl Backups {
    pub fn new(data_dir: &Path, db_path: &Path) -> Self {
        Self {
            db_path: db_path.to_owned(),
            dir: data_dir.join(DIR),
            lock: Mutex::new(()),
            last_error: std::sync::Mutex::new(None),
        }
    }

    /// What a quit left goes first, so its room is free for the snapshot even when that fails. The
    /// caller holds `lock`.
    fn back_up(&self, now: i64) -> Result<BackupInfo, &'static str> {
        tidy(&self.dir);
        let info = take(&self.db_path, &self.dir, now, Kind::Backup)?;
        prune(&self.dir, &info.id);
        Ok(info)
    }

    fn check(
        &self,
        now: i64,
        since_last: Option<Duration>,
    ) -> Option<Result<BackupInfo, &'static str>> {
        let _held = self.lock.blocking_lock();
        if due(&list(&self.dir), now, since_last) {
            Some(self.back_up(now))
        } else {
            tidy(&self.dir);
            None
        }
    }

    /// Copies the current data aside first as a safety copy, so the restore can be undone. It
    /// removes nothing (see `prune`).
    async fn restore(&self, db: &storage::Db, id: &str, now: i64) -> Result<(), &'static str> {
        if parse_name(id).is_none() {
            return Err("E_BACKUP_ID_INVALID");
        }
        let _held = self.lock.lock().await;
        let source = self.dir.join(id);
        if !source.is_file() {
            return Err("E_BACKUP_NOT_FOUND");
        }
        let (db_path, dir) = (self.db_path.clone(), self.dir.clone());
        tauri::async_runtime::spawn_blocking(move || {
            tidy(&dir);
            take(&db_path, &dir, now, Kind::Safety)
        })
        .await
        .map_err(|_| "E_BACKUP_TASK")??;
        db.call(move |store| store.restore_from(&source))
            .await
            .map_err(|e| {
                log::warn!("W_BACKUP_RESTORE_FAILED {e}");
                "E_BACKUP_RESTORE_FAILED"
            })?;
        log::info!("I_BACKUP_RESTORED");
        Ok(())
    }

    fn record(&self, app: &AppHandle, result: &Result<BackupInfo, &'static str>) {
        let error = result.as_ref().err().copied();
        if let Ok(mut last) = self.last_error.lock() {
            *last = error;
        }
        if let Some(code) = error {
            log::warn!("W_BACKUP_FAILED {code}");
            if app.emit_to("main", FAILED_EVENT, code).is_err() {
                log::warn!("W_BACKUP_EVENT_FAILED");
            }
        }
    }
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("devot-backups".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            let mut last: Option<Duration> = None;
            loop {
                let backups = app.state::<Backups>();
                let since_last = last.and_then(|t| monotonic().checked_sub(t));
                if let Some(result) = backups.check(logs::now_ms(), since_last) {
                    if result.is_ok() {
                        last = Some(monotonic());
                        log::info!("I_BACKUP_TAKEN");
                    }
                    backups.record(&app, &result);
                }
                std::thread::sleep(CHECK_EVERY);
            }
        });
    if spawned.is_err() {
        log::warn!("W_BACKUP_THREAD_SPAWN_FAILED");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    backups: Vec<BackupInfo>,
    last_error: Option<&'static str>,
}

#[tauri::command]
pub async fn backups_list(backups: State<'_, Backups>) -> Result<BackupStatus, String> {
    let dir = backups.dir.clone();
    let list = tauri::async_runtime::spawn_blocking(move || list(&dir))
        .await
        .map_err(|_| "E_BACKUP_TASK")?;
    Ok(BackupStatus {
        backups: list,
        last_error: backups.last_error.lock().ok().and_then(|e| *e),
    })
}

#[tauri::command]
pub async fn backup_now(app: AppHandle) -> Result<BackupInfo, String> {
    let backups = app.state::<Backups>();
    let _held = backups.lock.lock().await;
    let task_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        task_app.state::<Backups>().back_up(logs::now_ms())
    })
    .await
    .map_err(|_| "E_BACKUP_TASK")?;
    backups.record(&app, &result);
    result.map_err(String::from)
}

#[tauri::command]
pub async fn backup_restore(
    app: AppHandle,
    db: State<'_, storage::Db>,
    id: String,
) -> Result<(), String> {
    let backups = app.state::<Backups>();
    backups
        .restore(&db, &id, logs::now_ms())
        .await
        .map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_791_635_696_789;

    fn info(created_at: i64) -> BackupInfo {
        BackupInfo {
            id: file_name(created_at, 1, Kind::Backup),
            created_at,
            size: 0,
            seq: 1,
            kind: Kind::Backup,
        }
    }

    const HOUR: i64 = 3_600_000;
    const YEAR: i64 = 365 * DAY_MS;

    fn hours(n: i64) -> Option<Duration> {
        Some(Duration::from_secs(3600 * u64::try_from(n).unwrap()))
    }

    fn app_data() -> (tempfile::TempDir, Backups, storage::Db) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("devot.sqlite");
        let db = storage::Db::spawn(&db_path).unwrap();
        let backups = Backups::new(dir.path(), &db_path);
        (dir, backups, db)
    }

    fn names(backups: &Backups) -> Vec<String> {
        list(&backups.dir).into_iter().map(|b| b.id).collect()
    }

    fn a_week_of_backups(backups: &Backups) -> Vec<String> {
        for day in (0..7).rev() {
            backups.back_up(NOW - day * DAY_MS).unwrap();
        }
        let week = names(backups);
        assert_eq!(week.len(), KEEP);
        week
    }

    fn left_behind(folder: TempDir) -> PathBuf {
        let path = folder.path().to_owned();
        std::mem::forget(folder);
        path
    }

    #[test]
    fn a_restore_keeps_every_backup_and_the_copy_it_makes() {
        let (_dir, backups, db) = app_data();
        let week = a_week_of_backups(&backups);
        for (n, id) in (0..).zip(&week[..4]) {
            let now = NOW + HOUR + n * 60_000;
            tauri::async_runtime::block_on(backups.restore(&db, id, now)).unwrap();
        }
        let after = names(&backups);
        assert_eq!(after.len(), KEEP + 4, "{after:?}");
        assert!(week.iter().all(|id| after.contains(id)), "{after:?}");
        let copies: Vec<String> = after.into_iter().filter(|id| !week.contains(id)).collect();
        assert_eq!(copies.len(), 4);

        // The next backup takes the place of the oldest backup, never a copy's.
        let next = backups.back_up(NOW + DAY_MS).unwrap();
        let kept = names(&backups);
        assert_eq!(kept.len(), KEEP + 4, "{kept:?}");
        assert!(kept.contains(&next.id));
        assert!(!kept.contains(&week[KEEP - 1]));
        assert!(
            week[..KEEP - 1].iter().all(|id| kept.contains(id)),
            "{kept:?}"
        );
        assert!(copies.iter().all(|id| kept.contains(id)), "{kept:?}");
    }

    #[test]
    fn a_clock_a_year_slow_keeps_every_new_backup() {
        let (_dir, backups, _db) = app_data();
        let week = a_week_of_backups(&backups);
        let slow = NOW + HOUR - YEAR;
        // The newest backup is from the future: one is due, and it stays.
        let first = backups.check(slow, None).expect("due").unwrap();
        assert_eq!(names(&backups)[0], first.id);
        let asked = backups.back_up(slow + HOUR).unwrap();
        assert_eq!(names(&backups)[0], asked.id);
        for hour in 1..24 {
            let taken = backups.check(slow + HOUR + hour * HOUR, hours(hour + 1));
            assert!(taken.is_none(), "hour {hour}");
        }
        let next = backups
            .check(slow + HOUR + DAY_MS, hours(25))
            .expect("due")
            .unwrap();
        let kept = names(&backups);
        assert_eq!(kept[..3], [next.id, asked.id, first.id]);
        assert_eq!(kept[3..], week[..KEEP - 3]);
    }

    #[test]
    fn a_clock_once_a_year_fast_leaves_the_week_alone() {
        let (_dir, backups, _db) = app_data();
        let week = a_week_of_backups(&backups);
        // A year ahead, the newest backup looks a year old: one is due.
        let ahead = backups
            .check(NOW + HOUR + YEAR, None)
            .expect("due")
            .unwrap();
        // Set right an hour later: the newest backup is from the future, and
        // this process took one an hour ago, so none is due for a day.
        for hour in 1..24 {
            let taken = backups.check(NOW + HOUR + hour * HOUR, hours(hour));
            assert!(taken.is_none(), "hour {hour}");
        }
        let kept = names(&backups);
        assert_eq!(kept[0], ahead.id);
        assert_eq!(kept[1..], week[..KEEP - 1]);
        let next = backups
            .check(NOW + HOUR + DAY_MS, hours(24))
            .expect("due")
            .unwrap();
        assert!(backups.check(NOW + 2 * HOUR + DAY_MS, hours(1)).is_none());
        let kept = names(&backups);
        assert_eq!(kept[..2], [next.id, ahead.id]);
        assert_eq!(kept[2..], week[..KEEP - 2]);
    }

    #[test]
    fn tidying_removes_what_an_unfinished_snapshot_left() {
        let (_dir, backups, _db) = app_data();
        let kept = backups.back_up(NOW).unwrap();
        let dir = backups.dir.clone();
        let quit = TempDir::new_in(&dir).unwrap();
        std::fs::write(quit.path().join(PARTIAL), vec![0; 4096]).unwrap();
        std::fs::write(quit.path().join(format!("{PARTIAL}-journal")), b"").unwrap();
        let quit = left_behind(quit);
        let old = format!(".{}.partial", unnumbered_name(NOW - DAY_MS));
        std::fs::write(dir.join(&old), b"partial").unwrap();
        std::fs::write(dir.join(format!("{old}-journal")), b"").unwrap();
        let running = TempDir::new_in(&dir).unwrap();
        std::fs::write(running.path().join(PARTIAL), b"in progress").unwrap();
        let held = lock_folder(running.path()).expect("locked");
        // A journal of a backup that is gone goes; a backup's own stays.
        let gone = file_name(NOW - DAY_MS, 9, Kind::Backup);
        std::fs::write(dir.join(format!("{gone}-journal")), b"").unwrap();
        std::fs::write(dir.join(format!("{}-wal", kept.id)), b"").unwrap();
        std::fs::write(dir.join("notes.txt"), "mine").unwrap();
        std::fs::create_dir(dir.join(".devot-photos.tmp")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("theirs.txt"), "theirs").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            outside.path(),
            dir.join(".devot-0123456789abcdef0123456789abcdef.tmp"),
        )
        .unwrap();

        tidy(&dir);
        assert!(!quit.exists());
        assert!(!dir.join(&old).exists());
        assert!(!dir.join(format!("{old}-journal")).exists());
        assert!(running.path().join(PARTIAL).exists());
        assert!(!dir.join(format!("{gone}-journal")).exists());
        assert!(dir.join(format!("{}-wal", kept.id)).exists());
        assert!(dir.join(&kept.id).exists());
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join(".devot-photos.tmp").exists());
        assert!(outside.path().join("theirs.txt").exists());
        #[cfg(unix)]
        assert!(
            std::fs::symlink_metadata(dir.join(".devot-0123456789abcdef0123456789abcdef.tmp"))
                .is_ok()
        );

        // Once that snapshot's process has gone, its folder goes too.
        drop(held);
        let running = left_behind(running);
        tidy(&dir);
        assert!(!running.exists());
        assert_eq!(names(&backups), [kept.id]);
    }

    #[test]
    fn the_check_at_launch_tidies_when_no_backup_is_due() {
        let (_dir, backups, _db) = app_data();
        backups.back_up(NOW).unwrap();
        let quit = left_behind(TempDir::new_in(&backups.dir).unwrap());
        assert!(backups.check(NOW + HOUR, None).is_none());
        assert!(!quit.exists());
    }

    #[test]
    fn a_backup_that_fails_still_removes_what_a_quit_left() {
        // Too little room for a new snapshot: here, no database to copy.
        let dir = tempfile::tempdir().unwrap();
        let backups = Backups::new(dir.path(), &dir.path().join("missing.sqlite"));
        std::fs::create_dir(&backups.dir).unwrap();
        let failed = || Err("E_BACKUP_SNAPSHOT_FAILED");
        let quit_during_snapshot = || {
            let quit = left_behind(TempDir::new_in(&backups.dir).unwrap());
            std::fs::write(quit.join(PARTIAL), vec![0; 4096]).unwrap();
            quit
        };
        let quit = quit_during_snapshot();
        assert_eq!(backups.check(NOW, None), Some(failed()));
        assert!(!quit.exists());
        let quit = quit_during_snapshot();
        assert_eq!(backups.back_up(NOW), failed());
        assert!(!quit.exists());
        let id = file_name(NOW - DAY_MS, 1, Kind::Backup);
        std::fs::write(backups.dir.join(&id), b"backup").unwrap();
        let db = storage::Db::spawn(&dir.path().join("open.sqlite")).unwrap();
        let quit = quit_during_snapshot();
        let restored = tauri::async_runtime::block_on(backups.restore(&db, &id, NOW));
        assert_eq!(restored, Err("E_BACKUP_SNAPSHOT_FAILED"));
        assert!(!quit.exists());
    }

    #[test]
    fn eight_restores_keep_the_notes_from_before_the_first() {
        let (_dir, backups, db) = app_data();
        let week = a_week_of_backups(&backups);
        // Every backup in turn, then the newest again: eight safety copies,
        // the first holding the notes from before the restores.
        let mut copies = Vec::new();
        for (n, id) in (0..).zip(week.iter().chain(&week[..1])) {
            let now = NOW + HOUR + n * 60_000;
            tauri::async_runtime::block_on(backups.restore(&db, id, now)).unwrap();
            let copy = list(&backups.dir).remove(0);
            assert_eq!(copy.kind, Kind::Safety);
            copies.push(copy.id);
        }
        assert_eq!(copies.len(), KEEP_SAFETY + 1);
        // The next backup keeps them all: the first is in no backup.
        backups.back_up(NOW + DAY_MS).unwrap();
        let kept = names(&backups);
        assert!(copies.iter().all(|id| kept.contains(id)), "{kept:?}");
        for day in 2..=8 {
            backups.back_up(NOW + day * DAY_MS).unwrap();
        }
        let kept = names(&backups);
        assert!(!kept.contains(&copies[0]), "{kept:?}");
        assert!(copies[1..].iter().all(|id| kept.contains(id)), "{kept:?}");
        assert_eq!(kept.len(), KEEP + KEEP_SAFETY);
    }

    #[test]
    fn a_clock_a_year_slow_then_set_right_takes_one_backup_a_day() {
        let (_dir, backups, _db) = app_data();
        let week = a_week_of_backups(&backups);
        let first = backups
            .check(NOW + HOUR - YEAR, None)
            .expect("due")
            .unwrap();
        // Set right an hour later: that backup looks a year old, but this
        // process took it an hour ago, so none is due for a day.
        for hour in 1..24 {
            let taken = backups.check(NOW + HOUR + hour * HOUR, hours(hour));
            assert!(taken.is_none(), "hour {hour}");
        }
        let next = backups
            .check(NOW + HOUR + DAY_MS, hours(24))
            .expect("due")
            .unwrap();
        let kept = names(&backups);
        assert_eq!(kept[..2], [next.id, first.id]);
        assert_eq!(kept[2..], week[..KEEP - 2]);
    }

    #[test]
    fn names_round_trip() {
        let name = file_name(NOW, 42, Kind::Backup);
        assert_eq!(name, "devot-2026-10-10T12-34-56-789Z-42.sqlite");
        let backup = Name {
            created_at: NOW,
            seq: 42,
            kind: Kind::Backup,
        };
        assert_eq!(parse_name(&name), Some(backup));
        let copy = file_name(NOW, 43, Kind::Safety);
        assert_eq!(
            copy,
            "devot-2026-10-10T12-34-56-789Z-43-before-restore.sqlite"
        );
        let safety = Name {
            seq: 43,
            kind: Kind::Safety,
            ..backup
        };
        assert_eq!(parse_name(&copy), Some(safety));
        let unnumbered = unnumbered_name(NOW);
        assert_eq!(unnumbered, "devot-2026-10-10T12-34-56-789Z.sqlite");
        assert_eq!(parse_name(&unnumbered), Some(Name { seq: 0, ..backup }));
        for created_at in [0, 951_782_400_000, 4_102_444_800_000] {
            for (seq, kind) in [(1, Kind::Backup), (u64::MAX, Kind::Safety)] {
                let name = Name {
                    created_at,
                    seq,
                    kind,
                };
                assert_eq!(parse_name(&file_name(created_at, seq, kind)), Some(name));
            }
        }
    }

    #[test]
    fn refuses_names_it_did_not_write() {
        for name in [
            "devot.sqlite",
            "../devot-2026-10-10T12-34-56-789Z.sqlite",
            "devot-2026-10-10T12-34-56-789Z.sqlite-wal",
            "devot-2026-10-10T12-34-56-789Z-4.sqlite-shm",
            "devot-2026-13-10T12-34-56-789Z.sqlite",
            "devot-2026-10-10T12:34:56.789Z.sqlite",
            ".devot-2026-10-10T12-34-56-789Z.sqlite.partial",
            "devot-2026-10-10T12-34-56-789Z4.sqlite",
            "devot-2026-10-10T12-34-56-789Z-.sqlite",
            "devot-2026-10-10T12-34-56-789Z-04.sqlite",
            "devot-2026-10-10T12-34-56-789Z-+4.sqlite",
            "devot-2026-10-10T12-34-56-789Z--4.sqlite",
            "devot-2026-10-10T12-34-56-789Z-4-restore.sqlite",
            "devot-2026-10-10T12-34-56-789Z-before-restore.sqlite",
            "devot-2026-10-10T12-34-56-789Z-18446744073709551616.sqlite",
        ] {
            assert_eq!(parse_name(name), None, "{name}");
        }
    }

    #[test]
    fn backups_go_in_the_order_they_were_taken() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join(DIR);
        std::fs::create_dir(&backups).unwrap();
        let taken = [
            unnumbered_name(NOW - DAY_MS),
            unnumbered_name(NOW),
            file_name(NOW + YEAR, 1, Kind::Backup),
            file_name(NOW - YEAR, 2, Kind::Safety),
            file_name(NOW, 3, Kind::Backup),
        ];
        for name in &taken {
            std::fs::write(backups.join(name), b"backup").unwrap();
        }
        let listed: Vec<String> = list(&backups).into_iter().map(|b| b.id).collect();
        let newest_first: Vec<String> = taken.iter().rev().cloned().collect();
        assert_eq!(listed, newest_first);
        assert_eq!(next_seq(&backups), 4);
    }

    #[test]
    fn a_backup_is_due_once_a_day() {
        assert!(due(&[], NOW, None));
        assert!(!due(&[info(NOW - DAY_MS + 1)], NOW, None));
        assert!(due(&[info(NOW - DAY_MS)], NOW, None));
        // A day old by the wall clock, but this process took one an hour
        // ago (the clock was slow, then set right): not yet.
        assert!(!due(&[info(NOW - DAY_MS)], NOW, hours(1)));
        assert!(due(&[info(NOW - DAY_MS)], NOW, hours(24)));
        // The clock went back: a fresh one, unless this process took one
        // within the last day it ran.
        assert!(due(&[info(NOW + 60_000)], NOW, None));
        assert!(!due(&[info(NOW + 60_000)], NOW, hours(23)));
        assert!(due(&[info(NOW + 60_000)], NOW, hours(24)));
    }

    #[test]
    fn takes_lists_and_prunes_backups() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("devot.sqlite");
        let _store = storage::Store::open(&db).unwrap();
        let backups = dir.path().join(DIR);
        for n in 0..9 {
            take(&db, &backups, NOW + n * DAY_MS, Kind::Backup).unwrap();
        }
        std::fs::write(backups.join("notes.txt"), "not a backup").unwrap();
        let oldest = file_name(NOW, 1, Kind::Backup);
        std::fs::write(backups.join(format!("{oldest}-wal")), "").unwrap();
        let listed = list(&backups);
        assert_eq!(listed.len(), 9);
        assert_eq!((listed[0].seq, listed[0].created_at), (9, NOW + 8 * DAY_MS));
        assert!(listed.iter().all(|b| b.size > 0 && b.kind == Kind::Backup));

        prune(&backups, &listed[0].id);
        let kept: Vec<u64> = list(&backups).iter().map(|b| b.seq).collect();
        assert_eq!(kept, [9, 8, 7, 6, 5, 4, 3]);
        assert!(backups.join("notes.txt").exists());
        assert_eq!(std::fs::read_dir(&backups).unwrap().count(), KEEP + 1);
    }

    #[test]
    fn prunes_safety_copies_apart_and_never_the_backup_just_taken() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join(DIR);
        std::fs::create_dir(&backups).unwrap();
        let mut taken = Vec::new();
        for seq in 1..=19_u64 {
            let kind = if seq % 2 == 0 {
                Kind::Safety
            } else {
                Kind::Backup
            };
            let name = file_name(NOW + i64::try_from(seq).unwrap() * HOUR, seq, kind);
            std::fs::write(backups.join(&name), b"backup").unwrap();
            taken.push(name);
        }
        // The one just taken stays, even with a number that says otherwise
        // (another process numbered one past it).
        prune(&backups, &taken[0]);
        let kept: Vec<(u64, Kind)> = list(&backups).iter().map(|b| (b.seq, b.kind)).collect();
        let backup = |seq| (seq, Kind::Backup);
        let safety = |seq| (seq, Kind::Safety);
        assert_eq!(
            kept,
            [
                backup(19),
                safety(18),
                backup(17),
                safety(16),
                backup(15),
                safety(14),
                backup(13),
                safety(12),
                backup(11),
                safety(10),
                backup(9),
                safety(8),
                backup(7),
                safety(6),
                backup(1),
            ]
        );
    }

    #[test]
    fn a_failed_snapshot_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join(DIR);
        assert_eq!(
            take(
                &dir.path().join("missing.sqlite"),
                &backups,
                NOW,
                Kind::Backup
            ),
            Err("E_BACKUP_SNAPSHOT_FAILED")
        );
        assert!(list(&backups).is_empty());
        assert_eq!(std::fs::read_dir(&backups).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link_at_a_temporary_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.sqlite");
        std::fs::write(&theirs, b"theirs").unwrap();
        let db = dir.path().join("devot.sqlite");
        let _store = storage::Store::open(&db).unwrap();
        let backups = dir.path().join(DIR);
        std::fs::create_dir(&backups).unwrap();
        // The name a snapshot once went to first.
        let old = backups.join(format!(".{}.partial", unnumbered_name(NOW)));
        std::os::unix::fs::symlink(&theirs, &old).unwrap();
        let info = take(&db, &backups, NOW, Kind::Backup).unwrap();
        assert!(
            std::fs::symlink_metadata(backups.join(&info.id))
                .unwrap()
                .is_file()
        );
        assert!(info.size > 0);
        assert_eq!(std::fs::read(&theirs).unwrap(), b"theirs");
        assert_eq!(std::fs::read_dir(&backups).unwrap().count(), 2);
    }
}
