use crate::storage::{Db, NOTE_STATUSES, NoteQuery, NoteRecord, NoteSummary, SetKind, TrashedNote};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use tauri::State;

pub(crate) const MAX_TITLE_CHARS: usize = 1_000;
const MAX_HLC_LEN: usize = 64;
pub(crate) const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_YDOC_BYTES: usize = 64 * 1024 * 1024;
/// Notes one body may link to; far above any real note. Matches MAX_NOTE_LINKS
/// in src/core/links.ts, which devot-mcp checks before it writes.
const MAX_LINKS: usize = 10_000;
/// The largest version a note's body may be at, the largest whole number
/// JavaScript holds exactly: a write is based on a version below it, so the
/// version storage moves it on to stays exact in the core. Matches
/// MAX_BODY_VERSION in src/core/noteLimits.ts.
const MAX_BODY_VERSION: i64 = 9_007_199_254_740_991;

/// A note as it crosses the IPC boundary: the Yjs state travels as base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub title: String,
    pub title_hlc: String,
    pub body_md: String,
    pub ydoc: String,
    /// The version of the stored body the note's body is based on (see
    /// `Store::put_note`).
    pub body_version: i64,
    pub book_id: Option<String>,
    /// Empty when the notebook was never set.
    pub book_hlc: String,
    pub status: String,
    /// Empty when the status was never set.
    pub status_hlc: String,
    pub pinned: bool,
    /// Empty when pinning was never set.
    pub pinned_hlc: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub deleted_hlc: Option<String>,
}

impl From<NoteRecord> for NoteDto {
    fn from(note: NoteRecord) -> Self {
        Self {
            ydoc: STANDARD.encode(&note.ydoc),
            id: note.id,
            title: note.title,
            title_hlc: note.title_hlc,
            body_md: note.body_md,
            body_version: note.body_version,
            book_id: note.book_id,
            book_hlc: note.book_hlc,
            status: note.status,
            status_hlc: note.status_hlc,
            pinned: note.pinned,
            pinned_hlc: note.pinned_hlc,
            created_at: note.created_at,
            updated_at: note.updated_at,
            deleted_at: note.deleted_at,
            deleted_hlc: note.deleted_hlc,
        }
    }
}

/// Accepts only canonical, lowercase UUIDv7 strings (notes and notebooks).
pub(crate) fn valid_note_id(id: &str) -> bool {
    uuid::Uuid::try_parse(id)
        .is_ok_and(|u| u.get_version_num() == 7 && u.hyphenated().to_string() == id)
}

pub(crate) fn valid_hlc(hlc: &str) -> bool {
    !hlc.is_empty() && hlc.len() <= MAX_HLC_LEN && hlc.is_ascii()
}

impl NoteDto {
    fn into_record(self) -> Result<NoteRecord, &'static str> {
        if !valid_note_id(&self.id) {
            return Err("E_NOTE_ID_INVALID");
        }
        if self.title.chars().count() > MAX_TITLE_CHARS || self.title.contains(['\n', '\r']) {
            return Err("E_NOTE_TITLE_INVALID");
        }
        if !valid_hlc(&self.title_hlc) || !self.deleted_hlc.as_deref().is_none_or(valid_hlc) {
            return Err("E_NOTE_HLC_INVALID");
        }
        if !self.book_id.as_deref().is_none_or(valid_note_id) {
            return Err("E_NOTE_BOOK_INVALID");
        }
        if !(self.book_hlc.is_empty() || valid_hlc(&self.book_hlc))
            || (self.book_id.is_some() && self.book_hlc.is_empty())
        {
            return Err("E_NOTE_HLC_INVALID");
        }
        if !NOTE_STATUSES.contains(&self.status.as_str()) {
            return Err("E_NOTE_STATUS_INVALID");
        }
        let optional_hlc = |hlc: &str| hlc.is_empty() || valid_hlc(hlc);
        if !optional_hlc(&self.status_hlc) || !optional_hlc(&self.pinned_hlc) {
            return Err("E_NOTE_HLC_INVALID");
        }
        if self.body_md.len() > MAX_BODY_BYTES {
            return Err("E_NOTE_BODY_TOO_LARGE");
        }
        if self.created_at < 0 || self.updated_at < self.created_at {
            return Err("E_NOTE_TIME_INVALID");
        }
        if !(0..MAX_BODY_VERSION).contains(&self.body_version) {
            return Err("E_NOTE_VERSION_INVALID");
        }
        let ydoc = STANDARD
            .decode(self.ydoc.as_bytes())
            .map_err(|_| "E_NOTE_YDOC_INVALID")?;
        if ydoc.is_empty() || ydoc.len() > MAX_YDOC_BYTES {
            return Err("E_NOTE_YDOC_INVALID");
        }
        Ok(NoteRecord {
            id: self.id,
            title: self.title,
            title_hlc: self.title_hlc,
            body_md: self.body_md,
            ydoc,
            body_version: self.body_version,
            book_id: self.book_id,
            book_hlc: self.book_hlc,
            status: self.status,
            status_hlc: self.status_hlc,
            pinned: self.pinned,
            pinned_hlc: self.pinned_hlc,
            created_at: self.created_at,
            updated_at: self.updated_at,
            deleted_at: self.deleted_at,
            deleted_hlc: self.deleted_hlc,
        })
    }
}

