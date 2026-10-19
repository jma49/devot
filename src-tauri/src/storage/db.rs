//! A dedicated database thread. Every storage call runs there, so SQLite
//! never blocks the UI thread or Tauri's async runtime.

use super::{Result, Store};
use std::path::Path;
use std::sync::mpsc;
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce(&mut Store) + Send>;

#[derive(Clone)]
pub struct Db {
    jobs: mpsc::Sender<Job>,
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
        Ok(Self { jobs })
    }

    pub async fn call<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        let result = self.call_quietly(work).await;
        if let Err(error) = &result {
            log::warn!("W_STORAGE_FAILED {error}");
        }
        result
    }

    /// For a caller that logs a run of failures once itself (the change watch), so a lasting failure does not fill the log.
    pub async fn call_quietly<T, F>(&self, work: F) -> Result<T>
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::StorageError;
    use crate::test_log;

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
