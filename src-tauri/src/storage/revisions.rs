use rusqlite::{OptionalExtension, params};

use super::{CompactableVersion, Result, RevisionRecord, RevisionSummary, Store};

/// The same statements as the TypeScript adapter's (tests/support/sqlite-adapter.ts, REVISION_SQL; a test
/// compares them). The reads go through covering indexes (migration 0013), never a version's Yjs
/// state. A note's revisions, newest first:
const REVISION_HISTORY_SQL: &str = "SELECT id, note_id, kind, at, length, value FROM revisions
     WHERE note_id = @noteId ORDER BY at DESC, id DESC";
/// The plain body versions (a baseline is kept, so left out) of the first
/// `@limit` notes, by ID after `@after`, with one taken at or after `@from`
/// and before `@to`, and more than one taken before `@to`; by note, newest
/// first. Only the window's versions are scanned, and each such note's:
const COMPACTABLE_SQL: &str =
    "SELECT note_id AS noteId, id, at FROM revisions INDEXED BY revisions_history
     WHERE kind = 'body' AND value IS NULL AND note_id IN (
       SELECT w.note_id FROM (
         SELECT DISTINCT note_id FROM revisions INDEXED BY revisions_by_time
          WHERE at >= @from AND at < @to AND kind = 'body' AND value IS NULL
            AND note_id > @after) w
        WHERE (SELECT COUNT(*) FROM revisions p INDEXED BY revisions_history
                WHERE p.note_id = w.note_id AND p.at < @to
                  AND p.kind = 'body' AND p.value IS NULL) > 1
        ORDER BY w.note_id LIMIT @limit)
     ORDER BY note_id, at DESC, id DESC";
const COMPACT_DROP_SQL: &str =
    "DELETE FROM revisions WHERE id = @id AND kind = 'body' AND value IS NULL";
const COMPACT_SWEPT_SQL: &str = "INSERT INTO compaction (id, swept_at) VALUES (1, @at)
     ON CONFLICT (id) DO UPDATE SET swept_at = excluded.swept_at";
const LAST_COMPACTION_SQL: &str = "SELECT swept_at AS sweptAt FROM compaction WHERE id = 1";

impl Store {
    /// A revision for a purged or unknown note is dropped. The TypeScript adapter
    /// (tests/support/sqlite-adapter.ts) runs the same statement.
    pub fn put_revision(&mut self, revision: &RevisionRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO revisions (id, note_id, kind, at, ydoc, length, value, words)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
              WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?2 AND purged_at IS NULL)
             ON CONFLICT (id) DO UPDATE SET
               at = excluded.at, ydoc = excluded.ydoc, length = excluded.length,
               value = excluded.value, words = excluded.words
             WHERE note_id = excluded.note_id AND kind = excluded.kind",
            params![
                revision.id,
                revision.note_id,
                revision.kind,
                revision.at,
                revision.ydoc,
                revision.length,
                revision.value,
                revision.words
            ],
        )?;
        Ok(())
    }

    pub fn list_revisions(&self, note_id: &str) -> Result<Vec<RevisionSummary>> {
        let mut statement = self.conn.prepare_cached(REVISION_HISTORY_SQL)?;
        let rows = statement.query_map(rusqlite::named_params! { "@noteId": note_id }, |row| {
            Ok(RevisionSummary {
                id: row.get(0)?,
                note_id: row.get(1)?,
                kind: row.get(2)?,
                at: row.get(3)?,
                length: row.get(4)?,
                value: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get_revision(&self, id: &str) -> Result<Option<RevisionRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, note_id, kind, at, ydoc, length, value, words FROM revisions WHERE id = ?1",
        )?;
        Ok(statement
            .query_row([id], |row| {
                Ok(RevisionRecord {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    kind: row.get(2)?,
                    at: row.get(3)?,
                    ydoc: row.get(4)?,
                    length: row.get(5)?,
                    value: row.get(6)?,
                    words: row.get(7)?,
                })
            })
            .optional()?)
    }

    pub fn delete_revisions(&mut self, note_id: &str, ids: &[String]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut delete = tx.prepare("DELETE FROM revisions WHERE note_id = ?1 AND id = ?2")?;
            for id in ids {
                delete.execute(params![note_id, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn compactable_versions(
        &self,
        from: i64,
        to: i64,
        after: &str,
        limit: u32,
    ) -> Result<Vec<CompactableVersion>> {
        let mut statement = self.conn.prepare_cached(COMPACTABLE_SQL)?;
        let rows = statement.query_map(
            rusqlite::named_params! {
                "@from": from,
                "@to": to,
                "@after": after,
                "@limit": limit,
            },
            |row| {
                Ok(CompactableVersion {
                    note_id: row.get(0)?,
                    id: row.get(1)?,
                    at: row.get(2)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn compact_revisions(&mut self, ids: &[String], swept_at: Option<i64>) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut delete = tx.prepare_cached(COMPACT_DROP_SQL)?;
            for id in ids {
                delete.execute(rusqlite::named_params! { "@id": id })?;
            }
        }
        if let Some(at) = swept_at {
            tx.execute(COMPACT_SWEPT_SQL, rusqlite::named_params! { "@at": at })?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn last_compaction(&self) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(LAST_COMPACTION_SQL, [], |row| row.get(0))
            .optional()?)
    }
}
