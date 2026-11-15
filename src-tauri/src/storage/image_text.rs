//! The text in the images notes hold (schema v30), read on this device by `image_text`'s worker.
//! The worker hashes each image off the database thread and asks here only whether that hash was
//! read before, so one image is read once in any number of notes.

use rusqlite::{OptionalExtension, params};

use super::{Result, Store};

pub struct UnreadImage {
    pub file_id: String,
    pub data: Vec<u8>,
}

impl Store {
    /// Notes whose images changed since their text was last written, oldest first.
    pub fn stale_image_notes(&self, limit: usize) -> Result<Vec<i64>> {
        let mut statement = self
            .conn
            .prepare_cached("SELECT rowid FROM image_text_stale ORDER BY rowid LIMIT ?1")?;
        let rows = statement.query_map([limit as i64], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One image of the note that has no hash yet, in the order added.
    pub fn unhashed_image(&self, note: i64) -> Result<Option<UnreadImage>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT f.id, f.data FROM notes n
                   JOIN files f ON f.note_id = n.id AND f.mime LIKE 'image/%'
                  WHERE n.rowid = ?1
                    AND NOT EXISTS (SELECT 1 FROM file_hashes h WHERE h.file_id = f.id)
                  ORDER BY f.created_at, f.id LIMIT 1",
            )?
            .query_row([note], |row| {
                Ok(UnreadImage {
                    file_id: row.get(0)?,
                    data: row.get(1)?,
                })
            })
            .optional()?)
    }

    pub fn has_image_text(&self, hash: &[u8]) -> Result<bool> {
        Ok(self
            .conn
            .prepare_cached("SELECT EXISTS (SELECT 1 FROM image_text WHERE hash = ?1)")?
            .query_row([hash], |row| row.get(0))?)
    }

    pub fn put_image_text(&self, hash: &[u8], text: &str) -> Result<()> {
        self.conn
            .prepare_cached("INSERT OR IGNORE INTO image_text (hash, text) VALUES (?1, ?2)")?
            .execute(params![hash, text])?;
        Ok(())
    }

    /// Kept only while the file is: one deleted while it was read leaves nothing behind.
    pub fn put_file_hash(&self, file_id: &str, hash: &[u8]) -> Result<()> {
        self.conn
            .prepare_cached(
                "INSERT OR REPLACE INTO file_hashes (file_id, hash)
                 SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM files WHERE id = ?1)",
            )?
            .execute(params![file_id, hash])?;
        Ok(())
    }

    /// Writes the note's row from the text of its hashed images and takes it off the stale list.
    /// An image not read yet keeps the note stale, so its text joins on a later pass.
    pub fn refresh_image_text(&mut self, note: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        let text: String = tx.query_row(
            "SELECT coalesce(group_concat(t.text, char(10) ORDER BY f.created_at, f.id), '')
               FROM notes n
               JOIN files f ON f.note_id = n.id AND f.mime LIKE 'image/%'
               JOIN file_hashes h ON h.file_id = f.id
               JOIN image_text t ON t.hash = h.hash
              WHERE n.rowid = ?1 AND n.purged_at IS NULL AND t.text <> ''",
            [note],
            |row| row.get(0),
        )?;
        let held: Option<String> = tx
            .query_row(
                "SELECT text FROM note_image_text WHERE rowid = ?1",
                [note],
                |row| row.get(0),
            )
            .optional()?;
        if held.as_deref() != Some(text.as_str()).filter(|t| !t.is_empty()) {
            tx.execute("DELETE FROM note_image_text WHERE rowid = ?1", [note])?;
            if !text.is_empty() {
                let version: i64 = tx.query_row(
                    "UPDATE image_text_version SET last = last + 1 RETURNING last",
                    [],
                    |row| row.get(0),
                )?;
                tx.execute(
                    "INSERT INTO note_image_text (rowid, text, version) VALUES (?1, ?2, ?3)",
                    params![note, text, version],
                )?;
            }
        }
        let unread: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM notes n
               JOIN files f ON f.note_id = n.id AND f.mime LIKE 'image/%'
              WHERE n.rowid = ?1
                AND NOT EXISTS (SELECT 1 FROM file_hashes h WHERE h.file_id = f.id))",
            [note],
            |row| row.get(0),
        )?;
        if !unread {
            tx.execute("DELETE FROM image_text_stale WHERE rowid = ?1", [note])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The version of each live note's image text, for the notes whose images hold some.
    pub fn image_text_versions(&self) -> Result<Vec<(String, i64)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT n.id, i.version FROM note_image_text i JOIN notes n ON n.rowid = i.rowid
              WHERE n.deleted_at IS NULL AND n.purged_at IS NULL",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The text in each note's images and its version, for the notes among `ids` whose images
    /// hold some, in the order of `ids`.
    pub fn image_texts(&self, ids: &[String]) -> Result<Vec<(String, String, i64)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT n.id, i.text, i.version FROM json_each(?1) j
               JOIN notes n ON n.id = j.value
               JOIN note_image_text i ON i.rowid = n.rowid
              ORDER BY j.key",
        )?;
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let rows = statement.query_map([ids], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
#[path = "image_text_tests.rs"]
mod tests;
