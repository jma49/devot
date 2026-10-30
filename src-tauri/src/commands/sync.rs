//! What the sync engine (src/core/sync, in the main window's core worker) reads and keeps in the
//! database: pending records, their raw rows, its entries and its state. The socket and the keys
//! are in `crate::sync`.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::notes::{NoteDto, valid_hlc, valid_note_id, validate_purge};
use crate::storage::{
    BookRecord, Db, NoteTagRecord, SYNC_KINDS, SyncEntry, SyncFile, SyncFileWrite, SyncLocal,
    SyncPending, TagRecord, Write,
};
use crate::sync::file_record::{self, Fields};

/// MAX_SYNC_IDS in src/core/sync/store.ts.
const MAX_SYNC_IDS: usize = 100;
const MAX_STATE_VALUE: usize = 128;
const STATE_KEYS: [&str; 5] = ["since", "epoch", "lastSync", "uploadTotal", "skippedBy"];
const MAX_VERSION: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNoteDto {
    pub note: NoteDto,
    pub purged: bool,
    pub tags: Vec<NoteTagRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLocalDto {
    pub id: String,
    pub entry: Option<SyncEntry>,
    pub note: Option<SyncNoteDto>,
    pub book: Option<BookRecord>,
    pub tag: Option<TagRecord>,
    pub file: Option<SyncFile>,
}

impl From<SyncLocal> for SyncLocalDto {
    fn from(local: SyncLocal) -> Self {
        Self {
            id: local.id,
            entry: local.entry,
            note: local.note.map(|row| SyncNoteDto {
                note: NoteDto::from(row.note),
                purged: row.purged,
                tags: row.tags,
            }),
            book: local.book,
            tag: local.tag,
            file: local.file,
        }
    }
}

fn hex_print(text: &str) -> bool {
    text.is_empty() || (text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn validate_entry(entry: &SyncEntry) -> Result<(), &'static str> {
    if !valid_note_id(&entry.id) {
        return Err("E_SYNC_ENTRY_ID_INVALID");
    }
    if !SYNC_KINDS.contains(&entry.kind.as_str()) {
        return Err("E_SYNC_ENTRY_KIND_INVALID");
    }
    if !(0..=MAX_VERSION).contains(&entry.version) || !(-1..=MAX_VERSION).contains(&entry.synced) {
        return Err("E_SYNC_ENTRY_VERSION_INVALID");
    }
    if !hex_print(&entry.fingerprint) || !hex_print(&entry.body_fp) {
        return Err("E_SYNC_ENTRY_PRINT_INVALID");
    }
    if !(entry.body_hlc.is_empty() || valid_hlc(&entry.body_hlc)) {
        return Err("E_SYNC_ENTRY_HLC_INVALID");
    }
    Ok(())
}

fn validate_state(key: &str, value: &str) -> Result<(), &'static str> {
    if !STATE_KEYS.contains(&key) {
        return Err("E_SYNC_STATE_KEY_INVALID");
    }
    if value.len() > MAX_STATE_VALUE || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("E_SYNC_STATE_VALUE_INVALID");
    }
    Ok(())
}

