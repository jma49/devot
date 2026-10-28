//! What sync keeps beside the notes (schema v19, `migrations/0019_sync.sql`), and the raw reads the
//! sync engine (src/core/sync) needs: trashed and purged notes with every tag membership, deleted
//! notebooks and tags, icons and colours as written. The TypeScript adapter (src/mcp/sqlite.ts,
//! `SYNC_SQL`) runs the same statements; a test compares them.

use rusqlite::{OptionalExtension, named_params};
use serde::{Deserialize, Serialize};

use super::{BookRecord, NoteRecord, NoteTagRecord, Result, Store, TagRecord};

const SYNC_PENDING_SQL: &str =
    "SELECT id FROM sync_records WHERE edits <> synced AND id > @after ORDER BY id LIMIT @limit";
const SYNC_PENDING_COUNT_SQL: &str = "SELECT COUNT(*) AS n FROM sync_records WHERE edits <> synced";
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
const SYNC_FILE_SQL: &str =
    "SELECT id, note_id AS noteId, note_hlc AS noteHlc, name, mime, size, created_at AS createdAt
     FROM files WHERE id = @id";
const SYNC_FILE_DATA_SQL: &str = "SELECT data FROM files WHERE id = @id";
const SYNC_FILE_PUT_SQL: &str =
    "INSERT INTO files (id, note_id, note_hlc, name, mime, size, data, created_at)
     VALUES (@id, @noteId, @noteHlc, @name, @mime, @size, @data, @createdAt)
     ON CONFLICT (id) DO UPDATE SET note_id = excluded.note_id, note_hlc = excluded.note_hlc";
const SYNC_FILE_DELETE_SQL: &str = "DELETE FROM files WHERE id = @id";
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

/// An attachment as sync sees it, without its bytes (`Store::sync_file_data`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    pub id: String,
    pub note_id: String,
    /// Empty for a file never passed to another note.
    pub note_hlc: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub created_at: i64,
}

/// A file another device wrote, checked by the caller. An existing row keeps its bytes and takes
/// only the owner and its clock: an attachment's bytes are written once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncFileWrite {
    pub file: SyncFile,
    pub data: Vec<u8>,
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
    /// Absent for a purged file: its entry is the tombstone.
    pub file: Option<SyncFile>,
}

pub const SYNC_KINDS: [&str; 4] = ["note", "book", "tag", "file"];

impl Store {
    pub fn sync_pending(&self, after: &str, limit: u32) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare_cached(SYNC_PENDING_SQL)?;
        let rows = statement
            .query_map(named_params! { "@after": after, "@limit": limit }, |row| {
                row.get(0)
            })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn sync_pending_count(&self) -> Result<i64> {
        let mut statement = self.conn.prepare_cached(SYNC_PENDING_COUNT_SQL)?;
        Ok(statement.query_row([], |row| row.get(0))?)
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
        let file = if note.is_none() && book.is_none() && tag.is_none() {
            self.sync_file(id)?
        } else {
            None
        };
        Ok(SyncLocal {
            id: id.to_owned(),
            entry,
            note,
            book,
            tag,
            file,
        })
    }

