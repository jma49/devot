//! A dedicated database thread. Every storage call runs there, so SQLite
//! never blocks the UI thread or Tauri's async runtime.
//! Reads get the store shared (`call`); a write needs it exclusively, which only `write` and
//! `write_judged` hand out, after the gate a build that checks licences sets (`guard`) let it through.

use super::{Result, StorageError, Store};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce(&mut Store) + Send>;

/// How long writes stay quiet before the thread re-indexes the notes saves left stale.
const SEARCH_QUIET: Duration = Duration::from_secs(5);
/// Writes that never pause (sync, say) delay it no longer than this.
const SEARCH_LATEST: Duration = Duration::from_secs(60);
/// One catch-up's share of the thread before queued jobs run (a single note may take longer).
const SEARCH_BUDGET: Duration = Duration::from_millis(50);

/// When the thread next re-indexes the notes writes may have left stale.
struct CatchUp {
    quiet: Duration,
    first: Option<Instant>,
    due: Option<Instant>,
}

impl CatchUp {
    fn wrote(&mut self, now: Instant) {
        let first = *self.first.get_or_insert(now);
        self.due = Some((now + self.quiet).min(first + SEARCH_LATEST));
    }

    fn run(&mut self, store: &Store) {
        match store.catch_up_search_index(Some(SEARCH_BUDGET)) {
            Ok(true) => self.due = Some(Instant::now()),
            Ok(false) => (self.first, self.due) = (None, None),
            Err(error) => {
                log::warn!("W_SEARCH_CATCH_UP_FAILED {error}");
                (self.first, self.due) = (None, Some(Instant::now() + SEARCH_LATEST));
            }
        }
    }
}

fn serve(store: &mut Store, inbox: &mpsc::Receiver<Job>, quiet: Duration) {
    let mut catch_up = CatchUp {
        quiet,
        first: None,
        due: None,
    };
    // A run before this one may have left notes stale.
    catch_up.wrote(Instant::now());
    loop {
        let job = match catch_up.due {
            Some(due) => match inbox.recv_timeout(due.saturating_duration_since(Instant::now())) {
                Ok(job) => job,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    catch_up.run(store);
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            },
            None => match inbox.recv() {
                Ok(job) => job,
                Err(_) => return,
            },
        };
        let changes = store.conn.total_changes();
        // A job that panics drops its reply, so its caller gets a code, and the
        // thread lives on for the next one (a Transaction rolls back as it unwinds).
        if catch_unwind(AssertUnwindSafe(|| job(store))).is_err() {
            log::error!("E_DB_JOB_PANIC");
        }
        if store.conn.total_changes() != changes {
            catch_up.wrote(Instant::now());
        }
    }
}

/// What a write changes, for the gate to judge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Write {
    /// A note already stored, as typed, or its history: what a save in flight carries.
    Body,
    /// Any other user content: a note's first save, notebooks, tags, attachments, the trash,
    /// imports, a restore.
    Content,
    /// What holds no user content: sync's own state, the search index.
    Bookkeeping,
    /// The first-launch notes this build bundles, into a library that has never held them
    /// (`commands::welcome`): written whatever the licence, so a new library is never empty.
    Welcome,
}

pub type WriteGate = Arc<dyn Fn(Write) -> std::result::Result<(), &'static str> + Send + Sync>;

#[derive(Clone)]
pub struct Db {
    jobs: mpsc::Sender<Job>,
    gate: Arc<OnceLock<WriteGate>>,
}

impl Db {
    pub fn spawn(path: &Path) -> Result<Self> {
        Self::spawn_quiet_after(path, SEARCH_QUIET)
    }

