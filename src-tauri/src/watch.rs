//! Outside changes (anything else writing to the database while Devot runs): a thread takes a `stat` of the `-wal` file once a second and, when its size, modified time or identity moved, reads `PRAGMA data_version`, which ignores the app's own writes, and tells the window to merge and reload.
//! A commit's frames reach the `-wal` file before the commit becomes visible, so after a move the version is read every second until it changes or `VISIBLE_WITHIN` has passed since the last move, and once more on the first look after that.
//! A commit that becomes visible within that bound of its last write to the `-wal` file is seen by the first look after it becomes visible, even when the thread was held up past the bound, and a later one with the next write to the file; a quiet second costs one `stat`.
//! The watch never opens the database's files itself: SQLite's locks are POSIX locks, which closing any descriptor of a file drops for the whole process.

use crate::storage::Db;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};

pub const CHANGED_EVENT: &str = "devot://db-changed";
const EVERY: Duration = Duration::from_secs(1);
// Between a commit's last frame write and its wal-index header lies at most the commit's fsync, which takes milliseconds and stays well under a second even on a busy disk.
const VISIBLE_WITHIN: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub struct ChangeWatch {
    last: Option<u32>,
}

impl ChangeWatch {
    pub fn changed(&mut self, version: u32) -> bool {
        let changed = self.last.is_some_and(|last| last != version);
        self.last = Some(version);
        changed
    }
}

// What a `stat` of the `-wal` file shows: any commit, by any process, writes to it.
#[derive(Debug, Default)]
pub struct WalStamp {
    last: Option<(u64, u64, u64, SystemTime)>,
    seen: bool,
}

impl WalStamp {
    pub fn wal_path(db: &Path) -> PathBuf {
        let mut name = db.as_os_str().to_owned();
        name.push("-wal");
        PathBuf::from(name)
    }

    // True on the first look, and whenever the file's device, inode, size or modified time differs from the last look.
    // A file that cannot be read counts as moved, so the version is read as before.
    pub fn moved(&mut self, wal: &Path) -> bool {
        let now = std::fs::metadata(wal)
            .and_then(|meta| Ok((meta.dev(), meta.ino(), meta.len(), meta.modified()?)))
            .ok();
        let moved = !self.seen || now.is_none() || now != self.last;
        self.seen = true;
        self.last = now;
        moved
    }
}

#[derive(Debug, Default)]
struct Poll {
    watch: ChangeWatch,
    stamp: WalStamp,
    moved_at: Option<Instant>,
    failing: bool,
    // A read failed before there was a baseline, so a commit made meanwhile would become the baseline unreported.
    blind: bool,
}

impl Poll {
    // True when another process committed since the last look.
    fn look(
        &mut self,
        wal: &Path,
        now: Instant,
        read: impl FnOnce() -> crate::storage::Result<u32>,
    ) -> bool {
        let moved = self.stamp.moved(wal);
        if moved {
            self.moved_at = Some(now);
        }
        let Some(moved_at) = self.moved_at else {
            return false;
        };
        // The bound runs from the move to this look, so a look held up past it reads once more before the chase ends.
        let expired = now.duration_since(moved_at) > VISIBLE_WITHIN;
        match read() {
            Ok(version) => {
                self.failing = false;
                let changed = self.watch.changed(version) || std::mem::take(&mut self.blind);
                // On a look that moved, the frames just seen may belong to a commit after the one that changed the version.
                if expired || (changed && !moved) {
                    self.moved_at = None;
                }
                changed
            }
            Err(error) => {
                if !self.failing {
                    log::warn!("W_WATCH_READ_FAILED {error}");
                }
                self.failing = true;
                self.blind |= self.watch.last.is_none();
                self.stamp = WalStamp::default();
                false
            }
        }
    }
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("devot-watch".into())
        .spawn(move || {
            let mut poll = Poll::default();
            let wal = WalStamp::wal_path(app.state::<Db>().path());
            loop {
                let changed = poll.look(&wal, Instant::now(), || {
                    let db = app.state::<Db>().inner().clone();
                    tauri::async_runtime::block_on(db.call_quietly(|store| store.data_version()))
                });
                if changed && crate::main_windows::emit_all(&app, CHANGED_EVENT, ()).is_err() {
                    log::warn!("W_WATCH_EVENT_FAILED");
                }
                std::thread::sleep(EVERY);
            }
        });
    if spawned.is_err() {
        log::warn!("W_WATCH_THREAD_FAILED");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{NoteRecord, StorageError, Store};
    use rusqlite::Connection;

    const OUTSIDE_NOTE: &str =
        "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
         VALUES ('mcp', 'From outside', 'h', '', x'00', 1, 1)";

    fn second(start: Instant, n: u64) -> Instant {
        start + Duration::from_secs(n)
    }

    #[test]
    fn the_wal_stamp_moves_for_any_commit_and_rests_when_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let mut store = Store::open(&path).unwrap();
        let wal = WalStamp::wal_path(&path);
        let mut stamp = WalStamp::default();
        assert!(stamp.moved(&wal), "the first look reads the version");
        assert!(!stamp.moved(&wal));

        store.put_note(&note("own"), &[]).unwrap();
        assert!(stamp.moved(&wal));
        assert!(!stamp.moved(&wal));

        let outside = Connection::open(&path).unwrap();
        outside.execute(OUTSIDE_NOTE, []).unwrap();
        assert!(stamp.moved(&wal));
        assert!(!stamp.moved(&wal));

        store.checkpoint_passive().unwrap();
        assert!(!stamp.moved(&wal), "an idle checkpoint is not a commit");
        outside
            .execute("UPDATE notes SET title = 'again' WHERE id = 'mcp'", [])
            .unwrap();
        assert!(
            stamp.moved(&wal),
            "an outside commit into a restarted log keeps the file size and is still seen"
        );
        assert!(!stamp.moved(&wal));
    }