    fn sync_file(&self, id: &str) -> Result<Option<SyncFile>> {
        Ok(self
            .conn
            .prepare_cached(SYNC_FILE_SQL)?
            .query_row(named_params! { "@id": id }, |row| {
                Ok(SyncFile {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    note_hlc: row.get(2)?,
                    name: row.get(3)?,
                    mime: row.get(4)?,
                    size: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .optional()?)
    }

    /// The bytes of an attachment, read only when it is pushed.
    pub fn sync_file_data(&self, id: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn
            .prepare_cached(SYNC_FILE_DATA_SQL)?
            .query_row(named_params! { "@id": id }, |row| row.get(0))
            .optional()?)
    }

    pub fn sync_file_put(&mut self, write: &SyncFileWrite) -> Result<()> {
        let file = &write.file;
        self.conn
            .prepare_cached(SYNC_FILE_PUT_SQL)?
            .execute(named_params! {
                "@id": file.id,
                "@noteId": file.note_id,
                "@noteHlc": file.note_hlc,
                "@name": file.name,
                "@mime": file.mime,
                "@size": file.size,
                "@data": write.data,
                "@createdAt": file.created_at,
            })?;
        Ok(())
    }

    /// A purge made on another device: the row goes, its entry stays as the tombstone.
    pub fn sync_file_delete(&mut self, id: &str) -> Result<()> {
        self.conn
            .prepare_cached(SYNC_FILE_DELETE_SQL)?
            .execute(named_params! { "@id": id })?;
        Ok(())
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
    /// engine kept just before among them, and so do its attachments, which the file records of
    /// that device settle (a purge that arrives before the heir note's link would delete them).
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
        assert_eq!(store.sync_pending_count().unwrap(), 1);
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
        assert_eq!(store.sync_pending_count().unwrap(), 0);
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

    const FILE: &str = "0192a6f0-0000-7000-8000-00000000f001";
    const OTHER: &str = "0192a6f0-0000-7000-8000-000000000002";
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn attachment(id: &str, note_id: &str) -> crate::storage::FileRecord {
        crate::storage::FileRecord {
            id: id.into(),
            note_id: note_id.into(),
            name: "shot.png".into(),
            mime: "image/png".into(),
            data: PNG.to_vec(),
            created_at: 7,
        }
    }

    fn looked_at(store: &mut Store, id: &str) -> SyncEntry {
        let entry = store
            .sync_read(&[id.into()])
            .unwrap()
            .remove(0)
            .entry
            .unwrap();
        store
            .sync_put(&SyncEntry {
                version: 1,
                fingerprint: "f".into(),
                synced: entry.edits,
                ..entry.clone()
            })
            .unwrap();
        entry
    }

    #[test]
    fn marks_an_attachment_pending_and_reads_it_without_its_bytes() {
        let (_dir, mut store) = store();
        store.put_note(&note(), &[]).unwrap();
        assert!(store.put_file(&attachment(FILE, NOTE)).unwrap());
        assert!(
            store
                .sync_pending("", 10)
                .unwrap()
                .contains(&FILE.to_string())
        );
        let local = store.sync_read(&[FILE.into()]).unwrap().remove(0);
        assert_eq!(local.entry.as_ref().unwrap().kind, "file");
        assert!(local.note.is_none() && local.book.is_none() && local.tag.is_none());
        assert_eq!(
            local.file,
            Some(SyncFile {
                id: FILE.into(),
                note_id: NOTE.into(),
                note_hlc: String::new(),
                name: "shot.png".into(),
                mime: "image/png".into(),
                size: PNG.len() as i64,
                created_at: 7,
            })
        );
        assert_eq!(store.sync_file_data(FILE).unwrap().as_deref(), Some(PNG));
        assert_eq!(store.sync_file_data(OTHER).unwrap(), None);
    }

    #[test]
    fn keeps_a_purged_attachment_as_an_entry_with_no_row() {
        let (_dir, mut store) = store();
        store.put_note(&note(), &[]).unwrap();
        store.put_file(&attachment(FILE, NOTE)).unwrap();
        let seen = looked_at(&mut store, FILE);
        assert!(
            !store
                .sync_pending("", 10)
                .unwrap()
                .contains(&FILE.to_string())
        );
        store
            .purge_note(NOTE, 9, "0001728000000009-0000-mac")
            .unwrap();
        let gone = store.sync_read(&[FILE.into()]).unwrap().remove(0);
        assert!(gone.file.is_none());
        let entry = gone.entry.unwrap();
        assert_eq!((entry.kind.as_str(), entry.version), ("file", 1));
        assert!(entry.edits > seen.edits, "the purge is pending");
        assert!(
            store
                .sync_pending("", 10)
                .unwrap()
                .contains(&FILE.to_string())
        );
        assert_eq!(store.sync_file_data(FILE).unwrap(), None);
    }

    #[test]
    fn keeps_attachments_when_the_purge_comes_from_sync() {
        let (_dir, mut store) = store();
        store.put_note(&note(), &[]).unwrap();
        store.put_file(&attachment(FILE, NOTE)).unwrap();
        let seen = looked_at(&mut store, FILE);
        store
            .sync_purge(NOTE, 9, "0001728000000009-0000-mac")
            .unwrap();
        let kept = store.sync_read(&[FILE.into()]).unwrap().remove(0);
        assert_eq!(kept.file.unwrap().note_id, NOTE);
        assert_eq!(
            kept.entry.unwrap().edits,
            seen.edits,
            "no tombstone to push"
        );
        assert_eq!(store.sync_file_data(FILE).unwrap().as_deref(), Some(PNG));
    }

    #[test]
    fn hands_an_attachment_to_the_note_that_shows_it_dated_by_the_purge() {
        let (_dir, mut store) = store();
        store.put_note(&note(), &[]).unwrap();
        let mut heir = note();
        heir.id = OTHER.into();
        heir.body_md = format!("![x](devot://file/{FILE})\n");
        store.put_note(&heir, &[]).unwrap();
        store.put_file(&attachment(FILE, NOTE)).unwrap();
        store
            .purge_note(NOTE, 9, "0001728000000009-0000-mac")
            .unwrap();
        let file = store
            .sync_read(&[FILE.into()])
            .unwrap()
            .remove(0)
            .file
            .unwrap();
        assert_eq!(file.note_id, OTHER);
        assert_eq!(file.note_hlc, "0001728000000009-0000-mac");
        assert_eq!(store.sync_file_data(FILE).unwrap().as_deref(), Some(PNG));
    }

    #[test]
    fn takes_an_attachment_from_another_device_once_and_keeps_its_bytes() {
        let (_dir, mut store) = store();
        let write = SyncFileWrite {
            file: SyncFile {
                id: FILE.into(),
                note_id: NOTE.into(),
                note_hlc: String::new(),
                name: "shot.png".into(),
                mime: "image/png".into(),
                size: PNG.len() as i64,
                created_at: 7,
            },
            data: PNG.to_vec(),
        };
        store.sync_file_put(&write).unwrap();
        assert_eq!(store.sync_file_data(FILE).unwrap().as_deref(), Some(PNG));
        let mut moved = write.clone();
        moved.file.note_id = OTHER.into();
        moved.file.note_hlc = "0001728000000003-0000-mac".into();
        moved.file.name = "renamed.png".into();
        moved.data = b"\x89PNG\r\n\x1a\nother bytes".to_vec();
        store.sync_file_put(&moved).unwrap();
        let file = store
            .sync_read(&[FILE.into()])
            .unwrap()
            .remove(0)
            .file
            .unwrap();
        assert_eq!(
            (
                file.note_id.as_str(),
                file.note_hlc.as_str(),
                file.name.as_str()
            ),
            (OTHER, "0001728000000003-0000-mac", "shot.png")
        );
        assert_eq!(store.sync_file_data(FILE).unwrap().as_deref(), Some(PNG));
        store.sync_file_delete(FILE).unwrap();
        assert!(
            store
                .sync_read(&[FILE.into()])
                .unwrap()
                .remove(0)
                .file
                .is_none()
        );
        assert_eq!(store.sync_file_data(FILE).unwrap(), None);
    }

    #[test]
    fn upgrades_a_database_with_attachments_and_sync_state_from_schema_21() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            for sql in &crate::storage::MIGRATIONS[..21] {
                conn.execute_batch(sql).unwrap();
            }
            conn.execute_batch(&format!(
                "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
                   VALUES ('{NOTE}', 'Kept', '', '', x'00', 1, 1);
                 INSERT INTO files (id, note_id, name, mime, size, data, created_at)
                   VALUES ('{FILE}', '{NOTE}', 'a.png', 'image/png', 3, x'010203', 5);
                 UPDATE sync_records SET version = 4, fingerprint = 'abc', synced = edits
                   WHERE id = '{NOTE}';
                 PRAGMA user_version = 21;"
            ))
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.schema_version().unwrap(),
            crate::storage::SCHEMA_VERSION
        );
        let note = store
            .sync_read(&[NOTE.into()])
            .unwrap()
            .remove(0)
            .entry
            .unwrap();
        assert_eq!((note.version, note.fingerprint.as_str()), (4, "abc"));
        assert_eq!(note.edits, note.synced, "the note is as synced as it was");
        let file = store.sync_read(&[FILE.into()]).unwrap().remove(0);
        assert_eq!(file.entry.unwrap().kind, "file");
        assert_eq!(file.file.unwrap().note_hlc, "");
        assert!(
            store
                .sync_pending("", 10)
                .unwrap()
                .contains(&FILE.to_string())
        );
    }
}
