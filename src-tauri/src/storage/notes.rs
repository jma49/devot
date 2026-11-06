use rusqlite::{OptionalExtension, params};

use super::agent_writes::{AGENT_WRITES_KEEP_SQL, AGENT_WRITES_PUT_SQL};
use super::{
    AgentWriteRow, NoteBody, NoteRecord, NoteSummary, Result, StorageError, Store, TrashedNote,
};

/// The same statements as the TypeScript adapter's (tests/support/sqlite-adapter.ts, LIST_SQL; a test compares
/// them). Each reads an index that covers it (migration 0014), never a note's row: a note's small
/// columns come after its Markdown and its Yjs state, so reading them from the row walks every
/// overflow page of both.
pub(super) const NOTES_LIST_SQL: &str = "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, book_id AS bookId, status, pinned,
            (SELECT group_concat(nt.tag_id) FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
              WHERE nt.note_id = notes.id AND nt.present = 1) AS tagIds,
            body_version AS bodyVersion
     FROM notes INDEXED BY notes_list
     WHERE deleted_at IS NULL AND (@excludeBook IS NULL OR book_id IS NULL OR book_id <> @excludeBook)
     ORDER BY updated_at DESC, id DESC LIMIT @limit";
/// Backlinks: the list's index in its order, keeping the notes the link index has as linking to
/// `@id`, so it stops at a page and reads no row.
pub(super) const BACKLINKS_SQL: &str = "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, book_id AS bookId, status, pinned,
            (SELECT group_concat(nt.tag_id) FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
              WHERE nt.note_id = notes.id AND nt.present = 1) AS tagIds,
            body_version AS bodyVersion
     FROM notes INDEXED BY notes_list
     WHERE deleted_at IS NULL AND purged_at IS NULL AND id <> @id
       AND (book_id IS NULL OR book_id <> @excludeBook)
       AND id IN (SELECT source_id FROM links WHERE target_id = @id)
     ORDER BY updated_at DESC, id DESC LIMIT @limit";
pub(super) const TRASH_LIST_SQL: &str =
    "SELECT id, title, deleted_at AS deletedAt, book_id AS bookId FROM notes INDEXED BY notes_trash
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL ORDER BY deleted_at DESC, id DESC";
/// Rows by ID (`@ids`, a JSON array), as the TypeScript adapter's LIST_SQL has them: each found
/// through the primary key and read from its row, blobs and all, which for a page of IDs costs
/// far less than the list's index of every note.
pub(super) const NOTE_SUMMARIES_SQL: &str = "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, book_id AS bookId, status, pinned,
            (SELECT group_concat(nt.tag_id) FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
              WHERE nt.note_id = notes.id AND nt.present = 1) AS tagIds,
            body_version AS bodyVersion
     FROM notes
     WHERE id IN (SELECT value FROM json_each(@ids)) AND deleted_at IS NULL
     ORDER BY updated_at DESC, id DESC";
pub(super) const NOTE_BODIES_SQL: &str = "SELECT n.id, n.title, n.body_md AS bodyMd FROM json_each(@ids) j JOIN notes n ON n.id = j.value
     WHERE n.purged_at IS NULL ORDER BY j.key";

pub(super) fn summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    let tags: Option<String> = row.get(7)?;
    Ok(NoteSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        book_id: row.get(4)?,
        status: row.get(5)?,
        pinned: row.get(6)?,
        tag_ids: tags
            .map(|t| t.split(',').map(String::from).collect())
            .unwrap_or_default(),
        body_version: row.get(8)?,
        excerpt: None,
    })
}

impl Store {
    #[cfg(test)]
    pub fn list_notes(&self) -> Result<Vec<NoteSummary>> {
        self.list_notes_page(None, None)
    }

