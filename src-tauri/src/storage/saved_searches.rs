use rusqlite::{Connection, params};

use super::{Result, SavedSearchRecord, Store};

/// Merges per field by HLC like a tag; equal sort key clocks take the greater key, as
/// notebooks do.
pub(super) fn upsert_saved_search(conn: &Connection, search: &SavedSearchRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO saved_searches (id, name, name_hlc, query, query_hlc, sort_key,
                                     sort_key_hlc, created_at, updated_at, deleted_at,
                                     deleted_hlc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (id) DO UPDATE SET
           name = CASE WHEN excluded.name_hlc > name_hlc THEN excluded.name ELSE name END,
           name_hlc = MAX(excluded.name_hlc, name_hlc),
           query = CASE WHEN excluded.query_hlc > query_hlc THEN excluded.query ELSE query END,
           query_hlc = MAX(excluded.query_hlc, query_hlc),
           sort_key = CASE WHEN excluded.sort_key_hlc > sort_key_hlc
                             OR (excluded.sort_key_hlc = sort_key_hlc
                                 AND excluded.sort_key > sort_key)
                           THEN excluded.sort_key ELSE sort_key END,
           sort_key_hlc = MAX(excluded.sort_key_hlc, sort_key_hlc),
           deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                             THEN excluded.deleted_at ELSE deleted_at END,
           deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                              THEN excluded.deleted_hlc ELSE deleted_hlc END,
           created_at = MIN(excluded.created_at, created_at),
           updated_at = MAX(excluded.updated_at, updated_at)",
        params![
            search.id,
            search.name,
            search.name_hlc,
            search.query,
            search.query_hlc,
            search.sort_key,
            search.sort_key_hlc,
            search.created_at,
            search.updated_at,
            search.deleted_at,
            search.deleted_hlc
        ],
    )?;
    Ok(())
}

/// A `saved_searches` row in column order, as `list_saved_searches` and sync read it.
pub(crate) fn saved_search(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedSearchRecord> {
    Ok(SavedSearchRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        name_hlc: row.get(2)?,
        query: row.get(3)?,
        query_hlc: row.get(4)?,
        sort_key: row.get(5)?,
        sort_key_hlc: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        deleted_at: row.get(9)?,
        deleted_hlc: row.get(10)?,
    })
}

impl Store {
    pub fn list_saved_searches(&self) -> Result<Vec<SavedSearchRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, name, name_hlc, query, query_hlc, sort_key, sort_key_hlc, created_at,
                    updated_at, deleted_at, deleted_hlc
             FROM saved_searches WHERE deleted_at IS NULL ORDER BY sort_key, id",
        )?;
        let rows = statement.query_map([], saved_search)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn put_saved_search(&mut self, search: &SavedSearchRecord) -> Result<()> {
        upsert_saved_search(&self.conn, search)
    }
}
