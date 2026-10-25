//! The Rebuild Search Index command (Help menu and command palette). The
//! rebuild is one FTS5 statement on the database thread, so saves and reads
//! queue behind it for its duration; only one runs at a time. A quit stops it
//! (its transaction rolls back), so the saves queued behind it run before the
//! app exits.

use crate::storage::{Db, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::{AppHandle, State};

static RUNNING: AtomicBool = AtomicBool::new(false);

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

#[tauri::command]
pub async fn search_index_rebuild(app: AppHandle, db: State<'_, Db>) -> Result<u32, String> {
    let Some(_running) = Running::begin(&RUNNING) else {
        return Err("E_SEARCH_REBUILD_BUSY".into());
    };
    rebuild(&db, move || crate::exit::quitting(&app)).await
}

pub(crate) async fn rebuild(
    db: &Db,
    stop: impl FnMut() -> bool + Send + 'static,
) -> Result<u32, String> {
    let started = Instant::now();
    let notes = db
        .write(Write::Bookkeeping, move |store| {
            store.rebuild_search_index(stop)
        })
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
