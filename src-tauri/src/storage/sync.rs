//! What sync keeps beside the notes (schema v19, `migrations/0019_sync.sql`), and the raw reads the
//! sync engine (src/core/sync) needs: trashed and purged notes with every tag membership, deleted
//! notebooks and tags, icons and colours as written. The TypeScript adapter (src/mcp/sqlite.ts,
//! `SYNC_SQL`) runs the same statements; a test compares them.

use rusqlite::{OptionalExtension, named_params};
use serde::{Deserialize, Serialize};

use super::{BookRecord, NoteRecord, NoteTagRecord, Result, Store, TagRecord};

const SYNC_PENDING_SQL: &str =
    "SELECT id FROM sync_records WHERE edits <> synced AND id > @after ORDER BY id LIMIT @limit";
const SYNC_ENTRY_SQL: &str =
    "SELECT id, kind, version, fingerprint, body_hlc AS bodyHlc, body_fp AS bodyFp, edits, synced
     FROM sync_records WHERE id = @id";
const SYNC_PUT_SQL: &str =
    "INSERT INTO sync_records (id, kind, version, fingerprint, body_hlc, body_fp, synced)
     VALUES (@id, @kind, @version, @fingerprint, @bodyHlc, @bodyFp, @synced)
     ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, version = excluded.version,
       fingerprint = excluded.fingerprint, body_hlc = excluded.body_hlc,
       body_fp = excluded.body_fp, synced = excluded.synced";
const SYNC_STATE_SQL: &str = "SELECT key, value FROM sync_state";
const SYNC_SET_STATE_SQL: &str = "INSERT INTO sync_state (key, value) VALUES (@key, @value)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value";
const SYNC_RESET_SQL: &str =
    "UPDATE sync_records SET version = 0, fingerprint = '', synced = edits - 1";