    #[test]
    fn a_wal_file_made_again_counts_as_moved_even_with_the_same_size_and_time() {
        let dir = tempfile::tempdir().unwrap();
        let wal = dir.path().join("plain-wal");
        std::fs::write(&wal, b"frames").unwrap();
        let mut stamp = WalStamp::default();
        assert!(stamp.moved(&wal));
        let modified = std::fs::metadata(&wal).unwrap().modified().unwrap();

        let again = dir.path().join("plain-wal-again");
        std::fs::write(&again, b"frames").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&again)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        std::fs::rename(&again, &wal).unwrap();
        assert_eq!(
            std::fs::metadata(&wal).unwrap().modified().unwrap(),
            modified
        );
        assert!(stamp.moved(&wal));
    }

    #[test]
    fn a_failed_read_is_tried_again_the_next_second_even_when_nothing_moved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let store = Store::open(&path).unwrap();
        let wal = WalStamp::wal_path(&path);
        let start = Instant::now();
        let mut poll = Poll::default();
        assert!(
            !poll.look(&wal, start, || store.data_version()),
            "the baseline"
        );

        Connection::open(&path)
            .unwrap()
            .execute(OUTSIDE_NOTE, [])
            .unwrap();
        let later = second(start, 2 * VISIBLE_WITHIN.as_secs());
        assert!(!poll.look(&wal, later, || Err(StorageError::Refused("E_TEST_READ"))));
        assert!(
            poll.look(&wal, later + EVERY, || store.data_version()),
            "the read that failed is tried again"
        );
        assert!(!poll.look(&wal, later + 2 * EVERY, || store.data_version()));
    }

    // A commit writes and syncs its frames before the two copies of the wal-index header that make it visible:
    // putting the old copies back reproduces a look that lands between the two.
    // The test writes `-shm` itself, which drops SQLite's locks on it, so it keeps to its own database.
    fn seen_once_visible(next_look: Duration) -> bool {
        use std::os::unix::fs::FileExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let store = Store::open(&path).unwrap();
        let wal = WalStamp::wal_path(&path);
        let mut shm_name = path.as_os_str().to_owned();
        shm_name.push("-shm");
        let shm = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(PathBuf::from(shm_name))
            .unwrap();
        // Both 48-byte copies of the header (https://sqlite.org/walformat.html).
        let header = || {
            let mut bytes = [0u8; 96];
            shm.read_exact_at(&mut bytes, 0).unwrap();
            bytes
        };
        let start = Instant::now();
        let mut poll = Poll::default();
        assert!(
            !poll.look(&wal, start, || store.data_version()),
            "the baseline"
        );
        let before = store.data_version().unwrap();
        let hidden = header();

        let outside = Connection::open(&path).unwrap();
        outside.execute(OUTSIDE_NOTE, []).unwrap();
        let visible = header();
        shm.write_all_at(&hidden, 0).unwrap();
        assert_eq!(
            store.data_version().unwrap(),
            before,
            "the commit is not visible yet"
        );
        let moved = second(start, 2 * VISIBLE_WITHIN.as_secs());
        assert!(!poll.look(&wal, moved, || store.data_version()));

        shm.write_all_at(&visible, 0).unwrap();
        let seen = poll.look(&wal, moved + next_look, || store.data_version());
        assert!(!poll.look(&wal, moved + next_look + EVERY, || {
            panic!("the chase has ended, so the version is not read again")
        }));
        drop(outside);
        seen
    }

    #[test]
    fn a_commit_seen_in_the_wal_before_it_became_visible_is_still_picked_up() {
        assert!(seen_once_visible(EVERY));
    }

    #[test]
    fn a_look_held_up_past_the_bound_still_picks_up_a_commit_that_became_visible() {
        assert!(seen_once_visible(VISIBLE_WITHIN + EVERY));
    }

    #[test]
    fn a_commit_made_while_the_first_read_failed_is_still_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let store = Store::open(&path).unwrap();
        let wal = WalStamp::wal_path(&path);
        let start = Instant::now();
        let mut poll = Poll::default();
        assert!(!poll.look(&wal, start, || Err(StorageError::Refused("E_TEST_READ"))));

        Connection::open(&path)
            .unwrap()
            .execute(OUTSIDE_NOTE, [])
            .unwrap();
        assert!(
            poll.look(&wal, start + EVERY, || store.data_version()),
            "with no baseline to compare against, the first reading counts as a change"
        );
        assert!(!poll.look(&wal, start + 2 * EVERY, || store.data_version()));
    }

    #[test]
    fn after_a_move_the_version_is_read_only_until_the_bound() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let mut store = Store::open(&path).unwrap();
        let wal = WalStamp::wal_path(&path);
        let start = Instant::now();
        let mut poll = Poll::default();
        assert!(
            !poll.look(&wal, start, || store.data_version()),
            "the baseline"
        );

        let saved = second(start, 2 * VISIBLE_WITHIN.as_secs());
        store.put_note(&note("own"), &[]).unwrap();
        let mut reads = 0;
        let mut read = || {
            reads += 1;
            store.data_version()
        };
        assert!(!poll.look(&wal, saved, &mut read));
        assert!(!poll.look(&wal, saved + VISIBLE_WITHIN, &mut read));
        assert!(!poll.look(&wal, saved + VISIBLE_WITHIN + EVERY, &mut read));
        assert!(!poll.look(&wal, saved + VISIBLE_WITHIN + 2 * EVERY, &mut read));
        assert_eq!(
            reads, 3,
            "the app's own save is read for the bound and once after it, then no more"
        );
    }

    // SQLite's locks are POSIX fcntl locks, which a close of any descriptor of the file drops for the whole process.
    #[test]
    fn a_look_leaves_another_process_locked_out_while_the_app_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let store = Store::open(&path).unwrap();
        let app = Connection::open(&path).unwrap();
        app.execute_batch(
            "BEGIN IMMEDIATE;
             INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
             VALUES ('app', 'From the app', 'h', '', x'00', 1, 1);",
        )
        .unwrap();
        let locked_out = || {
            let output = std::process::Command::new("sqlite3")
                .arg(&path)
                .arg(format!("{OUTSIDE_NOTE};"))
                .output()
                .unwrap();
            !output.status.success()
                && String::from_utf8_lossy(&output.stderr).contains("database is locked")
        };
        assert!(locked_out(), "the app holds the write lock");

        let mut poll = Poll::default();
        poll.look(&WalStamp::wal_path(&path), Instant::now(), || {
            store.data_version()
        });
        assert!(locked_out(), "a look leaves SQLite's locks in place");
        app.execute_batch("COMMIT").unwrap();
    }

    #[test]
    fn the_first_reading_is_the_baseline() {
        let mut watch = ChangeWatch::default();
        assert!(!watch.changed(7));
        assert!(!watch.changed(7));
        assert!(watch.changed(8));
        assert!(!watch.changed(8));
    }

    fn note(id: &str) -> NoteRecord {
        NoteRecord {
            id: id.into(),
            title: id.into(),
            title_hlc: "0000000000000001-0000-a".into(),
            body_md: String::new(),
            ydoc: vec![0],
            body_version: 0,
            book_id: None,
            book_hlc: String::new(),
            status: "none".into(),
            status_hlc: String::new(),
            pinned: false,
            pinned_hlc: String::new(),
            created_at: 1,
            updated_at: 1,
            dates_hlc: String::new(),
            deleted_at: None,
            deleted_hlc: None,
        }
    }

    #[test]
    fn notices_a_commit_from_another_connection_but_not_the_apps_own() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let mut store = Store::open(&path).unwrap();
        let mut watch = ChangeWatch::default();
        assert!(!watch.changed(store.data_version().unwrap()));

        store.put_note(&note("own"), &[]).unwrap();
        assert!(!watch.changed(store.data_version().unwrap()));

        let outside = Connection::open(&path).unwrap();
        outside
            .execute(
                "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
                 VALUES ('mcp', 'From outside', 'h', '', x'00', 1, 1)",
                [],
            )
            .unwrap();
        assert!(watch.changed(store.data_version().unwrap()));
        assert!(!watch.changed(store.data_version().unwrap()));
    }
}
