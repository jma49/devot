use rusqlite::params;

use super::{BookRecord, FileRecord, NoteRecord, Result, Store};

/// Matches TEMPLATES_BOOK_ID in src/core/templatesBook.ts: made on demand, it is not the user's.
const TEMPLATES_BOOK_ID: &str = "00000000-0000-7000-8000-000000000001";

pub struct WelcomeNote {
    pub record: NoteRecord,
    pub links: Vec<String>,
}

impl Store {
    /// Writes the first-launch notebook, notes and files in one transaction, only into a library
    /// that has never held anything: no live note outside Templates, nothing in the Trash, no
    /// notebook but Templates (`isEmptyLibrary` in src/core/welcome.ts), and no row with one of
    /// their IDs, however deleted or purged, so they are written once. Answers whether it wrote.
    pub fn seed_welcome(
        &mut self,
        book: &BookRecord,
        notes: &[WelcomeNote],
        files: &[FileRecord],
    ) -> Result<bool> {
        let tx = self.conn.transaction()?;
        let ids = serde_json::to_string(
            &std::iter::once(&book.id)
                .chain(notes.iter().map(|n| &n.record.id))
                .chain(files.iter().map(|f| &f.id))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".into());
        let held: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM notes WHERE purged_at IS NULL
                              AND (deleted_at IS NOT NULL OR book_id IS NULL OR book_id <> ?1))
                 OR EXISTS (SELECT 1 FROM books WHERE deleted_at IS NULL AND id <> ?1)
                 OR EXISTS (SELECT 1 FROM notes WHERE id IN (SELECT value FROM json_each(?2)))
                 OR EXISTS (SELECT 1 FROM books WHERE id IN (SELECT value FROM json_each(?2)))
                 OR EXISTS (SELECT 1 FROM files WHERE id IN (SELECT value FROM json_each(?2)))",
            params![TEMPLATES_BOOK_ID, ids],
            |row| row.get(0),
        )?;
        if held {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO books (id, name, name_hlc, parent_id, parent_hlc, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                book.id,
                book.name,
                book.name_hlc,
                book.parent_id,
                book.parent_hlc,
                book.created_at,
                book.updated_at
            ],
        )?;
        for WelcomeNote {
            record: note,
            links,
        } in notes
        {
            tx.execute(
                "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, book_id, book_hlc,
                                    status, status_hlc, pinned, pinned_hlc,
                                    created_at, updated_at, body_version, dates_hlc)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    note.id,
                    note.title,
                    note.title_hlc,
                    note.body_md,
                    note.ydoc,
                    note.book_id,
                    note.book_hlc,
                    note.status,
                    note.status_hlc,
                    note.pinned,
                    note.pinned_hlc,
                    note.created_at,
                    note.updated_at,
                    note.body_version,
                    note.dates_hlc
                ],
            )?;
            for target in links {
                tx.execute(
                    "INSERT OR IGNORE INTO links (source_id, target_id) VALUES (?1, ?2)",
                    params![note.id, target],
                )?;
            }
        }
        for file in files {
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
        Ok(true)
    }
}
