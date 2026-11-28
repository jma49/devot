use rusqlite::{OptionalExtension, params};

use super::{Db, FileCopy, FileRecord, Result, Store, Write, valid_note_id};

pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
pub(crate) const MAX_FILE_NAME_CHARS: usize = 200;

pub fn detect_image(bytes: &[u8]) -> Option<&'static str> {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    if starts(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if starts(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"avif" | b"avis" => Some("image/avif"),
            b"heic" | b"heix" | b"mif1" | b"msf1" => Some("image/heic"),
            _ => None,
        };
    }
    None
}

pub struct Upload {
    pub id: String,
    pub note_id: String,
    pub name: String,
}

pub fn validate_upload(
    upload: &Upload,
    data: &[u8],
) -> std::result::Result<&'static str, &'static str> {
    if !valid_note_id(&upload.id) {
        return Err("E_FILE_ID_INVALID");
    }
    if !valid_note_id(&upload.note_id) {
        return Err("E_NOTE_ID_INVALID");
    }
    if upload.name.is_empty()
        || upload.name.chars().count() > MAX_FILE_NAME_CHARS
        || upload.name.chars().any(char::is_control)
    {
        return Err("E_FILE_NAME_INVALID");
    }
    if data.is_empty() || data.len() > MAX_FILE_BYTES {
        return Err("E_FILE_SIZE_INVALID");
    }
    detect_image(data).ok_or("E_FILE_TYPE_REFUSED")
}

pub async fn store_upload(
    db: &Db,
    upload: Upload,
    data: Vec<u8>,
) -> std::result::Result<(), String> {
    let mime = validate_upload(&upload, &data).map_err(String::from)?;
    let file = FileRecord {
        id: upload.id,
        note_id: upload.note_id,
        name: upload.name,
        mime: mime.into(),
        data,
        created_at: crate::logs::now_ms(),
    };
    let stored = db
        .write(Write::Content, move |store| store.put_file(&file))
        .await
        .map_err(|e| e.to_string())?;
    if stored {
        Ok(())
    } else {
        Err("E_NOTE_NOT_FOUND".into())
    }
}

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
