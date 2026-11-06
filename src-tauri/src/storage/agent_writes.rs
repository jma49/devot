use super::{AgentWriteSummary, Result, StorageError, Store};

/// The same statements as the TypeScript adapter's (tests/support/sqlite-adapter.ts, AGENT_WRITES_SQL; a test
/// compares them). A note's rows are replaced with each write that carries them, keeping `seen` of
/// the rows it still has. The list keeps every unseen row, however old: a note whose writes are all
/// older than the newest `limit` still shows its mark, its unseen count and its notice. The list is
/// two bounded reads merged in order: the unseen rows (index `agent_writes_unseen`) and the newest
/// `limit` seen ones (index `agent_writes_newest`).
pub(super) const AGENT_WRITES_KEEP_SQL: &str = "DELETE FROM agent_writes
     WHERE note_id = @noteId AND write_id NOT IN (SELECT value FROM json_each(@ids))";
pub(super) const AGENT_WRITES_PUT_SQL: &str =
    "INSERT INTO agent_writes (note_id, write_id, kind, name, at, created, seen)
     VALUES (@noteId, @writeId, @kind, @name, @at, @created, @kind = 'aiEdit')
     ON CONFLICT (note_id, write_id) DO UPDATE SET
       kind = excluded.kind, name = excluded.name, at = excluded.at, created = excluded.created";
const AGENT_WRITES_LIST_SQL: &str =
    "SELECT w.note_id AS noteId, w.write_id AS writeId, w.kind, w.name, w.at, w.created, w.seen
     FROM agent_writes w JOIN notes n ON n.id = w.note_id
     WHERE w.seen = 0 AND n.deleted_at IS NULL AND n.purged_at IS NULL
     UNION ALL
     SELECT w.note_id, w.write_id, w.kind, w.name, w.at, w.created, w.seen
     FROM (SELECT x.at, x.note_id, x.write_id FROM agent_writes x JOIN notes m ON m.id = x.note_id
       WHERE m.deleted_at IS NULL AND m.purged_at IS NULL
       ORDER BY x.at DESC, x.note_id, x.write_id LIMIT @limit) t
     JOIN agent_writes w ON w.note_id = t.note_id AND w.write_id = t.write_id AND w.seen = 1
     JOIN notes n ON n.id = w.note_id AND n.deleted_at IS NULL AND n.purged_at IS NULL
     ORDER BY at DESC, noteId, writeId";
const AGENT_WRITES_AUTHORED_SQL: &str = "SELECT DISTINCT w.note_id FROM agent_writes w
     JOIN notes n ON n.id = w.note_id
     WHERE n.deleted_at IS NULL AND n.purged_at IS NULL";
const AGENT_WRITES_SEEN_SQL: &str = "UPDATE agent_writes SET seen = 1
     WHERE note_id = @noteId AND seen = 0 AND write_id IN (SELECT value FROM json_each(@ids))";
pub(super) const AGENT_WRITES_PURGE_SQL: &str = "DELETE FROM agent_writes WHERE note_id = @noteId";

impl Store {
    /// Rows of notes not in the Trash, newest first: the newest `limit`, and every unseen row older than those.
    pub fn list_agent_writes(&self, limit: u32) -> Result<Vec<AgentWriteSummary>> {
        let mut statement = self.conn.prepare_cached(AGENT_WRITES_LIST_SQL)?;
        let rows = statement.query_map(rusqlite::named_params! { "@limit": limit }, |row| {
            Ok(AgentWriteSummary {
                note_id: row.get(0)?,
                write_id: row.get(1)?,
                kind: row.get(2)?,
                name: row.get(3)?,
                at: row.get(4)?,
                created: row.get(5)?,
                seen: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// IDs of the notes not in the Trash with any agent_writes row, seen or not: a note is
    /// authored whatever its rows' age, past the newest `limit` the list keeps.
    pub fn authored_notes(&self) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare_cached(AGENT_WRITES_AUTHORED_SQL)?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// IDs the note has no row for are skipped. Answers how many rows it changed.
    pub fn mark_agent_writes_seen(&mut self, note_id: &str, write_ids: &[String]) -> Result<usize> {
        let ids = serde_json::to_string(write_ids)
            .map_err(|_| StorageError::Refused("E_AGENT_WRITES_INVALID"))?;
        Ok(self.conn.execute(
            AGENT_WRITES_SEEN_SQL,
            rusqlite::named_params! { "@noteId": note_id, "@ids": ids },
        )?)
    }
}
