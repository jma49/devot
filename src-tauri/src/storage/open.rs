use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::path::Path;

use super::search::register_fold;
use super::{Result, StorageError, Store};

/// Numbered migrations, applied in order. Never edit a released one.
pub(super) const MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/0001_notes.sql"),
    include_str!("../../migrations/0002_books.sql"),
    include_str!("../../migrations/0003_tags_status_pin.sql"),
    include_str!("../../migrations/0004_purge.sql"),
    include_str!("../../migrations/0005_search.sql"),
    include_str!("../../migrations/0006_files.sql"),
    include_str!("../../migrations/0007_links.sql"),
    include_str!("../../migrations/0008_ai_access.sql"),
    include_str!("../../migrations/0009_revisions.sql"),
    include_str!("../../migrations/0010_book_order.sql"),
    include_str!("../../migrations/0011_tag_colours.sql"),
    include_str!("../../migrations/0012_activity.sql"),
    include_str!("../../migrations/0013_compaction.sql"),
    include_str!("../../migrations/0014_list_indexes.sql"),
    include_str!("../../migrations/0015_search_index_writes.sql"),
    include_str!("../../migrations/0016_body_versions.sql"),
    include_str!("../../migrations/0017_note_dates.sql"),
    include_str!("../../migrations/0018_book_icons.sql"),
    include_str!("../../migrations/0019_sync.sql"),
    include_str!("../../migrations/0020_agent_writes.sql"),
    include_str!("../../migrations/0021_agent_writes_unseen.sql"),
    include_str!("../../migrations/0022_sync_files.sql"),
    include_str!("../../migrations/0023_list_body_version.sql"),
    include_str!("../../migrations/0024_revision_words.sql"),
    include_str!("../../migrations/0025_saved_searches.sql"),
    include_str!("../../migrations/0026_sync_change_tags.sql"),
    include_str!("../../migrations/0027_sync_pushed_counts_as_synced.sql"),
];

pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

/// How long a copy waits out another connection's lock; the database thread does nothing else
/// meanwhile.
const COPY_PATIENCE: std::time::Duration = std::time::Duration::from_secs(10);

/// One step reads a consistent snapshot; in WAL mode writers on other connections carry on
/// meanwhile. Busy (E_STORAGE_BUSY) once a lock outlasts `patience`.
pub(super) fn copy_pages(
    from: &Connection,
    to: &mut Connection,
    patience: std::time::Duration,
) -> Result<()> {
    let backup = Backup::new(from, to)?;
    let started = std::time::Instant::now();
    loop {
        match backup.step(-1)? {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            _ if started.elapsed() >= patience => {
                return Err(StorageError::Sqlite(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                    None,
                )));
            }
            _ => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

/// Refused (E_BACKUP_DAMAGED) when the backup fails `quick_check`, or SQLite finds it damaged
/// while checking it.
fn check_backup_intact(backup: &Connection) -> Result<()> {
    use rusqlite::ErrorCode;
    const DAMAGED: StorageError = StorageError::Refused("E_BACKUP_DAMAGED");
    match backup.pragma_query_value(None, "quick_check", |row| row.get::<_, String>(0)) {
        Ok(check) if check == "ok" => Ok(()),
        Ok(_) => Err(DAMAGED),
        Err(error)
            if matches!(
                error.sqlite_error_code(),
                Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
            ) =>
        {
            Err(DAMAGED)
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

pub fn snapshot(db_path: &Path, dest: &Path) -> Result<()> {
    let source = open_read_only(db_path)?;
    let mut copy = Connection::open(dest)?;
    copy_pages(&source, &mut copy, COPY_PATIENCE)?;
    // The copy inherits WAL mode; a rollback journal keeps it one file, so
    // reading it later leaves no -wal or -shm beside it.
    copy.pragma_update(None, "journal_mode", "DELETE")?;
    let check: String = copy.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if check != "ok" {
        return Err(StorageError::SnapshotCheckFailed);
    }
    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        register_fold(&conn)?;
        // WAL lets an outside writer read while Devot writes; FULL sync because data
        // integrity outranks write speed.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Deleted text is overwritten, overflow pages too (ON, not FAST): a purged note leaves
        // nothing readable in free pages, which every later backup would copy.
        conn.pragma_update(None, "secure_delete", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // Every transaction takes the write lock when it begins, so it waits
        // out another writer (an outside writer) for the busy timeout. A deferred one
        // that has read (an attachment's note, the search index on its first
        // use) would fail at once when it then needs to write.
        conn.set_transaction_behavior(TransactionBehavior::Immediate);
        let mut store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<()> {
        let current: u32 = self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(StorageError::NewerSchema(current));
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", index as u32 + 1)?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn restore_from(&mut self, path: &Path) -> Result<()> {
        let source = open_read_only(path)?;
        check_backup_intact(&source)?;
        let version: u32 = source.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StorageError::NewerSchema(version));
        }
        copy_pages(&source, &mut self.conn, COPY_PATIENCE)?;
        self.conn.pragma_update(None, "journal_mode", "WAL")?;
        self.migrate()
    }

    /// Changes whenever another connection (an outside writer, say) commits; this connection's own commits
    /// leave it alone.
    pub fn data_version(&self) -> Result<u32> {
        Ok(self
            .conn
            .pragma_query_value(None, "data_version", |row| row.get(0))?)
    }

    #[cfg(test)]
    pub fn schema_version(&self) -> Result<u32> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    #[cfg(test)]
    pub fn integrity_ok(&self) -> Result<bool> {
        let result: String = self
            .conn
            .pragma_query_value(None, "integrity_check", |row| row.get(0))?;
        Ok(result == "ok")
    }
}
