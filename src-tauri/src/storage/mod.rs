//! SQLite storage. The core library owns note logic (Yjs, HLC, last-writer-
//! wins); this layer stores and returns whole records.

mod activity;
mod agent_writes;
mod books;
mod db;
mod files;
mod notes;
mod open;
mod purge;
mod readable;
mod records;
mod revisions;
mod saved_searches;
mod search;
mod sync;
mod tags;
mod welcome;

pub use sync::{SYNC_KINDS, SyncEntry, SyncFile, SyncFileWrite, SyncLocal, SyncPending};

pub use db::{Db, Write};
pub use open::{SCHEMA_VERSION, snapshot};
pub use records::*;
pub use welcome::WelcomeNote;

use rusqlite::Connection;

#[derive(Debug)]
pub enum StorageError {
    Sqlite(rusqlite::Error),
    NewerSchema(u32),
    SnapshotCheckFailed,
    /// Another process wrote the note since its writer read it.
    BodyStale,
    /// The note was deleted for good: nothing is written, and its writer is told.
    Purged,
    RebuildStopped,
    /// A code the call was refused with: the write gate's (`Db::guard`), or the database thread's.
    Refused(&'static str),
}

/// Never SQLite's message, which can quote a statement or the data it was given.
fn sqlite_code(error: &rusqlite::Error) -> &'static str {
    use rusqlite::ErrorCode;
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "E_STORAGE_BUSY",
        Some(ErrorCode::DiskFull) => "E_STORAGE_FULL",
        Some(ErrorCode::ReadOnly) => "E_STORAGE_READONLY",
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => "E_STORAGE_CORRUPT",
        Some(ErrorCode::SystemIoFailure) => "E_STORAGE_IO",
        Some(ErrorCode::CannotOpen) => "E_STORAGE_CANTOPEN",
        _ => "E_STORAGE_SQLITE",
    }
}

impl StorageError {
    /// The code alone, without the schema version `Display` adds.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Sqlite(error) => sqlite_code(error),
            Self::NewerSchema(_) => "E_STORAGE_SCHEMA_TOO_NEW",
            Self::SnapshotCheckFailed => "E_STORAGE_SNAPSHOT_CHECK_FAILED",
            Self::BodyStale => "E_NOTE_BODY_STALE",
            Self::Purged => "E_NOTE_PURGED",
            Self::RebuildStopped => "E_SEARCH_REBUILD_STOPPED",
            Self::Refused(code) => code,
        }
    }
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NewerSchema(found) => write!(f, "{} v{found}", self.code()),
            _ => f.write_str(self.code()),
        }
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::NewerSchema(_)
            | Self::SnapshotCheckFailed
            | Self::BodyStale
            | Self::Purged
            | Self::RebuildStopped
            | Self::Refused(_) => None,
        }
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;

pub struct Store {
    conn: Connection,
}

#[cfg(test)]
mod tests;
