//! Revision history commands. The core decides when to take versions and
//! which to compact; these store, list and delete them.

use super::notes::{MAX_TITLE_CHARS, MAX_YDOC_BYTES, valid_note_id};
use crate::storage::{
    AI_EDIT, BASELINE, CompactableVersion, Db, MERGE, NOTE_STATUSES, REVISION_KINDS, RevisionRecord,
    RevisionSummary,
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Far above what one note keeps and the core's compaction batches.
const MAX_DELETE_IDS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDto {
    pub id: String,
    pub note_id: String,
    pub kind: String,
    pub at: i64,
    pub ydoc: Option<String>,
    pub length: Option<i64>,
    pub value: Option<String>,
}

impl From<RevisionRecord> for RevisionDto {
    fn from(revision: RevisionRecord) -> Self {
        Self {
            ydoc: revision.ydoc.map(|bytes| STANDARD.encode(bytes)),
            id: revision.id,
            note_id: revision.note_id,
            kind: revision.kind,
            at: revision.at,
            length: revision.length,
            value: revision.value,
        }
    }
}

fn valid_event_value(kind: &str, value: Option<&str>) -> bool {
    match (kind, value) {
        ("title", Some(title)) => {
            title.chars().count() <= MAX_TITLE_CHARS && !title.contains(['\n', '\r'])
        }
        ("book", None) => true,
        ("book", Some(id)) => valid_note_id(id),
        ("status", Some(status)) => NOTE_STATUSES.contains(&status),
        ("pinned", Some(pinned)) => pinned == "0" || pinned == "1",
        _ => false,
    }
}

impl RevisionDto {
    fn into_record(self) -> Result<RevisionRecord, &'static str> {
        if !valid_note_id(&self.id) || !valid_note_id(&self.note_id) {
            return Err("E_REVISION_ID_INVALID");
        }
        if !REVISION_KINDS.contains(&self.kind.as_str()) {
            return Err("E_REVISION_KIND_INVALID");
        }
        if self.at < 0 {
            return Err("E_REVISION_TIME_INVALID");
        }
        let ydoc = if self.kind == "body" {
            let marker = self
                .value
                .as_deref()
                .is_none_or(|v| v == BASELINE || v == AI_EDIT || v == MERGE);
            if !marker || !self.length.is_some_and(|n| n >= 0) {
                return Err("E_REVISION_BODY_INVALID");
            }
            let ydoc = STANDARD
                .decode(self.ydoc.as_deref().unwrap_or_default().as_bytes())
                .map_err(|_| "E_REVISION_YDOC_INVALID")?;
            if ydoc.is_empty() || ydoc.len() > MAX_YDOC_BYTES {
                return Err("E_REVISION_YDOC_INVALID");
            }
            Some(ydoc)
        } else {
            if self.ydoc.is_some() || self.length.is_some() {
                return Err("E_REVISION_EVENT_INVALID");
            }
            if !valid_event_value(&self.kind, self.value.as_deref()) {
                return Err("E_REVISION_VALUE_INVALID");
            }
            None
        };
        Ok(RevisionRecord {
            id: self.id,
            note_id: self.note_id,
            kind: self.kind,
            at: self.at,
            ydoc,
            length: self.length,
            value: self.value,
        })
    }
}

const MAX_PAGE_NOTES: u32 = 10_000;

fn validate_range(from: i64, to: i64) -> Result<(), &'static str> {
    if from < 0 || to < from {
        return Err("E_REVISION_TIME_INVALID");
    }
    Ok(())
}

fn validate_page(after: &str, limit: u32) -> Result<(), &'static str> {
    if !after.is_empty() && !valid_note_id(after) {
        return Err("E_REVISION_ID_INVALID");
    }
    if limit == 0 || limit > MAX_PAGE_NOTES {
        return Err("E_REVISION_PAGE_INVALID");
    }
    Ok(())
}

fn validate_compact(ids: &[String], swept_at: Option<i64>) -> Result<(), &'static str> {
    if !ids.iter().all(|id| valid_note_id(id)) {
        return Err("E_REVISION_ID_INVALID");
    }
    if ids.len() > MAX_DELETE_IDS {
        return Err("E_REVISION_IDS_TOO_MANY");
    }
    if swept_at.is_some_and(|at| at < 0) {
        return Err("E_REVISION_TIME_INVALID");
    }
    Ok(())
}

