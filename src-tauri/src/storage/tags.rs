use rusqlite::{Connection, OptionalExtension, params};

use super::saved_searches::upsert_saved_search;
use super::{NoteTagRecord, Result, SavedSearchRecord, Store, TagRecord, valid_tag_color};

/// Merges per field by HLC. A free function so a rename can run it inside its transaction.
fn upsert_tag(conn: &Connection, tag: &TagRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO tags (id, name, name_hlc, created_at, updated_at, deleted_at, deleted_hlc,
                           color, color_hlc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (id) DO UPDATE SET
           name = CASE WHEN excluded.name_hlc > name_hlc THEN excluded.name ELSE name END,
           name_hlc = MAX(excluded.name_hlc, name_hlc),
           color = CASE WHEN excluded.color_hlc > color_hlc THEN excluded.color ELSE color END,
           color_hlc = MAX(excluded.color_hlc, color_hlc),
           deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                             THEN excluded.deleted_at ELSE deleted_at END,
           deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                              THEN excluded.deleted_hlc ELSE deleted_hlc END,
           created_at = MIN(excluded.created_at, created_at),
           updated_at = MAX(excluded.updated_at, updated_at)",
        params![
            tag.id,
            tag.name,
            tag.name_hlc,
            tag.created_at,
            tag.updated_at,
            tag.deleted_at,
            tag.deleted_hlc,
            tag.color,
            tag.color_hlc
        ],
    )?;
    Ok(())
}

impl Store {
    pub fn list_tags(&self) -> Result<Vec<TagRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, name, name_hlc, created_at, updated_at, deleted_at, deleted_hlc,
                    color, color_hlc
             FROM tags WHERE deleted_at IS NULL ORDER BY id",
        )?;
        let rows = statement.query_map([], |row| {
            let color: Option<String> = row.get(7)?;
            Ok(TagRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                name_hlc: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted_at: row.get(5)?,
                deleted_hlc: row.get(6)?,
                color: color.filter(|c| valid_tag_color(c)),
                color_hlc: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn put_tag(&mut self, tag: &TagRecord) -> Result<()> {
        upsert_tag(&self.conn, tag)
    }

    /// The tag and the saved searches rewritten for its new name, all or none.
    pub fn rename_tag(&mut self, tag: &TagRecord, searches: &[SavedSearchRecord]) -> Result<()> {
        let tx = self.conn.transaction()?;
        upsert_tag(&tx, tag)?;
        for search in searches {
            upsert_saved_search(&tx, search)?;
        }
        Ok(tx.commit()?)
    }

    pub fn put_note_tag(&mut self, link: &NoteTagRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO note_tags (note_id, tag_id, present, hlc) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (note_id, tag_id) DO UPDATE SET
               present = CASE WHEN excluded.hlc > hlc THEN excluded.present ELSE present END,
               hlc = MAX(excluded.hlc, hlc)",
            params![link.note_id, link.tag_id, link.present, link.hlc],
        )?;
        Ok(())
    }

    /// None when it was never written. The core reads it before writing the row, so its clock ticks
    /// past the stored one. The TypeScript adapter (tests/support/sqlite-adapter.ts) runs the same statement.
    pub fn get_note_tag(&self, note_id: &str, tag_id: &str) -> Result<Option<NoteTagRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT note_id, tag_id, present, hlc FROM note_tags WHERE note_id = ? AND tag_id = ?",
        )?;
        Ok(statement
            .query_row(params![note_id, tag_id], |row| {
                Ok(NoteTagRecord {
                    note_id: row.get(0)?,
                    tag_id: row.get(1)?,
                    present: row.get(2)?,
                    hlc: row.get(3)?,
                })
            })
            .optional()?)
    }
}
