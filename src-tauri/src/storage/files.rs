use rusqlite::{OptionalExtension, params};

use super::{FileCopy, FileRecord, Result, Store};

impl Store {
    /// Returns false (and stores nothing) when the note does not exist or is in the trash.
    pub fn put_file(&mut self, file: &FileRecord) -> Result<bool> {
        let tx = self.conn.transaction()?;
        let live: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL)",
            [&file.note_id],
            |row| row.get(0),
        )?;
        if live {
            tx.execute(
                "INSERT INTO files (id, note_id, name, mime, size, data, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    file.id,
                    file.note_id,
                    file.name,
                    file.mime,
                    file.data.len() as i64,
                    file.data,
                    file.created_at
                ],
            )?;
        }
        tx.commit()?;
        Ok(live)
    }

    /// A file that does not exist is skipped. Returns false (and copies nothing) when the note does
    /// not exist or is in the trash. The TypeScript adapter (tests/support/sqlite-adapter.ts) runs the same
    /// statement.
    pub fn copy_files(&mut self, note_id: &str, copies: &[FileCopy], at: i64) -> Result<bool> {
        let tx = self.conn.transaction()?;
        let live: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL)",
            [note_id],
            |row| row.get(0),
        )?;
        if live {
            let mut copy = tx.prepare_cached(
                "INSERT INTO files (id, note_id, name, mime, size, data, created_at)
                 SELECT ?2, ?1, name, mime, size, data, ?4 FROM files WHERE id = ?3",
            )?;
            for FileCopy { from, to } in copies {
                copy.execute(params![note_id, to, from, at])?;
            }
        }
        tx.commit()?;
        Ok(live)
    }

    pub fn file_names(&self, ids: &[String]) -> Result<Vec<(String, String, String)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, name, mime FROM files WHERE id IN (SELECT value FROM json_each(?1))",
        )?;
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let rows = statement.query_map([ids], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// None once the attachment was deleted with its note (see `purge_note`).
    pub fn get_file(&self, id: &str) -> Result<Option<FileRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, note_id, name, mime, data, created_at FROM files WHERE id = ?1",
        )?;
        Ok(statement
            .query_row([id], |row| {
                Ok(FileRecord {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    name: row.get(2)?,
                    mime: row.get(3)?,
                    data: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .optional()?)
    }
}
