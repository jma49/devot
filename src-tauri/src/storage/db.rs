//! A dedicated database thread. Every storage call runs there, so SQLite
//! never blocks the UI thread or Tauri's async runtime.
//! Reads get the store shared (`call`); a write needs it exclusively, which only `write` hands out,
//! after the gate a build that checks licences sets (`guard`) let it through.

use super::{Result, StorageError, Store};
use std::path::Path;
use std::sync::{Arc, OnceLock, mpsc};
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce(&mut Store) + Send>;

/// What a write changes, for the gate to judge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Write {
    /// A note as typed, or its history: what a save in flight carries.
    Body,
    /// Any other user content: notebooks, tags, attachments, the trash, imports, a restore.
    Content,
    /// What holds no user content: sync's own state, the search index.
    Bookkeeping,
}

pub type WriteGate = Arc<dyn Fn(Write) -> std::result::Result<(), &'static str> + Send + Sync>;

#[derive(Clone)]
pub struct Db {
    jobs: mpsc::Sender<Job>,
    gate: Arc<OnceLock<WriteGate>>,
}

impl Db {
    pub fn spawn(path: &Path) -> Result<Self> {
        let path = path.to_owned();
        let (jobs, inbox) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("devot-db".into())
            .spawn(move || match Store::open(&path) {
                Ok(mut store) => {
                    let _ = ready_tx.send(Ok(()));
                    for job in inbox {
                        job(&mut store);
                    }
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
        self.jobs.send(job).expect("E_DB_THREAD_GONE");
        answer.await.expect("E_DB_THREAD_GONE")
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