    pub(crate) fn spawn_quiet_after(path: &Path, quiet: Duration) -> Result<Self> {
        let path = path.to_owned();
        let (jobs, inbox) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("devot-db".into())
            .spawn(move || match Store::open(&path) {
                Ok(mut store) => {
                    let _ = ready_tx.send(Ok(()));
                    serve(&mut store, &inbox, quiet);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .expect("E_DB_THREAD_SPAWN");
        ready_rx.recv().expect("E_DB_THREAD_GONE")?;
        Ok(Self {
            jobs,
            gate: Arc::default(),
        })
    }

    /// Set once, at launch; writes before it are not judged.
    pub fn guard(&self, gate: WriteGate) {
        if self.gate.set(gate).is_err() {
            log::warn!("W_STORAGE_GATE_SET_TWICE");
        }
    }

    pub async fn call<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Store) -> Result<T> + Send + 'static,
    {
        logged(self.run(move |store| work(store)).await)
    }

    /// Refused with the gate's code, before it reaches the database thread.
    pub async fn write<T, F>(&self, what: Write, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        if let Some(gate) = self.gate.get() {
            gate(what).map_err(StorageError::Refused)?;
        }
        logged(self.run(work).await)
    }

    /// For a write whose kind depends on what is stored: the gate answers for each of `kinds`
    /// here, off the database thread, since it may wait on the keychain; `judge` then reads the
    /// store in the same job as `work`, so no other write comes between them, and the answer for
    /// its kind decides. A refusal, or a kind not in `kinds`, changes nothing.
    pub async fn write_judged<T, J, F>(&self, kinds: &[Write], judge: J, work: F) -> Result<T>
    where
        T: Send + 'static,
        J: FnOnce(&Store) -> Result<Write> + Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        let answers: Vec<_> = kinds
            .iter()
            .map(|&what| (what, self.gate.get().map_or(Ok(()), |gate| gate(what))))
            .collect();
        let done = self
            .run(move |store| {
                let what = judge(store)?;
                match answers.into_iter().find(|(kind, _)| *kind == what) {
                    Some((_, Ok(()))) => work(store).map(Ok),
                    Some((_, Err(code))) => Ok(Err(code)),
                    None => Ok(Err("E_STORAGE_WRITE_UNJUDGED")),
                }
            })
            .await;
        logged(done)?.map_err(StorageError::Refused)
    }

    /// For a caller that logs a run of failures once itself (the change watch), so a lasting failure does not fill the log.
    pub async fn call_quietly<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Store) -> Result<T> + Send + 'static,
    {
        self.run(move |store| work(store)).await
    }

    async fn run<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        let (reply, answer) = oneshot::channel();
        let job: Job = Box::new(move |store| {
            let _ = reply.send(work(store));
        });
        self.jobs
            .send(job)
            .map_err(|_| StorageError::Refused("E_DB_THREAD_GONE"))?;
        answer
            .await
            .map_err(|_| StorageError::Refused("E_DB_JOB_PANIC"))?
    }
}