fn validate_delete(note_id: &str, ids: &[String]) -> Result<(), &'static str> {
    if !valid_note_id(note_id) || !ids.iter().all(|id| valid_note_id(id)) {
        return Err("E_REVISION_ID_INVALID");
    }
    if ids.len() > MAX_DELETE_IDS {
        return Err("E_REVISION_IDS_TOO_MANY");
    }
    Ok(())
}

#[tauri::command]
pub async fn revision_put(db: State<'_, Db>, revision: RevisionDto) -> Result<(), String> {
    let record = revision.into_record().map_err(String::from)?;
    db.call(move |store| store.put_revision(&record))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revisions_list(
    db: State<'_, Db>,
    note_id: String,
) -> Result<Vec<RevisionSummary>, String> {
    if !valid_note_id(&note_id) {
        return Err("E_REVISION_ID_INVALID".into());
    }
    db.call(move |store| store.list_revisions(&note_id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revision_get(db: State<'_, Db>, id: String) -> Result<Option<RevisionDto>, String> {
    if !valid_note_id(&id) {
        return Err("E_REVISION_ID_INVALID".into());
    }
    db.call(move |store| store.get_revision(&id))
        .await
        .map(|revision| revision.map(RevisionDto::from))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revisions_delete(
    db: State<'_, Db>,
    note_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    validate_delete(&note_id, &ids).map_err(String::from)?;
    db.call(move |store| store.delete_revisions(&note_id, &ids))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revisions_compactable(
    db: State<'_, Db>,
    from: i64,
    to: i64,
    after: String,
    limit: u32,
) -> Result<Vec<CompactableVersion>, String> {
    validate_range(from, to).map_err(String::from)?;
    validate_page(&after, limit).map_err(String::from)?;
    db.call(move |store| store.compactable_versions(from, to, &after, limit))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revisions_compact(
    db: State<'_, Db>,
    ids: Vec<String>,
    swept_at: Option<i64>,
) -> Result<(), String> {
    validate_compact(&ids, swept_at).map_err(String::from)?;
    db.call(move |store| store.compact_revisions(&ids, swept_at))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revisions_last_compaction(db: State<'_, Db>) -> Result<Option<i64>, String> {
    db.call(|store| store.last_compaction())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192a6f0-0000-7000-8000-000000000001";
    const NOTE: &str = "0192a6f0-0000-7000-8000-0000000000a1";

    fn body() -> RevisionDto {
        RevisionDto {
            id: ID.into(),
            note_id: NOTE.into(),
            kind: "body".into(),
            at: 5,
            ydoc: Some(STANDARD.encode([1, 2, 3])),
            length: Some(3),
            value: None,
        }
    }

    fn event(kind: &str, value: Option<&str>) -> RevisionDto {
        RevisionDto {
            kind: kind.into(),
            ydoc: None,
            length: None,
            value: value.map(String::from),
            ..body()
        }
    }

    #[test]
    fn accepts_a_body_version_and_round_trips_through_the_dto() {
        let record = body().into_record().unwrap();
        assert_eq!(record.ydoc, Some(vec![1, 2, 3]));
        assert_eq!(RevisionDto::from(record), body());
        let baseline = RevisionDto {
            value: Some(BASELINE.into()),
            ..body()
        };
        let record = baseline.clone().into_record().unwrap();
        assert_eq!(record.value.as_deref(), Some(BASELINE));
        assert_eq!(RevisionDto::from(record), baseline);
        let ai = RevisionDto {
            value: Some(AI_EDIT.into()),
            ..body()
        };
        let record = ai.clone().into_record().unwrap();
        assert_eq!(record.value.as_deref(), Some(AI_EDIT));
        assert_eq!(RevisionDto::from(record), ai);
    }

    #[test]
    fn accepts_each_kind_of_metadata_event() {
        for dto in [
            event("title", Some("Plan")),
            event("title", Some("")),
            event("book", Some(NOTE)),
            event("book", None),
            event("status", Some("on_hold")),
            event("pinned", Some("1")),
            event("pinned", Some("0")),
        ] {
            assert!(dto.clone().into_record().is_ok(), "{dto:?}");
        }
    }

    #[test]
    fn rejects_bad_revisions() {
        type Case = (RevisionDto, &'static str);
        let cases: [Case; 15] = [
            (
                RevisionDto {
                    id: "x".into(),
                    ..body()
                },
                "E_REVISION_ID_INVALID",
            ),
            (
                RevisionDto {
                    note_id: "../n".into(),
                    ..body()
                },
                "E_REVISION_ID_INVALID",
            ),
            (event("tags", Some("a")), "E_REVISION_KIND_INVALID"),
            (RevisionDto { at: -1, ..body() }, "E_REVISION_TIME_INVALID"),
            (
                RevisionDto {
                    length: None,
                    ..body()
                },
                "E_REVISION_BODY_INVALID",
            ),
            (
                RevisionDto {
                    value: Some("x".into()),
                    ..body()
                },
                "E_REVISION_BODY_INVALID",
            ),
            (
                RevisionDto {
                    ydoc: None,
                    ..body()
                },
                "E_REVISION_YDOC_INVALID",
            ),
            (
                RevisionDto {
                    ydoc: Some("%%%".into()),
                    ..body()
                },
                "E_REVISION_YDOC_INVALID",
            ),
            (
                RevisionDto {
                    length: Some(1),
                    ..event("title", Some("a"))
                },
                "E_REVISION_EVENT_INVALID",
            ),
            (event("title", Some("a\nb")), "E_REVISION_VALUE_INVALID"),
            (event("title", Some("a\rb")), "E_REVISION_VALUE_INVALID"),
            (
                event("title", Some(&"x".repeat(1_001))),
                "E_REVISION_VALUE_INVALID",
            ),
            (event("book", Some("../x")), "E_REVISION_VALUE_INVALID"),
            (event("status", Some("urgent")), "E_REVISION_VALUE_INVALID"),
            (event("pinned", Some("yes")), "E_REVISION_VALUE_INVALID"),
        ];
        for (dto, code) in cases {
            assert_eq!(dto.into_record().unwrap_err(), code);
        }
    }

    #[test]
    fn validates_sweep_ranges() {
        assert_eq!(validate_range(0, 0), Ok(()));
        assert_eq!(validate_range(5, 9), Ok(()));
        assert_eq!(validate_range(-1, 9), Err("E_REVISION_TIME_INVALID"));
        assert_eq!(validate_range(9, 5), Err("E_REVISION_TIME_INVALID"));
    }

    #[test]
    fn validates_a_page_of_a_sweeps_listing() {
        assert_eq!(validate_page("", 500), Ok(()));
        assert_eq!(validate_page(NOTE, 1), Ok(()));
        assert_eq!(validate_page(NOTE, MAX_PAGE_NOTES), Ok(()));
        assert_eq!(validate_page("x", 500), Err("E_REVISION_ID_INVALID"));
        assert_eq!(validate_page(NOTE, 0), Err("E_REVISION_PAGE_INVALID"));
        assert_eq!(
            validate_page(NOTE, MAX_PAGE_NOTES + 1),
            Err("E_REVISION_PAGE_INVALID")
        );
    }

    #[test]
    fn validates_what_a_sweep_deletes_and_its_time() {
        assert_eq!(validate_compact(&[ID.into()], Some(0)), Ok(()));
        assert_eq!(validate_compact(&[], None), Ok(()));
        assert_eq!(
            validate_compact(&["x".into()], None),
            Err("E_REVISION_ID_INVALID")
        );
        assert_eq!(
            validate_compact(&vec![ID.to_string(); MAX_DELETE_IDS + 1], None),
            Err("E_REVISION_IDS_TOO_MANY")
        );
        assert_eq!(
            validate_compact(&[ID.into()], Some(-1)),
            Err("E_REVISION_TIME_INVALID")
        );
    }

    #[test]
    fn validates_compaction_arguments() {
        assert_eq!(validate_delete(NOTE, &[ID.into()]), Ok(()));
        assert_eq!(validate_delete("x", &[]), Err("E_REVISION_ID_INVALID"));
        assert_eq!(
            validate_delete(NOTE, &["x".into()]),
            Err("E_REVISION_ID_INVALID")
        );
        assert_eq!(
            validate_delete(NOTE, &vec![ID.to_string(); MAX_DELETE_IDS + 1]),
            Err("E_REVISION_IDS_TOO_MANY")
        );
    }
}
