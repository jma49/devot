//! The Rebuild Search Index command (Help menu and command palette). The
//! rebuild is one FTS5 statement on the database thread, so saves and reads
//! queue behind it for its duration; only one runs at a time.

use crate::storage::Db;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::State;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Holds the right to rebuild; releases it when dropped, however the
/// rebuild ends.
struct Running<'a>(&'a AtomicBool);

impl<'a> Running<'a> {
    fn begin(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag))
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Rebuilds the search index and returns how many notes it covers.
#[tauri::command]
pub async fn search_index_rebuild(db: State<'_, Db>) -> Result<u32, String> {
    let Some(_running) = Running::begin(&RUNNING) else {
        return Err("E_SEARCH_REBUILD_BUSY".into());
    };
    let started = Instant::now();
    let notes = db
        .call(|store| store.rebuild_search_index())
        .await
        .map_err(|e| e.to_string())?;
    log::info!(
        "I_SEARCH_REBUILT notes={notes} ms={}",
        started.elapsed().as_millis()
    );
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_rebuild_runs_at_a_time() {
        let flag = AtomicBool::new(false);
        let first = Running::begin(&flag);
        assert!(first.is_some());
        assert!(Running::begin(&flag).is_none(), "BUSY while one runs");
        drop(first);
        assert!(Running::begin(&flag).is_some(), "free again once it ends");
    }
}
