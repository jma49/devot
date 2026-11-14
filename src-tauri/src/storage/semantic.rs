use super::notes::summary;
use super::search::search_sql_within;
use super::{NoteBody, NoteQuery, NoteSummary, Result, Store};

impl Store {
    /// Every live note's ID and stored body version, read from the list index alone.
    pub fn live_body_versions(&self) -> Result<Vec<(String, i64)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, body_version FROM notes INDEXED BY notes_list
              WHERE deleted_at IS NULL AND purged_at IS NULL",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The live notes among `ids` that meet `query`, most recently updated first. The query's
    /// text conditions must all be negated: a semantic search reads its words another way.
    pub fn notes_among(&self, query: &NoteQuery, ids: &[String]) -> Result<Vec<NoteSummary>> {
        if !query.text.is_empty() {
            self.catch_up_search_index(None)?;
        }
        let limit = u32::try_from(ids.len()).unwrap_or(u32::MAX).max(1);
        let (sql, values) = search_sql_within(query, limit, Some(ids));
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(values.iter()), summary)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// `get_bodies` for live notes only, with each body's version, which a reader compares with
    /// the version it asked for.
    pub fn live_bodies(&self, ids: &[String]) -> Result<Vec<(NoteBody, i64)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT n.id, n.title, n.body_md, n.body_version FROM json_each(@ids) j
               JOIN notes n ON n.id = j.value
              WHERE n.deleted_at IS NULL AND n.purged_at IS NULL ORDER BY j.key",
        )?;
        let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let rows = statement.query_map(rusqlite::named_params! { "@ids": ids }, |row| {
            Ok((
                NoteBody {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    body_md: row.get(2)?,
                },
                row.get(3)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}
