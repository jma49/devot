use rusqlite::{OptionalExtension, params};

use super::agent_writes::AGENT_WRITES_PURGE_SQL;
use super::search::{catch_up, catch_up_note};
use super::{Result, StorageError, Store};

/// Run when a note (`@id`) is purged, before its attachments are deleted: gives each attachment
/// that another note, not purged, still shows (its Markdown holds `devot://file/<id>`) to that
/// note, a live one before one in the Trash, then the smallest ID. A link can reach another note
/// without a copy (cut or dragged Markdown, Paste as Plain Text, an outside writer, a restored version, an
/// old duplicate) and its image must stay. The search index, caught up first, finds those notes
/// (a phrase match, so no note is read whole); it ignores case, so `instr` checks the address as written. The same
/// statement as the TypeScript adapter's (tests/support/sqlite-adapter.ts, HAND_OVER_FILES_SQL; a test compares
/// them). `@hlc` is the purge's clock: it dates the new owner, so a device that hears of the same
/// purge settles on the same note (docs/adr/0003-sync-attachments-as-records.md, risk 5).
const HAND_OVER_FILES_SQL: &str = r#"UPDATE files SET note_hlc = MAX(note_hlc, @hlc), note_id = COALESCE((
       SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH 'body_md : "devot://file/' || replace(files.id, '"', '""') || '"'
          AND n.purged_at IS NULL AND n.id <> files.note_id
          AND instr(n.body_md, 'devot://file/' || files.id) > 0
        ORDER BY n.deleted_at IS NOT NULL, n.id LIMIT 1), note_id)
     WHERE note_id = @id"#;

/// FTS5 `secure-delete`: on, the search index takes a note's old text out of its pages instead
/// of only marking it deleted, so it leaves no trigrams behind. Only a purge turns it on, as it
/// makes every change of a long note's text many times slower to index. The TypeScript adapter
/// (tests/support/sqlite-adapter.ts) runs the same statement.
const SEARCH_SECURE_DELETE_SQL: &str =
    "INSERT INTO notes_fts (notes_fts, rank) VALUES ('secure-delete', ?1)";

impl Store {
    /// Wipes the note's content and tags, keeps its ID and clocks as a tombstone and marks it
    /// purged: final, `put_note` never changes a purged row. Its attachments go too, except those
    /// another note that is not purged still shows: they pass to that note (`HAND_OVER_FILES_SQL`).
    /// Only a note in the Trash, or one with no title and no body, is purged here: a renderer
    /// cannot destroy a live note in one call. A purge another device made (`sync_purge`) is not
    /// limited, as that device checked it.
    pub fn purge_note(&mut self, id: &str, at: i64, hlc: &str) -> Result<()> {
        let live: bool = self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND purged_at IS NULL
               AND deleted_at IS NULL AND (title <> '' OR body_md <> ''))",
            [id],
            |row| row.get(0),
        )?;
        if live {
            return Err(StorageError::Refused("E_NOTE_NOT_TRASHED"));
        }
        self.purge(id, at, hlc, true)
    }

    /// Tests that purge a note they wrote: trashed first, as the app does.
    #[cfg(test)]
    pub(crate) fn trash_and_purge(&mut self, id: &str, at: i64, hlc: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET deleted_at = COALESCE(deleted_at, ?2),
               deleted_hlc = MAX(COALESCE(deleted_hlc, ''), ?3) WHERE id = ?1",
            params![id, at, hlc],
        )?;
        self.purge_note(id, at, hlc)
    }

    /// `here` is false for a purge another device made: its revisions and attachments stay as they
    /// are, because that device's file records (a new owner or a tombstone) decide the attachments.
    pub(super) fn purge(&mut self, id: &str, at: i64, hlc: &str, here: bool) -> Result<()> {
        let tx = self.conn.transaction()?;
        let rowid: Option<i64> = tx
            .query_row(
                "SELECT rowid FROM notes WHERE id = ?1 AND purged_at IS NULL",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        tx.execute(SEARCH_SECURE_DELETE_SQL, [1])?;
        tx.execute(
            "UPDATE notes SET title = '', title_hlc = MAX(title_hlc, ?3), body_md = '', ydoc = x'',
               deleted_at = COALESCE(deleted_at, ?2),
               deleted_hlc = MAX(COALESCE(deleted_hlc, ''), ?3), purged_at = ?2
             WHERE id = ?1 AND purged_at IS NULL",
            params![id, at, hlc],
        )?;
        if let Some(rowid) = rowid {
            catch_up_note(&tx, rowid)?;
        }
        tx.execute(SEARCH_SECURE_DELETE_SQL, [0])?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", [id])?;
        if here {
            // HAND_OVER_FILES_SQL finds the heirs through the index.
            catch_up(&tx, None)?;
            tx.execute(
                HAND_OVER_FILES_SQL,
                rusqlite::named_params! { "@id": id, "@hlc": hlc },
            )?;
            tx.execute("DELETE FROM files WHERE note_id = ?1", [id])?;
        }
        tx.execute("DELETE FROM links WHERE source_id = ?1", [id])?;
        tx.execute(
            AGENT_WRITES_PURGE_SQL,
            rusqlite::named_params! { "@noteId": id },
        )?;
        if here {
            tx.execute("DELETE FROM revisions WHERE note_id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }
}
