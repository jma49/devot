//! Outside changes: devot-mcp (or anything else) writing to the database
//! while Devot runs. A thread asks SQLite every `EVERY` whether another
//! connection has committed (`PRAGMA data_version` on the app's own
//! connection, which ignores the app's own writes) and tells the window,
//! which merges the changes into the notes it holds and reloads its lists.

use crate::storage::Db;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const CHANGED_EVENT: &str = "devot://db-changed";
const EVERY: Duration = Duration::from_secs(1);

/// Remembers the last `data_version` seen; the first reading is the baseline.
#[derive(Debug, Default)]
pub struct ChangeWatch {
    last: Option<u32>,
}

impl ChangeWatch {
    /// Takes a new reading; true when it differs from the one before.
    pub fn changed(&mut self, version: u32) -> bool {
        let changed = self.last.is_some_and(|last| last != version);
        self.last = Some(version);
        changed
    }
}

/// Polls for outside changes for the life of the app.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("devot-watch".into())
        .spawn(move || {
            let mut watch = ChangeWatch::default();
            let mut failing = false;
            loop {
                let db = app.state::<Db>().inner().clone();
                let read = db.call_quietly(|store| store.data_version());
                match tauri::async_runtime::block_on(read) {
                    Ok(version) => {
                        failing = false;
                        if watch.changed(version) && app.emit_to("main", CHANGED_EVENT, ()).is_err()
                        {
                            log::warn!("W_WATCH_EVENT_FAILED");
                        }
                    }
                    // Logged once per run of failures, not every second.
                    Err(error) if !failing => {
                        failing = true;
                        log::warn!("W_WATCH_READ_FAILED {error}");
                    }
                    Err(_) => {}
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
    use crate::storage::{NoteRecord, Store};
    use rusqlite::Connection;

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
                 VALUES ('mcp', 'From devot-mcp', 'h', '', x'00', 1, 1)",
                [],
            )
            .unwrap();
        assert!(watch.changed(store.data_version().unwrap()));
        assert!(!watch.changed(store.data_version().unwrap()));
    }
}