#[tauri::command]
pub async fn notes_list(db: State<'_, Db>) -> Result<Vec<NoteSummary>, String> {
    db.call(|store| store.list_notes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn note_get(
    db: State<'_, Db>,
    id: String,
    trashed: Option<bool>,
) -> Result<Option<NoteDto>, String> {
    if !valid_note_id(&id) {
        return Err("E_NOTE_ID_INVALID".into());
    }
    let trashed = trashed.unwrap_or(false);
    db.call(move |store| store.get_note(&id, trashed))
        .await
        .map(|note| note.map(NoteDto::from))
        .map_err(|e| e.to_string())
}

#[tauri::command]
/// `links`: the note IDs the body links to (the core's `noteLinks`), for the
/// link index.
pub async fn note_put(db: State<'_, Db>, note: NoteDto, links: Vec<String>) -> Result<(), String> {
    let record = note.into_record().map_err(String::from)?;
    validate_links(&links).map_err(String::from)?;
    db.call(move |store| store.put_note(&record, &links))
        .await
        .map_err(|e| e.to_string())
}

fn validate_links(links: &[String]) -> Result<(), &'static str> {
    if links.len() > MAX_LINKS {
        return Err("E_NOTE_LINKS_TOO_MANY");
    }
    if !links.iter().all(|id| valid_note_id(id)) {
        return Err("E_NOTE_LINK_INVALID");
    }
    Ok(())
}

/// Conditions in one search: the core sends at most 10 clauses of a query
/// (MAX_SEARCH_TERMS in src/core/search.ts) plus two for the current view.
const MAX_SEARCH_CONDITIONS: usize = 12;
const MAX_TERM_CHARS: usize = 100;
/// IDs in one condition: a notebook with all its sub-notebooks, or every tag
/// with one name; far above any real library.
const MAX_SEARCH_IDS: usize = 10_000;
const SEARCH_LIMIT: u32 = 200;

fn validate_query(query: &NoteQuery) -> Result<(), &'static str> {
    if query.text.len() + query.sets.len() > MAX_SEARCH_CONDITIONS {
        return Err("E_SEARCH_TERMS_INVALID");
    }
    if query.text.iter().any(|t| {
        let n = t.value.chars().count();
        n == 0 || n > MAX_TERM_CHARS
    }) {
        return Err("E_SEARCH_TERM_INVALID");
    }
    for set in &query.sets {
        let valid = |id: &String| match set.kind {
            SetKind::Book | SetKind::Tag => valid_note_id(id),
            SetKind::Status => NOTE_STATUSES.contains(&id.as_str()),
        };
        if set.ids.is_empty() || set.ids.len() > MAX_SEARCH_IDS || !set.ids.iter().all(valid) {
            return Err("E_SEARCH_IDS_INVALID");
        }
    }
    Ok(())
}