fn logged<T>(result: Result<T>) -> Result<T> {
    if let Err(error) = &result {
        log::warn!("W_STORAGE_FAILED {error}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{NoteRecord, StorageError};
    use crate::test_log;

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
    fn once_the_trial_is_over_the_gate_refuses_user_content_but_never_a_read() {
        use crate::licence::{Gate, testing};
        use tauri::async_runtime::block_on;
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        block_on(db.write(Write::Content, |store| store.put_note(&note("before"), &[]))).unwrap();
        let licence = testing::licence(dir.path(), true);
        let gate = Gate::of(&licence);
        db.guard(Arc::new(move |what| gate.require_write(what)));
        for what in [Write::Body, Write::Content] {
            let refused = block_on(db.write(what, |store| store.put_note(&note("after"), &[])));
            assert_eq!(refused.unwrap_err().to_string(), "E_LICENCE_REQUIRED");
        }
        block_on(db.write(Write::Bookkeeping, |store| {
            store.sync_set_state("since", "1")
        }))
        .unwrap();
        let ids = |db: &Db| {
            block_on(db.call(|store| store.list_notes()))
                .unwrap()
                .into_iter()
                .map(|n| n.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&db), ["before"]);
        licence.set(&testing::key(testing::ID)).unwrap();
        block_on(db.write(Write::Content, |store| store.put_note(&note("after"), &[]))).unwrap();
        assert_eq!(ids(&db).len(), 2);
    }

    const EITHER: [Write; 2] = [Write::Body, Write::Content];

    fn first_put(id: &'static str) -> impl FnOnce(&Store) -> Result<Write> + Send + 'static {
        move |store| {
            Ok(if store.has_note(id)? {
                Write::Body
            } else {
                Write::Content
            })
        }
    }

    #[test]
    fn a_judged_write_takes_the_answer_for_what_its_own_job_found_stored() {
        use tauri::async_runtime::block_on;
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        db.guard(Arc::new(|what| match what {
            Write::Body => Err("E_LICENCE_REQUIRED"),
            _ => Ok(()),
        }));
        block_on(db.write_judged(&EITHER, first_put("note"), |store| {
            store.put_note(&note("note"), &[])?;
            let mut again = note("note");
            again.body_version = 1;
            store.put_note(&again, &[])
        }))
        .unwrap();
        let mut edited = note("note");
        edited.body_version = 2;
        let refused = block_on(db.write_judged(&EITHER, first_put("note"), move |store| {
            store.put_note(&edited, &[])
        }));
        assert_eq!(refused.unwrap_err().to_string(), "E_LICENCE_REQUIRED");
    }

    #[test]
    fn a_judged_write_asks_the_gate_off_the_database_thread() {
        use std::sync::Mutex;
        use tauri::async_runtime::block_on;
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&asked);
        db.guard(Arc::new(move |what| {
            let thread = std::thread::current().name().map(str::to_owned);
            seen.lock().unwrap().push((what, thread));
            Ok(())
        }));
        block_on(db.write_judged(&EITHER, first_put("note"), |store| {
            store.put_note(&note("note"), &[])
        }))
        .unwrap();
        let asked = asked.lock().unwrap();
        assert_eq!(
            asked.iter().map(|(what, _)| *what).collect::<Vec<_>>(),
            EITHER
        );
        assert!(
            asked
                .iter()
                .all(|(_, thread)| thread.as_deref() != Some("devot-db"))
        );
    }

    #[test]
    fn a_judged_write_whose_kind_was_not_asked_is_refused() {
        use tauri::async_runtime::block_on;
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        db.guard(Arc::new(|_| Ok(())));
        let refused = block_on(db.write_judged(&[Write::Body], first_put("new"), |store| {
            store.put_note(&note("new"), &[])
        }));
        assert_eq!(refused.unwrap_err().to_string(), "E_STORAGE_WRITE_UNJUDGED");
        assert!(
            block_on(db.call(|store| store.list_notes()))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_judged_write_the_gate_refuses_changes_nothing() {
        use tauri::async_runtime::block_on;
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        block_on(db.write(Write::Content, |store| store.put_note(&note("kept"), &[]))).unwrap();
        db.guard(Arc::new(|what| match what {
            Write::Body => Ok(()),
            _ => Err("E_LICENCE_REQUIRED"),
        }));
        let mut kept = note("kept");
        kept.body_version = 1;
        block_on(db.write_judged(&EITHER, first_put("kept"), move |store| {
            store.put_note(&kept, &[])
        }))
        .unwrap();
        let refused = block_on(db.write_judged(&EITHER, first_put("new"), |store| {
            store.put_note(&note("new"), &[])
        }));
        assert_eq!(refused.unwrap_err().to_string(), "E_LICENCE_REQUIRED");
        let notes = block_on(db.call(|store| store.list_notes())).unwrap();
        assert_eq!(
            notes.into_iter().map(|n| n.id).collect::<Vec<_>>(),
            ["kept"]
        );
    }

    #[test]
    fn the_database_thread_catches_the_search_index_up_once_writes_are_quiet() {
        use tauri::async_runtime::block_on;
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn_quiet_after(&dir.path().join("devot.sqlite"), Duration::from_millis(50))
            .unwrap();
        block_on(db.write(Write::Content, |store| store.put_note(&note("a"), &[]))).unwrap();
        let stale = |db: &Db| {
            block_on(db.call(|store| {
                Ok(store
                    .conn
                    .query_row("SELECT count(*) FROM search_stale", [], |row| {
                        row.get::<_, i64>(0)
                    })?)
            }))
            .unwrap()
        };
        let waited = Instant::now();
        while stale(&db) > 0 {
            assert!(
                waited.elapsed() < Duration::from_secs(10),
                "the index never caught up"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_panicking_job_returns_a_code_and_the_next_job_still_runs() {
        use tauri::async_runtime::block_on;
        test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        let failed = block_on(db.write(Write::Content, |store| -> Result<()> {
            store.put_note(&note("before"), &[])?;
            panic!("a job that panics");
        }));
        assert_eq!(failed.unwrap_err().to_string(), "E_DB_JOB_PANIC");
        block_on(db.write(Write::Content, |store| store.put_note(&note("after"), &[]))).unwrap();
        let notes = block_on(db.call(|store| store.list_notes())).unwrap();
        assert_eq!(notes.len(), 2);
        // The caller gets its code as the panic unwinds, before the db thread logs; the
        // thread runs jobs in order, so the line is there once the next job has replied.
        assert!(
            test_log::lines().contains(&"ERROR E_DB_JOB_PANIC".to_string()),
            "{:?}",
            test_log::lines()
        );
    }

    #[test]
    fn a_failed_call_is_logged_with_its_code() {
        test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        // A real SQLite failure on the database thread: a write on a
        // connection that may not write.
        let failed = tauri::async_runtime::block_on(db.call(|_| -> Result<()> {
            let conn = rusqlite::Connection::open_in_memory()?;
            conn.execute_batch("PRAGMA query_only = 1; CREATE TABLE t(x);")?;
            Ok(())
        }));
        assert!(matches!(failed, Err(StorageError::Sqlite(_))));
        let logged = test_log::lines();
        assert!(
            logged.contains(&"WARN W_STORAGE_FAILED E_STORAGE_READONLY".to_string()),
            "{logged:?}"
        );
        // A call that works logs nothing, nor does a quiet one that fails
        // (its caller logs a run of failures once).
        let before = test_log::lines().len();
        tauri::async_runtime::block_on(db.call(|store| store.list_notes())).unwrap();
        let quiet = tauri::async_runtime::block_on(
            db.call_quietly(|_| -> Result<()> { Err(StorageError::SnapshotCheckFailed) }),
        );
        assert!(quiet.is_err());
        let after = test_log::lines();
        assert!(
            !after[before..]
                .iter()
                .any(|line| line.contains("W_STORAGE_FAILED")),
            "{after:?}"
        );
    }
}