    /// `list_notes` without the notes in `exclude_book`, at most `limit` of them.
    pub fn list_notes_page(
        &self,
        exclude_book: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<NoteSummary>> {
        let mut statement = self.conn.prepare_cached(NOTES_LIST_SQL)?;
        let limit = limit.map_or(-1, i64::from);
        let rows = statement.query_map(
            rusqlite::named_params! { "@excludeBook": exclude_book, "@limit": limit },
            summary,
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The list rows of the live notes among `ids`, in list order.
    pub fn get_summaries(&self, ids: &[String]) -> Result<Vec<NoteSummary>> {
        let mut statement = self.conn.prepare_cached(NOTE_SUMMARIES_SQL)?;
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let rows = statement.query_map(rusqlite::named_params! { "@ids": ids }, summary)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The notes the owner wrote or kept, trashed ones included: purged notes and the fixed-ID
    /// first-launch ones (`00000000-0000-7000-8000-…`, the same on every device) are left out while
    /// they are as seeded. One changed since, which keeps its ID, counts: it merges like any note.
    pub fn own_note_count(&self) -> Result<u64> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE purged_at IS NULL
               AND (id NOT LIKE '00000000-0000-7000-8000-%' OR updated_at <> created_at)",
            [],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(count).unwrap_or(0))
    }

    /// The bodies of `ids` in their order, trashed notes included; purged and unknown IDs are left out.
    pub fn get_bodies(&self, ids: &[String]) -> Result<Vec<NoteBody>> {
        let mut statement = self.conn.prepare_cached(NOTE_BODIES_SQL)?;
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let rows = statement.query_map(rusqlite::named_params! { "@ids": ids }, |row| {
            Ok(NoteBody {
                id: row.get(0)?,
                title: row.get(1)?,
                body_md: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// With `trashed`, a trashed note too (never a purged one).
    pub fn get_note(&self, id: &str, trashed: bool) -> Result<Option<NoteRecord>> {
        self.read_note(
            "SELECT id, title, title_hlc, body_md, ydoc, created_at, updated_at,
                    deleted_at, deleted_hlc, book_id, book_hlc, status, status_hlc,
                    pinned, pinned_hlc, body_version, dates_hlc
             FROM notes WHERE id = ?1 AND purged_at IS NULL AND (?2 OR deleted_at IS NULL)",
            id,
            trashed,
        )
    }

    /// `get_note` of a note out of the Trash for its editor, which reads the body from the Yjs
    /// state: `body_md` is left empty, and never read.
    pub fn open_note(&self, id: &str) -> Result<Option<NoteRecord>> {
        self.read_note(
            "SELECT id, title, title_hlc, '', ydoc, created_at, updated_at,
                    deleted_at, deleted_hlc, book_id, book_hlc, status, status_hlc,
                    pinned, pinned_hlc, body_version, dates_hlc
             FROM notes WHERE id = ?1 AND purged_at IS NULL AND (?2 OR deleted_at IS NULL)",
            id,
            false,
        )
    }

    fn read_note(&self, sql: &str, id: &str, trashed: bool) -> Result<Option<NoteRecord>> {
        let mut statement = self.conn.prepare_cached(sql)?;
        Ok(statement
            .query_row(params![id, trashed], |row| {
                Ok(NoteRecord {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    title_hlc: row.get(2)?,
                    body_md: row.get(3)?,
                    ydoc: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    deleted_at: row.get(7)?,
                    deleted_hlc: row.get(8)?,
                    book_id: row.get(9)?,
                    book_hlc: row.get(10)?,
                    status: row.get(11)?,
                    status_hlc: row.get(12)?,
                    pinned: row.get(13)?,
                    pinned_hlc: row.get(14)?,
                    body_version: row.get(15)?,
                    dates_hlc: row.get(16)?,
                })
            })
            .optional()?)
    }

    /// Each metadata field keeps the value with the newer HLC, so a stale copy never undoes a newer
    /// change. The body (Yjs state and its snapshot) is written as given. The TypeScript adapter
    /// (tests/support/sqlite-adapter.ts) does the same. Also replaces the note's link index rows
    /// with `links`, unless the note was purged.
    /// A compare-and-set on the body: the note is written only while its stored body is still at
    /// `note.body_version`, the version its writer last saw, and its body moves on to the next one.
    /// A write based on another version, which would go over a body another process wrote since, is
    /// refused with `StorageError::BodyStale` and changes nothing; its writer takes the stored body
    /// in and writes again. A purged note is left alone, whatever the version, and the write is
    /// refused with `StorageError::Purged` so its writer hears it is gone rather than a false success.
    /// With `writes`, the note's agent_writes rows are replaced in the same transaction, each
    /// keeping whether it was seen; `None` leaves them as they are.
    pub fn put_note_with_writes(
        &mut self,
        note: &NoteRecord,
        links: &[String],
        writes: Option<&[AgentWriteRow]>,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        let written = tx.execute(
            "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, book_id, book_hlc,
                                status, status_hlc, pinned, pinned_hlc,
                                created_at, updated_at, deleted_at, deleted_hlc, body_version,
                                dates_hlc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16 + 1, ?17)
             ON CONFLICT (id) DO UPDATE SET
               title = CASE WHEN excluded.title_hlc > title_hlc THEN excluded.title ELSE title END,
               title_hlc = MAX(excluded.title_hlc, title_hlc),
               book_id = CASE WHEN excluded.book_hlc > book_hlc THEN excluded.book_id ELSE book_id END,
               book_hlc = MAX(excluded.book_hlc, book_hlc),
               status = CASE WHEN excluded.status_hlc > status_hlc THEN excluded.status ELSE status END,
               status_hlc = MAX(excluded.status_hlc, status_hlc),
               pinned = CASE WHEN excluded.pinned_hlc > pinned_hlc THEN excluded.pinned ELSE pinned END,
               pinned_hlc = MAX(excluded.pinned_hlc, pinned_hlc),
               deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                                 THEN excluded.deleted_at ELSE deleted_at END,
               deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                                  THEN excluded.deleted_hlc ELSE deleted_hlc END,
               body_md = excluded.body_md, ydoc = excluded.ydoc,
               body_version = excluded.body_version,
               created_at = CASE WHEN excluded.dates_hlc > dates_hlc
                                 THEN excluded.created_at ELSE created_at END,
               updated_at = CASE WHEN excluded.dates_hlc > dates_hlc
                                 THEN excluded.updated_at ELSE MAX(excluded.updated_at, updated_at) END,
               dates_hlc = MAX(excluded.dates_hlc, dates_hlc)
             WHERE purged_at IS NULL AND body_version = ?16",
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
                note.deleted_at,
                note.deleted_hlc,
                note.body_version,
                note.dates_hlc
            ],
        )?;
        if written == 0 {
            // Nothing written: the note was purged (left alone), or its body
            // moved on from the version the write is based on.
            let purged: bool = tx.query_row(
                "SELECT purged_at IS NOT NULL FROM notes WHERE id = ?1",
                [&note.id],
                |row| row.get(0),
            )?;
            if purged {
                return Err(StorageError::Purged);
            }
            return Err(StorageError::BodyStale);
        }
        if written > 0 {
            tx.execute("DELETE FROM links WHERE source_id = ?1", [&note.id])?;
            let mut insert =
                tx.prepare("INSERT OR IGNORE INTO links (source_id, target_id) VALUES (?1, ?2)")?;
            for target in links {
                insert.execute(params![note.id, target])?;
            }
            if let Some(rows) = writes {
                let ids = serde_json::to_string(
                    &rows.iter().map(|row| &row.write_id).collect::<Vec<_>>(),
                )
                .map_err(|_| StorageError::Refused("E_NOTE_WRITES_INVALID"))?;
                tx.execute(
                    AGENT_WRITES_KEEP_SQL,
                    rusqlite::named_params! { "@noteId": note.id, "@ids": ids },
                )?;
                let mut put = tx.prepare_cached(AGENT_WRITES_PUT_SQL)?;
                for row in rows {
                    put.execute(rusqlite::named_params! {
                        "@noteId": note.id,
                        "@writeId": row.write_id,
                        "@kind": row.kind,
                        "@name": row.name,
                        "@at": row.at,
                        "@created": row.created,
                    })?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_trash(&self) -> Result<Vec<TrashedNote>> {
        let mut statement = self.conn.prepare_cached(TRASH_LIST_SQL)?;
        let rows = statement.query_map([], |row| {
            Ok(TrashedNote {
                id: row.get(0)?,
                title: row.get(1)?,
                deleted_at: row.get(2)?,
                book_id: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// `put_note_with_writes` leaving the agent_writes rows alone.
    #[cfg(test)]
    pub fn put_note(&mut self, note: &NoteRecord, links: &[String]) -> Result<()> {
        self.put_note_with_writes(note, links, None)
    }

    /// Live notes outside `exclude_book` that link to `id` (the link index), the note itself left
    /// out, most recently updated first, then by ID; at most `limit`, without excerpts.
    pub fn list_backlinks(
        &self,
        id: &str,
        exclude_book: &str,
        limit: u32,
    ) -> Result<Vec<NoteSummary>> {
        let mut statement = self.conn.prepare_cached(BACKLINKS_SQL)?;
        let rows = statement.query_map(
            rusqlite::named_params! { "@id": id, "@excludeBook": exclude_book, "@limit": limit },
            summary,
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn note_bodies(&self, ids: &[String]) -> Result<Vec<(String, String)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, body_md FROM notes
             WHERE id IN (SELECT value FROM json_each(?1))
               AND deleted_at IS NULL AND purged_at IS NULL",
        )?;
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let rows = statement.query_map([ids], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}