/// Live notes meeting every condition; the core turns the query text into
/// conditions (names into IDs).
#[tauri::command]
pub async fn notes_search(db: State<'_, Db>, query: NoteQuery) -> Result<Vec<NoteSummary>, String> {
    validate_query(&query).map_err(String::from)?;
    db.call(move |store| store.search_notes(&query, SEARCH_LIMIT))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_trash_list(db: State<'_, Db>) -> Result<Vec<TrashedNote>, String> {
    db.call(|store| store.list_trash())
        .await
        .map_err(|e| e.to_string())
}

fn validate_purge(id: &str, at: i64, hlc: &str) -> Result<(), &'static str> {
    if !valid_note_id(id) {
        return Err("E_NOTE_ID_INVALID");
    }
    if at < 0 {
        return Err("E_NOTE_TIME_INVALID");
    }
    if !valid_hlc(hlc) {
        return Err("E_NOTE_HLC_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn note_purge(db: State<'_, Db>, id: String, at: i64, hlc: String) -> Result<(), String> {
    validate_purge(&id, at, &hlc).map_err(String::from)?;
    db.call(move |store| store.purge_note(&id, at, &hlc))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192a6f0-0000-7000-8000-000000000001";

    fn dto() -> NoteDto {
        NoteDto {
            id: ID.into(),
            title: "Title".into(),
            title_hlc: "0001728000000000-0000-node".into(),
            body_md: "# Title\n".into(),
            ydoc: STANDARD.encode([1, 2, 3]),
            body_version: 4,
            book_id: Some("0192a6f0-0000-7000-8000-0000000000b1".into()),
            book_hlc: "0001728000000001-0000-node".into(),
            status: "active".into(),
            status_hlc: "0001728000000002-0000-node".into(),
            pinned: true,
            pinned_hlc: "0001728000000003-0000-node".into(),
            created_at: 1,
            updated_at: 2,
            deleted_at: None,
            deleted_hlc: None,
        }
    }

    #[test]
    fn accepts_a_valid_note_and_round_trips_through_the_dto() {
        let record = dto().into_record().unwrap();
        assert_eq!(record.ydoc, vec![1, 2, 3]);
        assert_eq!(record.body_version, 4);
        assert_eq!(NoteDto::from(record), dto());
        // The largest version a write may be based on.
        let last = NoteDto {
            body_version: MAX_BODY_VERSION - 1,
            ..dto()
        };
        assert!(last.into_record().is_ok());
    }

    #[test]
    fn rejects_ids_that_are_not_canonical_uuidv7() {
        for id in [
            "",
            "not-a-uuid",
            "0192A6F0-0000-7000-8000-000000000001",
            "0192a6f0-0000-4000-8000-000000000001",
            "0192a6f000007000800000000000000001",
        ] {
            assert!(!valid_note_id(id), "{id} should be rejected");
        }
        assert!(valid_note_id(ID));
    }

    /// The Templates notebook's reserved ID (TEMPLATES_BOOK_ID in
    /// src/core/books.ts; a policy test checks they match) is accepted as a
    /// note's notebook and in search conditions.
    #[test]
    fn accepts_the_templates_notebook_id() {
        const TEMPLATES_BOOK_ID: &str = "00000000-0000-7000-8000-000000000001";
        assert!(valid_note_id(TEMPLATES_BOOK_ID));
        let note = NoteDto {
            book_id: Some(TEMPLATES_BOOK_ID.into()),
            book_hlc: "0001728000000000-0000-node".into(),
            ..dto()
        };
        assert!(note.into_record().is_ok());
    }

    #[test]
    fn accepts_only_note_ids_as_links() {
        let id = "0192a6f0-0000-7000-8000-00000000000a".to_string();
        assert_eq!(validate_links(&[]), Ok(()));
        assert_eq!(validate_links(std::slice::from_ref(&id)), Ok(()));
        assert_eq!(
            validate_links(&["../etc".into()]),
            Err("E_NOTE_LINK_INVALID")
        );
        assert_eq!(
            validate_links(&vec![id; MAX_LINKS + 1]),
            Err("E_NOTE_LINKS_TOO_MANY")
        );
    }

    #[test]
    fn rejects_bad_fields() {
        type Case = (fn(&mut NoteDto), &'static str);
        let cases: [Case; 15] = [
            (|n| n.status = "urgent".into(), "E_NOTE_STATUS_INVALID"),
            (
                |n| n.pinned_hlc = "bad hlc ".repeat(20),
                "E_NOTE_HLC_INVALID",
            ),
            (|n| n.book_id = Some("../x".into()), "E_NOTE_BOOK_INVALID"),
            (|n| n.book_hlc = String::new(), "E_NOTE_HLC_INVALID"),
            (|n| n.book_hlc = "x".repeat(65), "E_NOTE_HLC_INVALID"),
            (|n| n.title = "a\nb".into(), "E_NOTE_TITLE_INVALID"),
            (|n| n.title = "a\rb".into(), "E_NOTE_TITLE_INVALID"),
            (|n| n.title = "x".repeat(1_001), "E_NOTE_TITLE_INVALID"),
            (|n| n.title_hlc = String::new(), "E_NOTE_HLC_INVALID"),
            (|n| n.updated_at = 0, "E_NOTE_TIME_INVALID"),
            (|n| n.ydoc = "%%%".into(), "E_NOTE_YDOC_INVALID"),
            (|n| n.ydoc = String::new(), "E_NOTE_YDOC_INVALID"),
            (|n| n.body_version = -1, "E_NOTE_VERSION_INVALID"),
            // Storage could not move it on to a version JavaScript holds exactly.
            (
                |n| n.body_version = MAX_BODY_VERSION,
                "E_NOTE_VERSION_INVALID",
            ),
            (|n| n.body_version = i64::MAX, "E_NOTE_VERSION_INVALID"),
        ];
        for (mutate, code) in cases {
            let mut note = dto();
            mutate(&mut note);
            assert_eq!(note.into_record().unwrap_err(), code);
        }
    }

    fn query(json: serde_json::Value) -> NoteQuery {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn reads_a_search_query_from_the_core() {
        let q = query(serde_json::json!({
            "text": [{ "field": "title", "value": "plan", "negate": true }],
            "sets": [{ "kind": "status", "ids": ["on_hold"], "negate": false }],
            "pinned": true,
        }));
        assert_eq!(validate_query(&q), Ok(()));
        let bad: Result<NoteQuery, _> = serde_json::from_value(serde_json::json!({
            "text": [{ "field": "everywhere", "value": "x", "negate": false }],
            "sets": [],
            "pinned": false,
        }));
        assert!(bad.is_err(), "unknown fields are refused");
    }

    #[test]
    fn validates_search_queries() {
        let text =
            |value: &str| serde_json::json!({ "field": "any", "value": value, "negate": false });
        let set = |kind: &str, ids: &[&str]| serde_json::json!({ "kind": kind, "ids": ids, "negate": true });
        let check = |text: Vec<serde_json::Value>, sets: Vec<serde_json::Value>| {
            validate_query(&query(
                serde_json::json!({ "text": text, "sets": sets, "pinned": false }),
            ))
        };
        assert_eq!(check(vec![text("sync"), text("a b")], vec![]), Ok(()));
        assert_eq!(check(vec![], vec![]), Ok(()), "an empty query lists notes");
        assert_eq!(
            check(vec![text(" padded ")], vec![set("book", &[ID])]),
            Ok(())
        );
        assert_eq!(
            check(vec![text("x"); 13], vec![]),
            Err("E_SEARCH_TERMS_INVALID")
        );
        assert_eq!(
            check(vec![text("x"); 6], vec![set("status", &["none"]); 7]),
            Err("E_SEARCH_TERMS_INVALID")
        );
        assert_eq!(check(vec![text("")], vec![]), Err("E_SEARCH_TERM_INVALID"));
        assert_eq!(
            check(vec![text(&"x".repeat(101))], vec![]),
            Err("E_SEARCH_TERM_INVALID")
        );
        assert_eq!(
            check(vec![], vec![set("tag", &[])]),
            Err("E_SEARCH_IDS_INVALID")
        );
        assert_eq!(
            check(vec![], vec![set("tag", &["../x"])]),
            Err("E_SEARCH_IDS_INVALID")
        );
        assert_eq!(
            check(vec![], vec![set("status", &["urgent"])]),
            Err("E_SEARCH_IDS_INVALID")
        );
        assert_eq!(
            check(vec![], vec![set("book", &["active"])]),
            Err("E_SEARCH_IDS_INVALID")
        );
        assert_eq!(
            check(vec![], vec![set("book", &[ID; MAX_SEARCH_IDS + 1])]),
            Err("E_SEARCH_IDS_INVALID")
        );
    }

    #[test]
    fn validates_purge_arguments() {
        assert_eq!(validate_purge(ID, 1, "0001728000000000-0000-node"), Ok(()));
        assert_eq!(
            validate_purge("x", 1, "0001728000000000-0000-node"),
            Err("E_NOTE_ID_INVALID")
        );
        assert_eq!(
            validate_purge(ID, -1, "0001728000000000-0000-node"),
            Err("E_NOTE_TIME_INVALID")
        );
        assert_eq!(validate_purge(ID, 1, ""), Err("E_NOTE_HLC_INVALID"));
    }

    /// The core cuts titles to MAX_TITLE_CHARS code points (MAX_TITLE_CHARS
    /// in src/core/noteLimits.ts; a policy test checks they match): a title
    /// of that many characters outside the Basic Multilingual Plane, two
    /// UTF-16 units each, is taken.
    #[test]
    fn counts_a_title_in_characters() {
        let longest = NoteDto {
            title: "\u{1F600}".repeat(MAX_TITLE_CHARS),
            ..dto()
        };
        assert!(longest.into_record().is_ok());
        let longer = NoteDto {
            title: "\u{1F600}".repeat(MAX_TITLE_CHARS + 1),
            ..dto()
        };
        assert_eq!(longer.into_record().unwrap_err(), "E_NOTE_TITLE_INVALID");
    }

    #[test]
    fn accepts_a_note_in_no_notebook() {
        let mut note = dto();
        note.book_id = None;
        note.book_hlc = String::new();
        assert!(note.into_record().is_ok());
    }
}