fn validate_ids(ids: &[String]) -> Result<(), &'static str> {
    if ids.len() > MAX_SYNC_IDS {
        return Err("E_SYNC_IDS_TOO_MANY");
    }
    if !ids.iter().all(|id| valid_note_id(id)) {
        return Err("E_SYNC_ID_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_pending(
    db: State<'_, Db>,
    after: String,
    limit: u32,
) -> Result<Vec<SyncPending>, String> {
    if !(after.is_empty() || valid_note_id(&after)) {
        return Err("E_SYNC_ID_INVALID".into());
    }
    if !(1..=MAX_SYNC_IDS as u32).contains(&limit) {
        return Err("E_SYNC_LIMIT_INVALID".into());
    }
    db.call(move |store| store.sync_pending(&after, limit))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_pending_count(db: State<'_, Db>) -> Result<i64, String> {
    db.call(|store| store.sync_pending_count())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_read(db: State<'_, Db>, ids: Vec<String>) -> Result<Vec<SyncLocalDto>, String> {
    validate_ids(&ids).map_err(String::from)?;
    db.call(move |store| store.sync_read(&ids))
        .await
        .map(|rows| rows.into_iter().map(SyncLocalDto::from).collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_entry_put(db: State<'_, Db>, entry: SyncEntry) -> Result<(), String> {
    validate_entry(&entry).map_err(String::from)?;
    db.write(Write::Content, move |store| store.sync_put(&entry))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_state_get(db: State<'_, Db>) -> Result<BTreeMap<String, String>, String> {
    db.call(|store| store.sync_state())
        .await
        .map(|rows| rows.into_iter().collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_state_put(db: State<'_, Db>, key: String, value: String) -> Result<(), String> {
    validate_state(&key, &value).map_err(String::from)?;
    db.write(Write::Bookkeeping, move |store| {
        store.sync_set_state(&key, &value)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_reset(db: State<'_, Db>) -> Result<(), String> {
    db.write(Write::Bookkeeping, |store| store.sync_reset())
        .await
        .map_err(|e| e.to_string())
}

/// The bytes of an attachment as base64, read when it is pushed; None once it is gone.
#[tauri::command]
pub async fn sync_file_data(db: State<'_, Db>, id: String) -> Result<Option<String>, String> {
    validate_ids(std::slice::from_ref(&id)).map_err(String::from)?;
    db.call(move |store| store.sync_file_data(&id))
        .await
        .map(|data| data.map(|bytes| STANDARD.encode(bytes)))
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncFileDto {
    pub id: String,
    pub note_id: String,
    pub note_hlc: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub created_at: i64,
}

/// An attachment another device wrote, checked here as a paste is checked: the bytes must be a
/// known raster image of at most 10 MiB, and the fields must describe them.
fn checked_file(file: SyncFileDto, data: &str) -> Result<SyncFileWrite, &'static str> {
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "E_SYNC_RECORD_INVALID")?;
    let size = u64::try_from(file.size).map_err(|_| "E_SYNC_RECORD_INVALID")?;
    file_record::check_file(
        &Fields {
            id: &file.id,
            note_id: &file.note_id,
            note_hlc: &file.note_hlc,
            name: &file.name,
            mime: &file.mime,
            size,
            created_at: file.created_at,
        },
        &bytes,
    )?;
    Ok(SyncFileWrite {
        file: SyncFile {
            id: file.id,
            note_id: file.note_id,
            note_hlc: file.note_hlc,
            name: file.name,
            mime: file.mime,
            size: file.size,
            created_at: file.created_at,
        },
        data: bytes,
    })
}

#[tauri::command]
pub async fn sync_file_put(
    db: State<'_, Db>,
    file: SyncFileDto,
    data: String,
) -> Result<(), String> {
    let id = file.id.clone();
    let write = checked_file(file, &data).inspect_err(|code| {
        log::warn!("W_SYNC_FILE_REFUSED {code} id={id}");
    })?;
    db.write(Write::Content, move |store| store.sync_file_put(&write))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_file_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    validate_ids(std::slice::from_ref(&id)).map_err(String::from)?;
    db.write(Write::Content, move |store| store.sync_file_delete(&id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_note_purge(
    db: State<'_, Db>,
    id: String,
    at: i64,
    hlc: String,
) -> Result<(), String> {
    validate_purge(&id, at, &hlc).map_err(String::from)?;
    db.write(Write::Content, move |store| store.sync_purge(&id, at, &hlc))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> SyncEntry {
        SyncEntry {
            id: "0192a6f0-0000-7000-8000-000000000001".into(),
            kind: "note".into(),
            version: 2,
            fingerprint: "a".repeat(64),
            body_hlc: "0001728000000000-0000-mac".into(),
            body_fp: String::new(),
            edits: 0,
            synced: 1,
        }
    }

    #[test]
    fn checks_an_entry_before_it_is_stored() {
        assert_eq!(validate_entry(&entry()), Ok(()));
        let bad = [
            SyncEntry {
                id: "x".into(),
                ..entry()
            },
            SyncEntry {
                kind: "folder".into(),
                ..entry()
            },
            SyncEntry {
                version: -1,
                ..entry()
            },
            SyncEntry {
                synced: -2,
                ..entry()
            },
            SyncEntry {
                fingerprint: "zz".into(),
                ..entry()
            },
            SyncEntry {
                body_hlc: "\u{e9}".into(),
                ..entry()
            },
        ];
        for entry in bad {
            assert!(validate_entry(&entry).is_err(), "{entry:?}");
        }
    }

    #[test]
    fn keeps_only_the_engine_s_own_state_keys() {
        assert_eq!(validate_state("since", "12"), Ok(()));
        assert_eq!(validate_state("epoch", "AbC-123_x"), Ok(()));
        assert_eq!(validate_state("uploadTotal", "45000"), Ok(()));
        assert_eq!(validate_state("skippedBy", "0.4.1"), Ok(()));
        assert_eq!(validate_state("skippedBy", ""), Ok(()));
        assert!(validate_state("token", "x").is_err());
        assert!(validate_state("since", &"9".repeat(200)).is_err());
        assert!(validate_state("since", "a b").is_err());
    }

    const FILE: &str = "0192a6f0-0000-7000-8000-00000000f001";
    const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";

    fn png(len: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; len];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes
    }

    fn dto(len: usize) -> SyncFileDto {
        SyncFileDto {
            id: FILE.into(),
            note_id: NOTE.into(),
            note_hlc: String::new(),
            name: "shot.png".into(),
            mime: "image/png".into(),
            size: len as i64,
            created_at: 7,
        }
    }

    #[test]
    fn takes_an_attachment_a_paste_would_take() {
        let data = png(64);
        let write = checked_file(dto(64), &STANDARD.encode(&data)).unwrap();
        assert_eq!(write.data, data);
        assert_eq!(write.file.id, FILE);
        assert_eq!(write.file.note_id, NOTE);
        assert_eq!(write.file.size, 64);
        assert_eq!(write.file.created_at, 7);
    }

    #[test]
    fn refuses_an_attachment_that_does_not_describe_its_bytes() {
        let data = STANDARD.encode(png(64));
        assert_eq!(
            checked_file(dto(64), "not base64!"),
            Err("E_SYNC_RECORD_INVALID")
        );
        let negative = SyncFileDto {
            size: -1,
            ..dto(64)
        };
        assert_eq!(checked_file(negative, &data), Err("E_SYNC_RECORD_INVALID"));
        assert_eq!(checked_file(dto(65), &data), Err("E_SYNC_RECORD_INVALID"));
        let bad_clock = SyncFileDto {
            note_hlc: "\u{e9}".into(),
            ..dto(64)
        };
        assert_eq!(checked_file(bad_clock, &data), Err("E_SYNC_RECORD_INVALID"));
        let bad_note = SyncFileDto {
            note_id: "x".into(),
            ..dto(64)
        };
        assert!(checked_file(bad_note, &data).is_err());
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";
        let as_svg = SyncFileDto {
            mime: "image/svg+xml".into(),
            size: svg.len() as i64,
            ..dto(0)
        };
        assert!(checked_file(as_svg, &STANDARD.encode(svg)).is_err());
    }

    #[test]
    fn takes_a_bounded_list_of_ids() {
        assert!(validate_ids(&[]).is_ok());
        let many = vec!["0192a6f0-0000-7000-8000-000000000001".to_string(); 101];
        assert_eq!(validate_ids(&many), Err("E_SYNC_IDS_TOO_MANY"));
        assert_eq!(validate_ids(&["nope".into()]), Err("E_SYNC_ID_INVALID"));
    }
}
