//! The plugin drawings a note keeps (docs/adr/0030-plugin-drawings-sync-with-the-note.md, migration 0031): one row
//! a note, the list as JSON and the clock of its last change, which syncs in the note's record. The TypeScript
//! adapter (tests/support/sqlite-adapter.ts, `DRAWINGS_SQL`) runs the same statements; a test compares them.

use rusqlite::{OptionalExtension, named_params};
use serde::{Deserialize, Serialize};

use super::{Result, StorageError, Store};

const NOTE_DRAWINGS_GET_SQL: &str =
    "SELECT note_id AS noteId, drawings, hlc FROM note_drawings WHERE note_id = @noteId";
const NOTE_DRAWINGS_PUT_SQL: &str =
    "INSERT INTO note_drawings (note_id, drawings, hlc) VALUES (@noteId, @drawings, @hlc)
     ON CONFLICT (note_id) DO UPDATE SET drawings = excluded.drawings, hlc = excluded.hlc
     WHERE excluded.hlc > note_drawings.hlc";
pub(super) const NOTE_DRAWINGS_DROP_SQL: &str = "DELETE FROM note_drawings WHERE note_id = @noteId";
const NOTE_DRAWINGS_LIVE_SQL: &str =
    "SELECT 1 AS live FROM notes WHERE id = @noteId AND purged_at IS NULL";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeptDrawing {
    pub plugin_id: String,
    pub language: String,
    pub hash: String,
    pub appearance: String,
    /// Untrusted wherever it is read: the page rebuilds it through its SVG allowlist.
    pub svg: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDrawings {
    pub note_id: String,
    pub drawings: Vec<KeptDrawing>,
    pub hlc: String,
}

impl Store {
    /// None for a note that never kept a drawing, and for a row this build cannot read.
    pub fn get_note_drawings(&self, note_id: &str) -> Result<Option<NoteDrawings>> {
        let row: Option<(String, String)> = self
            .conn
            .prepare_cached(NOTE_DRAWINGS_GET_SQL)?
            .query_row(named_params! { "@noteId": note_id }, |row| {
                Ok((row.get(1)?, row.get(2)?))
            })
            .optional()?;
        Ok(row.and_then(|(drawings, hlc)| {
            serde_json::from_str(&drawings)
                .ok()
                .map(|drawings| NoteDrawings {
                    note_id: note_id.to_owned(),
                    drawings,
                    hlc,
                })
        }))
    }

    /// Written only under a newer clock than the stored one; `E_NOTE_NOT_FOUND` for a note not stored or purged.
    /// The caller checked the list (`commands::drawings`).
    pub fn put_note_drawings(&mut self, record: &NoteDrawings) -> Result<()> {
        let drawings = serde_json::to_string(&record.drawings)
            .map_err(|_| StorageError::Refused("E_NOTE_DRAWINGS_INVALID"))?;
        let tx = self.conn.transaction()?;
        let live = tx
            .prepare_cached(NOTE_DRAWINGS_LIVE_SQL)?
            .query_row(named_params! { "@noteId": record.note_id }, |_| Ok(()))
            .optional()?;
        if live.is_none() {
            return Err(StorageError::Refused("E_NOTE_NOT_FOUND"));
        }
        tx.prepare_cached(NOTE_DRAWINGS_PUT_SQL)?
            .execute(named_params! {
                "@noteId": record.note_id,
                "@drawings": drawings,
                "@hlc": record.hlc,
            })?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::NoteRecord;

    const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("devot.sqlite")).unwrap();
        (dir, store)
    }

    fn note() -> NoteRecord {
        NoteRecord {
            id: NOTE.into(),
            title: "Diagram".into(),
            title_hlc: "0001728000000000-0000-mac".into(),
            body_md: "```dot\na\n```\n".into(),
            ydoc: Vec::new(),
            body_version: 0,
            book_id: None,
            book_hlc: String::new(),
            status: "none".into(),
            status_hlc: String::new(),
            pinned: false,
            pinned_hlc: String::new(),
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
            deleted_hlc: None,
            dates_hlc: String::new(),
        }
    }

    fn drawings(hlc: &str, svg: &str) -> NoteDrawings {
        NoteDrawings {
            note_id: NOTE.into(),
            drawings: vec![KeptDrawing {
                plugin_id: "com.example.graphviz".into(),
                language: "dot".into(),
                hash: "a".repeat(64),
                appearance: "light".into(),
                svg: svg.into(),
            }],
            hlc: hlc.into(),
        }
    }

    #[test]
    fn keeps_the_newer_list_and_marks_the_note_pending() {
        let (_dir, mut store) = store();
        store.put_note(&note(), &[]).unwrap();
        let before = store.sync_read(&[NOTE.into()]).unwrap()[0]
            .entry
            .clone()
            .unwrap();
        let first = drawings("0001728000000002-0000-mac", "<svg/>");
        store.put_note_drawings(&first).unwrap();
        store
            .put_note_drawings(&drawings("0001728000000001-0000-mac", "<svg>old</svg>"))
            .unwrap();
        assert_eq!(store.get_note_drawings(NOTE).unwrap(), Some(first.clone()));
        let after = store.sync_read(&[NOTE.into()]).unwrap().remove(0);
        assert!(after.entry.unwrap().edits > before.edits);
        assert_eq!(after.note.unwrap().drawings, Some(first));
    }

    #[test]
    fn refuses_a_note_it_does_not_hold_and_drops_the_row_with_a_purge() {
        let (_dir, mut store) = store();
        assert_eq!(
            store
                .put_note_drawings(&drawings("0001728000000002-0000-mac", "<svg/>"))
                .unwrap_err()
                .code(),
            "E_NOTE_NOT_FOUND"
        );
        store.put_note(&note(), &[]).unwrap();
        store
            .put_note_drawings(&drawings("0001728000000002-0000-mac", "<svg/>"))
            .unwrap();
        store
            .trash_and_purge(NOTE, 5, "0001728000000009-0000-mac")
            .unwrap();
        assert_eq!(store.get_note_drawings(NOTE).unwrap(), None);
    }
}
