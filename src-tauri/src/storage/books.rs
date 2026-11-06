use rusqlite::params;

use super::{BookRecord, Result, Store, TAG_COLORS, notebook_icon};

impl Store {
    pub fn list_books(&self) -> Result<Vec<BookRecord>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT id, name, name_hlc, parent_id, parent_hlc, created_at, updated_at,
                    deleted_at, deleted_hlc, ai_access, ai_access_hlc, sort_key, sort_key_hlc,
                    icon, icon_color, icon_hlc
             FROM books WHERE deleted_at IS NULL ORDER BY id",
        )?;
        let rows = statement.query_map([], |row| {
            let icon: Option<String> = row.get(13)?;
            let icon_color: Option<String> = row.get(14)?;
            Ok(BookRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                name_hlc: row.get(2)?,
                parent_id: row.get(3)?,
                parent_hlc: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
                deleted_hlc: row.get(8)?,
                ai_access: row.get(9)?,
                ai_access_hlc: row.get(10)?,
                sort_key: row.get(11)?,
                sort_key_hlc: row.get(12)?,
                icon: icon.filter(|name| notebook_icon(name)),
                icon_color: icon_color.filter(|c| TAG_COLORS.contains(&c.as_str())),
                icon_hlc: row.get(15)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Whether `list_books` holds it, without reading every notebook.
    pub fn book_is_live(&self, id: &str) -> Result<bool> {
        let mut statement = self.conn.prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM books WHERE id = ?1 AND deleted_at IS NULL)",
        )?;
        Ok(statement.query_row([id], |row| row.get(0))?)
    }

    pub fn put_book(&mut self, book: &BookRecord) -> Result<()> {
        self.put_books(std::slice::from_ref(book))
    }

    /// Each as `put_book`, in order, in one transaction: all of them or none.
    pub fn put_books(&mut self, books: &[BookRecord]) -> Result<()> {
        let tx = self.conn.transaction()?;
        let mut put = tx.prepare_cached(
            "INSERT INTO books (id, name, name_hlc, parent_id, parent_hlc, created_at,
                                updated_at, deleted_at, deleted_hlc, ai_access, ai_access_hlc,
                                sort_key, sort_key_hlc, icon, icon_color, icon_hlc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT (id) DO UPDATE SET
               name = CASE WHEN excluded.name_hlc > name_hlc THEN excluded.name ELSE name END,
               name_hlc = MAX(excluded.name_hlc, name_hlc),
               parent_id = CASE WHEN excluded.parent_hlc > parent_hlc
                                THEN excluded.parent_id ELSE parent_id END,
               parent_hlc = MAX(excluded.parent_hlc, parent_hlc),
               ai_access = CASE WHEN excluded.ai_access_hlc > ai_access_hlc
                                THEN excluded.ai_access ELSE ai_access END,
               ai_access_hlc = MAX(excluded.ai_access_hlc, ai_access_hlc),
               icon = CASE WHEN excluded.icon_hlc > icon_hlc THEN excluded.icon ELSE icon END,
               icon_color = CASE WHEN excluded.icon_hlc > icon_hlc
                                 THEN excluded.icon_color ELSE icon_color END,
               icon_hlc = MAX(excluded.icon_hlc, icon_hlc),
               -- Equal clocks (keys the core gave old notebooks on two devices):
               -- the greater key wins, so both sides end with the same one.
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
        )?;
        for book in books {
            put.execute(params![
                book.id,
                book.name,
                book.name_hlc,
                book.parent_id,
                book.parent_hlc,
                book.created_at,
                book.updated_at,
                book.deleted_at,
                book.deleted_hlc,
                book.ai_access,
                book.ai_access_hlc,
                book.sort_key,
                book.sort_key_hlc,
                book.icon,
                book.icon_color,
                book.icon_hlc
            ])?;
        }
        drop(put);
        tx.commit()?;
        Ok(())
    }
}
