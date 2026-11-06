use super::{ActivityData, ActivityNote, ActivityRevision, Result, Store};

/// The same statements as the TypeScript adapter's (tests/support/sqlite-adapter.ts, ACTIVITY_SQL; a test
/// compares them). Each reads a covering index of migration 0012, never a table row (rows hold Yjs
/// states).
const ACTIVITY_NOTES_SQL: &str =
    "SELECT id, created_at AS createdAt FROM notes INDEXED BY notes_created
     WHERE purged_at IS NULL AND created_at >= @since";
const ACTIVITY_REVISIONS_SQL: &str = "SELECT r.note_id AS noteId, r.kind, r.at, r.length, r.words,
            CASE WHEN r.kind = 'body' THEN
              (SELECT p.length FROM revisions p INDEXED BY revisions_activity
                WHERE p.note_id = r.note_id AND p.kind = 'body'
                  AND (p.at, p.length, p.rowid) < (r.at, r.length, r.rowid)
                ORDER BY p.at DESC, p.length DESC, p.words DESC, p.rowid DESC LIMIT 1)
            END AS previous,
            CASE WHEN r.kind = 'body' THEN
              (SELECT p.words FROM revisions p INDEXED BY revisions_activity
                WHERE p.note_id = r.note_id AND p.kind = 'body'
                  AND (p.at, p.length, p.rowid) < (r.at, r.length, r.rowid)
                ORDER BY p.at DESC, p.length DESC, p.words DESC, p.rowid DESC LIMIT 1)
            END AS previousWords
     FROM revisions r INDEXED BY revisions_by_time
     WHERE r.at >= @since AND r.kind IN ('body', 'title')
       AND (r.kind = 'title' OR r.value IS NULL)";
/// The same for the notes in `@ids` (a JSON array) only, the note list's activity strips: each
/// note's versions from `@since` on, from migration 0013's covering index `revisions_history`.
const NOTE_ACTIVITY_SQL: &str = "SELECT r.note_id AS noteId, r.kind, r.at, r.length, r.words,
            CASE WHEN r.kind = 'body' THEN
              (SELECT p.length FROM revisions p INDEXED BY revisions_activity
                WHERE p.note_id = r.note_id AND p.kind = 'body'
                  AND (p.at, p.length, p.rowid) < (r.at, r.length, r.rowid)
                ORDER BY p.at DESC, p.length DESC, p.words DESC, p.rowid DESC LIMIT 1)
            END AS previous,
            CASE WHEN r.kind = 'body' THEN
              (SELECT p.words FROM revisions p INDEXED BY revisions_activity
                WHERE p.note_id = r.note_id AND p.kind = 'body'
                  AND (p.at, p.length, p.rowid) < (r.at, r.length, r.rowid)
                ORDER BY p.at DESC, p.length DESC, p.words DESC, p.rowid DESC LIMIT 1)
            END AS previousWords
     FROM revisions r INDEXED BY revisions_history
     WHERE r.note_id IN (SELECT value FROM json_each(@ids)) AND r.at >= @since
       AND r.kind IN ('body', 'title') AND (r.kind = 'title' OR r.value IS NULL)";

impl Store {
    pub fn list_activity(&self, since: i64) -> Result<ActivityData> {
        let mut notes = self.conn.prepare_cached(ACTIVITY_NOTES_SQL)?;
        let notes = notes
            .query_map(rusqlite::named_params! { "@since": since }, |row| {
                Ok(ActivityNote {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut revisions = self.conn.prepare_cached(ACTIVITY_REVISIONS_SQL)?;
        let revisions = revisions
            .query_map(rusqlite::named_params! { "@since": since }, |row| {
                Ok(ActivityRevision {
                    note_id: row.get(0)?,
                    kind: row.get(1)?,
                    at: row.get(2)?,
                    length: row.get(3)?,
                    words: row.get(4)?,
                    previous: row.get(5)?,
                    previous_words: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ActivityData { notes, revisions })
    }

    pub fn list_note_activity(&self, ids: &[String], since: i64) -> Result<Vec<ActivityRevision>> {
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let mut statement = self.conn.prepare_cached(NOTE_ACTIVITY_SQL)?;
        let revisions = statement
            .query_map(
                rusqlite::named_params! { "@ids": ids, "@since": since },
                |row| {
                    Ok(ActivityRevision {
                        note_id: row.get(0)?,
                        kind: row.get(1)?,
                        at: row.get(2)?,
                        length: row.get(3)?,
                        words: row.get(4)?,
                        previous: row.get(5)?,
                        previous_words: row.get(6)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<_>>()?;
        Ok(revisions)
    }
}