const SYNC_NOTE_TAGS_SQL: &str =
    "SELECT note_id AS noteId, tag_id AS tagId, present, hlc FROM note_tags
     WHERE note_id = @id ORDER BY tag_id";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntry {
    pub id: String,
    pub kind: String,
    pub version: i64,
    pub fingerprint: String,
    pub body_hlc: String,
    pub body_fp: String,
    /// Moved on by the triggers alone; ignored on a write.
    #[serde(default)]
    pub edits: i64,
    pub synced: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncNoteRow {
    pub note: NoteRecord,
    pub purged: bool,
    pub tags: Vec<NoteTagRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncLocal {
    pub id: String,
    pub entry: Option<SyncEntry>,
    pub note: Option<SyncNoteRow>,
    pub book: Option<BookRecord>,
    pub tag: Option<TagRecord>,
}

pub const SYNC_KINDS: [&str; 3] = ["note", "book", "tag"];

impl Store {
    pub fn sync_pending(&self, after: &str, limit: u32) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare_cached(SYNC_PENDING_SQL)?;
        let rows = statement
            .query_map(named_params! { "@after": after, "@limit": limit }, |row| {
                row.get(0)
            })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn sync_read(&self, ids: &[String]) -> Result<Vec<SyncLocal>> {
        ids.iter().map(|id| self.sync_read_one(id)).collect()
    }

    fn sync_read_one(&self, id: &str) -> Result<SyncLocal> {
        let entry = self
            .conn
            .prepare_cached(SYNC_ENTRY_SQL)?
            .query_row(named_params! { "@id": id }, |row| {
                Ok(SyncEntry {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    version: row.get(2)?,
                    fingerprint: row.get(3)?,
                    body_hlc: row.get(4)?,
                    body_fp: row.get(5)?,
                    edits: row.get(6)?,
                    synced: row.get(7)?,
                })
            })
            .optional()?;
        let note = self.sync_note(id)?;
        let book = if note.is_none() {
            self.sync_book(id)?
        } else {
            None
        };
        let tag = if note.is_none() && book.is_none() {
            self.sync_tag(id)?
        } else {
            None
        };
        Ok(SyncLocal {
            id: id.to_owned(),
            entry,
            note,
            book,
            tag,
        })
    }

    fn sync_note(&self, id: &str) -> Result<Option<SyncNoteRow>> {
        let row = self
            .conn
            .prepare_cached(
                "SELECT id, title, title_hlc, body_md, ydoc, created_at, updated_at,
                        deleted_at, deleted_hlc, book_id, book_hlc, status, status_hlc,
                        pinned, pinned_hlc, body_version, dates_hlc, purged_at IS NOT NULL
                 FROM notes WHERE id = ?1",
            )?
            .query_row([id], |row| {
                Ok((
                    NoteRecord {
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
                    },
                    row.get::<_, bool>(17)?,
                ))
            })
            .optional()?;
        let Some((note, purged)) = row else {
            return Ok(None);
        };
        let mut statement = self.conn.prepare_cached(SYNC_NOTE_TAGS_SQL)?;
        let tags = statement
            .query_map(named_params! { "@id": id }, |row| {
                Ok(NoteTagRecord {
                    note_id: row.get(0)?,
                    tag_id: row.get(1)?,
                    present: row.get(2)?,
                    hlc: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Some(SyncNoteRow { note, purged, tags }))
    }

    fn sync_book(&self, id: &str) -> Result<Option<BookRecord>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT id, name, name_hlc, parent_id, parent_hlc, created_at, updated_at,
                        deleted_at, deleted_hlc, ai_access, ai_access_hlc, sort_key, sort_key_hlc,
                        icon, icon_color, icon_hlc
                 FROM books WHERE id = ?1",
            )?
            .query_row([id], |row| {
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
                    icon: row.get(13)?,
                    icon_color: row.get(14)?,
                    icon_hlc: row.get(15)?,
                })
            })
            .optional()?)
    }

    fn sync_tag(&self, id: &str) -> Result<Option<TagRecord>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT id, name, name_hlc, created_at, updated_at, deleted_at, deleted_hlc,
                        color, color_hlc
                 FROM tags WHERE id = ?1",
            )?
            .query_row([id], |row| {
                Ok(TagRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    name_hlc: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    deleted_at: row.get(5)?,
                    deleted_hlc: row.get(6)?,
                    color: row.get(7)?,
                    color_hlc: row.get(8)?,
                })
            })
            .optional()?)
    }

    pub fn sync_put(&mut self, entry: &SyncEntry) -> Result<()> {
        self.conn
            .prepare_cached(SYNC_PUT_SQL)?
            .execute(named_params! {
                "@id": entry.id,
                "@kind": entry.kind,
                "@version": entry.version,
                "@fingerprint": entry.fingerprint,
                "@bodyHlc": entry.body_hlc,
                "@bodyFp": entry.body_fp,
                "@synced": entry.synced,
            })?;
        Ok(())
    }

    pub fn sync_state(&self) -> Result<Vec<(String, String)>> {
        let mut statement = self.conn.prepare_cached(SYNC_STATE_SQL)?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn sync_set_state(&mut self, key: &str, value: &str) -> Result<()> {
        self.conn
            .prepare_cached(SYNC_SET_STATE_SQL)?
            .execute(named_params! { "@key": key, "@value": value })?;
        Ok(())
    }

    pub fn sync_reset(&mut self) -> Result<()> {
        self.conn.execute(SYNC_RESET_SQL, [])?;
        Ok(())
    }

    /// A purge another device made: as `purge_note`, but the note's revisions stay, the copy the
    /// engine kept just before among them.
    pub fn sync_purge(&mut self, id: &str, at: i64, hlc: &str) -> Result<()> {
        self.purge(id, at, hlc, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("devot.sqlite")).unwrap();
        (dir, store)
    }

    fn note() -> NoteRecord {
        NoteRecord {
            id: NOTE.into(),
            title: "Plan".into(),
            title_hlc: "0001728000000000-0000-mac".into(),
            body_md: "Hi\n".into(),
            ydoc: vec![1, 2, 3],
            body_version: 0,
            book_id: None,
            book_hlc: String::new(),
            status: "none".into(),
            status_hlc: String::new(),
            pinned: false,
            pinned_hlc: String::new(),
            created_at: 1,
            updated_at: 2,
            dates_hlc: String::new(),
            deleted_at: None,
            deleted_hlc: None,
        }
    }

    #[test]
    fn marks_every_write_pending_until_the_engine_has_looked() {
        let (_dir, mut store) = store();
        store.put_note(&note(), &[]).unwrap();
        assert_eq!(store.sync_pending("", 10).unwrap(), vec![NOTE.to_string()]);
        let local = store.sync_read(&[NOTE.into()]).unwrap().remove(0);
        let entry = local.entry.unwrap();
        assert_eq!(
            (entry.kind.as_str(), entry.edits, entry.synced),
            ("note", 1, 0)
        );
        store
            .sync_put(&SyncEntry {
                version: 3,
                fingerprint: "f".into(),
                synced: entry.edits,
                ..entry.clone()
            })
            .unwrap();
        assert!(store.sync_pending("", 10).unwrap().is_empty());
        store
            .put_note_tag(&NoteTagRecord {
                note_id: NOTE.into(),
                tag_id: "0192a6f0-0000-7000-8000-0000000000aa".into(),
                present: true,
                hlc: "0001728000000001-0000-mac".into(),
            })
            .unwrap();
        assert_eq!(store.sync_pending("", 10).unwrap(), vec![NOTE.to_string()]);
        let again = store.sync_read(&[NOTE.into()]).unwrap().remove(0);
        assert_eq!(again.entry.as_ref().unwrap().version, 3);
        assert_eq!(again.note.unwrap().tags.len(), 1);
        store.sync_reset().unwrap();
        let reset = store
            .sync_read(&[NOTE.into()])
            .unwrap()
            .remove(0)
            .entry
            .unwrap();
        assert_eq!((reset.version, reset.fingerprint.as_str()), (0, ""));
        assert_eq!(store.sync_pending("", 10).unwrap(), vec![NOTE.to_string()]);
    }

    #[test]
    fn reads_purged_notes_and_keeps_revisions_of_a_purge_from_sync() {
        let (_dir, mut store) = store();
        store.put_note(&note(), &[]).unwrap();
        store
            .put_revision(&crate::storage::RevisionRecord {
                id: "0192a6f0-0000-7000-8000-0000000000f1".into(),
                note_id: NOTE.into(),
                kind: "body".into(),
                at: 5,
                ydoc: Some(vec![1, 2, 3]),
                length: Some(3),
                value: Some(crate::storage::MERGE.into()),
            })
            .unwrap();
        store
            .sync_purge(NOTE, 9, "0001728000000009-0000-mac")
            .unwrap();
        let row = store
            .sync_read(&[NOTE.into()])
            .unwrap()
            .remove(0)
            .note
            .unwrap();
        assert!(row.purged);
        assert_eq!(
            row.note.deleted_hlc.as_deref(),
            Some("0001728000000009-0000-mac")
        );
        assert_eq!(store.list_revisions(NOTE).unwrap().len(), 1);
        assert!(store.get_note(NOTE, true).unwrap().is_none());
    }

    #[test]
    fn keeps_state_by_key() {
        let (_dir, mut store) = store();
        store.sync_set_state("since", "4").unwrap();
        store.sync_set_state("since", "5").unwrap();
        store.sync_set_state("epoch", "e").unwrap();
        let mut state = store.sync_state().unwrap();
        state.sort();
        assert_eq!(
            state,
            vec![("epoch".into(), "e".into()), ("since".into(), "5".into())]
        );
    }
}
