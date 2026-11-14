use super::authorship::validate_agent_writes;
use crate::storage::{
    AgentWriteRow, Db, LinkGraph, NOTE_STATUSES, NoteBody, NoteMeta, NoteQuery, NoteRecord,
    NoteSummary, SetKind, TrashedNote, Write,
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::{InvokeBody, Request};

pub(crate) const MAX_TITLE_CHARS: usize = 1_000;
pub(crate) const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_YDOC_BYTES: usize = 64 * 1024 * 1024;
/// Matches MAX_NOTE_LINKS in src/core/links.ts, which the AI service checks before it writes.
const MAX_LINKS: usize = 10_000;
/// The largest whole number JavaScript holds exactly, so the version storage moves a write on to stays exact in the core. Matches MAX_BODY_VERSION in src/core/noteLimits.ts.
const MAX_BODY_VERSION: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub title: String,
    pub title_hlc: String,
    pub body_md: String,
    pub ydoc: String,
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
    /// Empty when the dates were never set by hand.
    #[serde(default)]
    pub dates_hlc: String,
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
            dates_hlc: note.dates_hlc,
            deleted_at: note.deleted_at,
            deleted_hlc: note.deleted_hlc,
        }
    }
}

pub(crate) fn valid_note_id(id: &str) -> bool {
    uuid::Uuid::try_parse(id)
        .is_ok_and(|u| u.get_version_num() == 7 && u.hyphenated().to_string() == id)
}

/// The core's shape (`parseHlc` in src/core/hlc.ts): `<16-digit wall ms>-<4 hex counter>-<node>`.
/// Storage orders stamps as text, so a stamp of any other shape could win every later merge.
pub(crate) fn valid_hlc(hlc: &str) -> bool {
    const MAX_WALL: u64 = 8_640_000_000_000_000;
    let mut parts = hlc.splitn(3, '-');
    let (Some(wall), Some(counter), Some(node)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    wall.len() == 16
        && wall.bytes().all(|b| b.is_ascii_digit())
        && wall.parse::<u64>().is_ok_and(|w| w <= MAX_WALL)
        && counter.len() == 4
        && counter
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && (1..=32).contains(&node.len())
        && node.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'z'))
}

/// A note's fields without its body: what `note_put_meta` takes, and the fields of a `note_put` frame.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetaDto {
    pub id: String,
    pub title: String,
    pub title_hlc: String,
    pub body_version: i64,
    pub book_id: Option<String>,
    pub book_hlc: String,
    pub status: String,
    pub status_hlc: String,
    pub pinned: bool,
    pub pinned_hlc: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub dates_hlc: String,
    pub deleted_at: Option<i64>,
    pub deleted_hlc: Option<String>,
}

impl NoteMetaDto {
    fn into_meta(self) -> Result<NoteMeta, &'static str> {
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
        if !optional_hlc(&self.status_hlc)
            || !optional_hlc(&self.pinned_hlc)
            || !optional_hlc(&self.dates_hlc)
        {
            return Err("E_NOTE_HLC_INVALID");
        }
        if self.created_at < 0 || self.updated_at < self.created_at {
            return Err("E_NOTE_TIME_INVALID");
        }
        if !(0..MAX_BODY_VERSION).contains(&self.body_version) {
            return Err("E_NOTE_VERSION_INVALID");
        }
        Ok(NoteMeta {
            id: self.id,
            title: self.title,
            title_hlc: self.title_hlc,
            body_version: self.body_version,
            book_id: self.book_id,
            book_hlc: self.book_hlc,
            status: self.status,
            status_hlc: self.status_hlc,
            pinned: self.pinned,
            pinned_hlc: self.pinned_hlc,
            created_at: self.created_at,
            updated_at: self.updated_at,
            dates_hlc: self.dates_hlc,
            deleted_at: self.deleted_at,
            deleted_hlc: self.deleted_hlc,
        })
    }
}

fn valid_record(
    meta: NoteMeta,
    body_md: String,
    ydoc: Vec<u8>,
) -> Result<NoteRecord, &'static str> {
    if body_md.len() > MAX_BODY_BYTES {
        return Err("E_NOTE_BODY_TOO_LARGE");
    }
    if ydoc.is_empty() || ydoc.len() > MAX_YDOC_BYTES {
        return Err("E_NOTE_YDOC_INVALID");
    }
    Ok(NoteRecord::from_meta(meta, body_md, ydoc))
}

/// The JSON part of a `note_put` frame.
#[derive(Deserialize)]
struct FrameFields {
    note: NoteMetaDto,
    links: Vec<String>,
    writes: Option<Vec<AgentWriteRow>>,
}

/// A length (4 bytes, little-endian) and that many bytes, then the rest.
fn framed_part(data: &[u8]) -> Option<(&[u8], &[u8])> {
    let (length, rest) = data.split_first_chunk::<4>()?;
    let length = usize::try_from(u32::from_le_bytes(*length)).ok()?;
    (length <= rest.len()).then(|| rest.split_at(length))
}

/// What a `note_put` frame carries: the note, the note IDs its body links to and its agent_writes rows.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct NoteFrame {
    pub record: NoteRecord,
    pub links: Vec<String>,
    pub writes: Option<Vec<AgentWriteRow>>,
}

/// A note as `noteFrame` in src/renderer/src/storage/wire.ts lays it out: the length of the JSON of
/// its fields, its links and its agent_writes rows (4 bytes, little-endian), that JSON, the length
/// of its body, the body as UTF-8, then its Yjs state.
pub(crate) fn note_frame(data: &[u8]) -> Result<NoteFrame, &'static str> {
    const INVALID: &str = "E_NOTE_FRAME_INVALID";
    let (json, rest) = framed_part(data).ok_or(INVALID)?;
    let (body, ydoc) = framed_part(rest).ok_or(INVALID)?;
    let fields: FrameFields = serde_json::from_slice(json).map_err(|_| INVALID)?;
    if body.len() > MAX_BODY_BYTES {
        return Err("E_NOTE_BODY_TOO_LARGE");
    }
    let body_md = std::str::from_utf8(body).map_err(|_| INVALID)?.to_owned();
    let meta = fields.note.into_meta()?;
    Ok(NoteFrame {
        record: valid_record(meta, body_md, ydoc.to_vec())?,
        links: fields.links,
        writes: fields.writes,
    })
}

fn validate_list_page(exclude_book_id: Option<&str>) -> Result<(), &'static str> {
    if exclude_book_id.is_some_and(|id| !valid_note_id(id)) {
        return Err("E_BOOK_ID_INVALID");
    }
    Ok(())
}

/// Every live note, or with `exclude_book_id` and `limit` a page of them (see `list_notes_page`).
#[tauri::command]
pub async fn notes_list(
    db: State<'_, Db>,
    exclude_book_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<NoteSummary>, String> {
    validate_list_page(exclude_book_id.as_deref()).map_err(String::from)?;
    db.call(move |store| store.list_notes_page(exclude_book_id.as_deref(), limit))
        .await
        .map_err(|e| e.to_string())
}

/// List rows of many notes in one call (at most MAX_BODY_IDS), the live ones of `ids`.
#[tauri::command]
pub async fn notes_summaries(
    db: State<'_, Db>,
    ids: Vec<String>,
) -> Result<Vec<NoteSummary>, String> {
    validate_body_ids(&ids).map_err(String::from)?;
    db.call(move |store| store.get_summaries(&ids))
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

/// A note's fields as `note_open` sends them: all but the body and the Yjs state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedFields<'a> {
    id: &'a str,
    title: &'a str,
    title_hlc: &'a str,
    body_version: i64,
    book_id: Option<&'a str>,
    book_hlc: &'a str,
    status: &'a str,
    status_hlc: &'a str,
    pinned: bool,
    pinned_hlc: &'a str,
    created_at: i64,
    updated_at: i64,
    dates_hlc: &'a str,
    deleted_at: Option<i64>,
    deleted_hlc: Option<&'a str>,
}

/// `note_open`'s answer, read by `openedNote` in src/renderer/src/storage/wire.ts: empty for a
/// note not stored, otherwise the length of the fields' JSON (4 bytes, little-endian), the JSON,
/// then the Yjs state as stored.
pub(crate) fn opened_frame(note: Option<&NoteRecord>) -> Vec<u8> {
    let Some(note) = note else {
        return Vec::new();
    };
    let fields = serde_json::to_vec(&OpenedFields {
        id: &note.id,
        title: &note.title,
        title_hlc: &note.title_hlc,
        body_version: note.body_version,
        book_id: note.book_id.as_deref(),
        book_hlc: &note.book_hlc,
        status: &note.status,
        status_hlc: &note.status_hlc,
        pinned: note.pinned,
        pinned_hlc: &note.pinned_hlc,
        created_at: note.created_at,
        updated_at: note.updated_at,
        dates_hlc: &note.dates_hlc,
        deleted_at: note.deleted_at,
        deleted_hlc: note.deleted_hlc.as_deref(),
    })
    .unwrap_or_default();
    // The fields hold a title within MAX_TITLE_CHARS and short stamps, far below 4 GiB.
    let length = u32::try_from(fields.len()).unwrap_or(u32::MAX);
    let mut frame = Vec::with_capacity(4 + fields.len() + note.ydoc.len());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(&fields);
    frame.extend_from_slice(&note.ydoc);
    frame
}

/// A note out of the Trash for its editor, as bytes rather than JSON, and without its body: the
/// core reads that from the Yjs state it builds the note from (see `opened_frame`).
#[tauri::command]
pub async fn note_open(db: State<'_, Db>, id: String) -> Result<tauri::ipc::Response, String> {
    if !valid_note_id(&id) {
        return Err("E_NOTE_ID_INVALID".into());
    }
    db.call(move |store| store.open_note(&id))
        .await
        .map(|note| tauri::ipc::Response::new(opened_frame(note.as_ref())))
        .map_err(|e| e.to_string())
}

/// MAX_BODY_IDS in src/core/storage.ts (a policy test checks they match).
const MAX_BODY_IDS: usize = 500;

pub(crate) fn validate_body_ids(ids: &[String]) -> Result<(), &'static str> {
    if ids.len() > MAX_BODY_IDS {
        return Err("E_NOTE_IDS_TOO_MANY");
    }
    if !ids.iter().all(|id| valid_note_id(id)) {
        return Err("E_NOTE_ID_INVALID");
    }
    Ok(())
}

/// List rows' text for many notes in one call, without their Yjs state.
#[tauri::command]
pub async fn notes_bodies(db: State<'_, Db>, ids: Vec<String>) -> Result<Vec<NoteBody>, String> {
    validate_body_ids(&ids).map_err(String::from)?;
    db.call(move |store| store.get_bodies(&ids))
        .await
        .map_err(|e| e.to_string())
}

/// The note as a raw frame (`note_frame`), so a note of several MiB crosses with no JSON or base64
/// work on the UI thread. The frame names the note IDs the body links to, for the link index, and
/// the note's rows of the agent_writes index, derived from its Yjs state (`null` leaves the stored
/// rows alone).
#[tauri::command]
pub async fn note_put(db: State<'_, Db>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("E_NOTE_FRAME_INVALID".into());
    };
    put_frame(&db, note_frame(data).map_err(String::from)?).await
}

/// A save that changed no text: the fields alone (`Store::put_note_meta`), with the note's
/// agent_writes rows when they changed.
#[tauri::command]
pub async fn note_put_meta(
    db: State<'_, Db>,
    note: NoteMetaDto,
    writes: Option<Vec<AgentWriteRow>>,
) -> Result<(), String> {
    let meta = note.into_meta().map_err(String::from)?;
    if let Some(rows) = &writes {
        validate_agent_writes(rows).map_err(String::from)?;
    }
    put_meta(&db, meta, writes).await
}

/// A save of the fields alone edits a note already stored, unless it brings the note back from
/// the Trash, which the gate counts as content.
pub(crate) async fn put_meta(
    db: &Db,
    meta: NoteMeta,
    writes: Option<Vec<AgentWriteRow>>,
) -> Result<(), String> {
    let (id, deleted_at, deleted_hlc) =
        (meta.id.clone(), meta.deleted_at, meta.deleted_hlc.clone());
    db.write_judged(
        &[Write::Body, Write::Content],
        move |store| {
            Ok(
                if store.restores_note(&id, deleted_at, deleted_hlc.as_deref())? {
                    Write::Content
                } else {
                    Write::Body
                },
            )
        },
        move |store| store.put_note_meta(&meta, writes.as_deref()),
    )
    .await
    .map_err(|e| e.to_string())
}

/// A note's first save, or one that brings it back from the Trash, creates user content; only a
/// save of a note already stored is a body edit, which the gate still lets land for a short grace
/// after editing ends.
pub(crate) async fn put_frame(
    db: &Db,
    NoteFrame {
        record,
        links,
        writes,
    }: NoteFrame,
) -> Result<(), String> {
    validate_links(&links).map_err(String::from)?;
    if let Some(rows) = &writes {
        validate_agent_writes(rows).map_err(String::from)?;
    }
    let (id, deleted_at, deleted_hlc) = (
        record.id.clone(),
        record.deleted_at,
        record.deleted_hlc.clone(),
    );
    db.write_judged(
        &[Write::Body, Write::Content],
        move |store| {
            Ok(
                if store.has_note(&id)?
                    && !store.restores_note(&id, deleted_at, deleted_hlc.as_deref())?
                {
                    Write::Body
                } else {
                    Write::Content
                },
            )
        },
        move |store| store.put_note_with_writes(&record, &links, writes.as_deref()),
    )
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

/// The core sends at most 10 clauses of a query (MAX_SEARCH_TERMS in src/core/search.ts) plus two for the current view.
const MAX_SEARCH_CONDITIONS: usize = 12;
const MAX_TERM_CHARS: usize = 100;
const MAX_SEARCH_IDS: usize = 10_000;
/// One more than the list shows (SEARCH_LIMIT in src/core/search.ts), so the core can tell a capped search.
const MAX_SEARCH_LIMIT: u32 = 201;

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

fn validate_search_limit(limit: u32) -> Result<(), &'static str> {
    if (1..=MAX_SEARCH_LIMIT).contains(&limit) {
        Ok(())
    } else {
        Err("E_SEARCH_LIMIT_INVALID")
    }
}

#[tauri::command]
pub async fn notes_search(
    db: State<'_, Db>,
    query: NoteQuery,
    limit: u32,
) -> Result<Vec<NoteSummary>, String> {
    validate_query(&query).map_err(String::from)?;
    validate_search_limit(limit).map_err(String::from)?;
    db.call(move |store| store.search_notes(&query, limit))
        .await
        .map_err(|e| e.to_string())
}

/// Matches MAX_BACKLINKS in src/core/links.ts.
const MAX_BACKLINKS: u32 = 200;

fn validate_backlinks(id: &str, exclude_book_id: &str, limit: u32) -> Result<(), &'static str> {
    if !valid_note_id(id) {
        return Err("E_NOTE_ID_INVALID");
    }
    if !valid_note_id(exclude_book_id) {
        return Err("E_BOOK_ID_INVALID");
    }
    if !(1..=MAX_BACKLINKS).contains(&limit) {
        return Err("E_BACKLINKS_LIMIT_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn note_backlinks(
    db: State<'_, Db>,
    id: String,
    exclude_book_id: String,
    limit: u32,
) -> Result<Vec<NoteSummary>, String> {
    validate_backlinks(&id, &exclude_book_id, limit).map_err(String::from)?;
    db.call(move |store| store.list_backlinks(&id, &exclude_book_id, limit))
        .await
        .map_err(|e| e.to_string())
}

/// Matches MAX_GRAPH_LINKS in src/core/graph.ts.
const MAX_GRAPH_LINKS: u32 = 20_000;

fn validate_link_graph(exclude_book_id: &str, limit: u32) -> Result<(), &'static str> {
    if !valid_note_id(exclude_book_id) {
        return Err("E_BOOK_ID_INVALID");
    }
    if !(1..=MAX_GRAPH_LINKS).contains(&limit) {
        return Err("E_GRAPH_LIMIT_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn note_link_graph(
    db: State<'_, Db>,
    exclude_book_id: String,
    limit: u32,
) -> Result<LinkGraph, String> {
    validate_link_graph(&exclude_book_id, limit).map_err(String::from)?;
    db.call(move |store| store.link_graph(&exclude_book_id, limit))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_trash_list(db: State<'_, Db>) -> Result<Vec<TrashedNote>, String> {
    db.call(|store| store.list_trash())
        .await
        .map_err(|e| e.to_string())
}

pub(crate) fn validate_purge(id: &str, at: i64, hlc: &str) -> Result<(), &'static str> {
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
    db.write(Write::Content, move |store| store.purge_note(&id, at, &hlc))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192a6f0-0000-7000-8000-000000000001";

    #[derive(Deserialize)]
    struct Stamps {
        valid: Vec<String>,
        invalid: Vec<String>,
    }

    #[test]
    fn takes_the_stamps_the_core_takes_and_no_others() {
        let stamps: Stamps =
            serde_json::from_str(include_str!("../../tests/fixtures/hlc-stamps.json")).unwrap();
        let refused: Vec<&String> = stamps.valid.iter().filter(|s| !valid_hlc(s)).collect();
        assert!(refused.is_empty(), "{refused:?}");
        let taken: Vec<&String> = stamps.invalid.iter().filter(|s| valid_hlc(s)).collect();
        assert!(taken.is_empty(), "{taken:?}");
    }

    /// The record `note_put` writes for `note`, its fields checked as a frame's are.
    fn into_record(note: NoteDto) -> Result<NoteRecord, &'static str> {
        let fields: NoteMetaDto =
            serde_json::from_value(serde_json::to_value(&note).unwrap()).unwrap();
        let ydoc = STANDARD.decode(note.ydoc.as_bytes()).unwrap();
        valid_record(fields.into_meta()?, note.body_md, ydoc)
    }

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
            dates_hlc: "0001728000000004-0000-node".into(),
            deleted_at: None,
            deleted_hlc: None,
        }
    }

    #[test]
    fn opens_a_note_as_its_fields_and_state_without_the_body() {
        assert!(opened_frame(None).is_empty());
        let record = into_record(dto()).unwrap();
        let frame = opened_frame(Some(&record));
        let length = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
        let fields: serde_json::Value = serde_json::from_slice(&frame[4..4 + length]).unwrap();
        assert_eq!(&frame[4 + length..], &[1, 2, 3]);
        let mut expected = serde_json::to_value(dto()).unwrap();
        let map = expected.as_object_mut().unwrap();
        map.remove("bodyMd");
        map.remove("ydoc");
        assert_eq!(fields, expected);
    }

    #[test]
    fn accepts_a_valid_note_and_round_trips_through_the_dto() {
        let record = into_record(dto()).unwrap();
        assert_eq!(record.ydoc, vec![1, 2, 3]);
        assert_eq!(record.body_version, 4);
        assert_eq!(NoteDto::from(record), dto());
        let last = NoteDto {
            body_version: MAX_BODY_VERSION - 1,
            ..dto()
        };
        assert!(into_record(last).is_ok());
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

    #[test]
    fn takes_backlinks_of_a_note_outside_a_notebook_up_to_a_page() {
        const TEMPLATES: &str = "00000000-0000-7000-8000-000000000001";
        assert_eq!(validate_backlinks(ID, TEMPLATES, 1), Ok(()));
        assert_eq!(validate_backlinks(ID, TEMPLATES, MAX_BACKLINKS), Ok(()));
        assert_eq!(
            validate_backlinks("note", TEMPLATES, 1),
            Err("E_NOTE_ID_INVALID")
        );
        assert_eq!(
            validate_backlinks(ID, "' OR 1 --", 1),
            Err("E_BOOK_ID_INVALID")
        );
        for limit in [0, MAX_BACKLINKS + 1] {
            assert_eq!(
                validate_backlinks(ID, TEMPLATES, limit),
                Err("E_BACKLINKS_LIMIT_INVALID")
            );
        }
    }

    #[test]
    fn takes_the_link_graph_outside_a_notebook_up_to_its_limit() {
        const TEMPLATES: &str = "00000000-0000-7000-8000-000000000001";
        assert_eq!(validate_link_graph(TEMPLATES, 1), Ok(()));
        assert_eq!(validate_link_graph(TEMPLATES, MAX_GRAPH_LINKS), Ok(()));
        assert_eq!(
            validate_link_graph("' OR 1 --", 1),
            Err("E_BOOK_ID_INVALID")
        );
        for limit in [0, MAX_GRAPH_LINKS + 1] {
            assert_eq!(
                validate_link_graph(TEMPLATES, limit),
                Err("E_GRAPH_LIMIT_INVALID")
            );
        }
    }

    #[test]
    fn lists_a_page_outside_a_notebook_given_by_a_valid_id() {
        assert_eq!(validate_list_page(None), Ok(()));
        assert_eq!(
            validate_list_page(Some("00000000-0000-7000-8000-000000000001")),
            Ok(())
        );
        assert_eq!(
            validate_list_page(Some("' OR 1 --")),
            Err("E_BOOK_ID_INVALID")
        );
    }

    /// TEMPLATES_BOOK_ID in src/core/books.ts (a policy test checks they match).
    #[test]
    fn accepts_the_templates_notebook_id() {
        const TEMPLATES_BOOK_ID: &str = "00000000-0000-7000-8000-000000000001";
        assert!(valid_note_id(TEMPLATES_BOOK_ID));
        let note = NoteDto {
            book_id: Some(TEMPLATES_BOOK_ID.into()),
            book_hlc: "0001728000000000-0000-node".into(),
            ..dto()
        };
        assert!(into_record(note).is_ok());
    }

    /// What a list's rows cost to read at 10,000 notes: 200 rows as one `note_get` each (the
    /// Yjs state in base64 included) against one `notes_bodies`. Run it with
    /// `cargo test --lib list_rows_read_cost -- --ignored --nocapture`.
    #[test]
    #[ignore = "a measurement, not a check"]
    fn list_rows_read_cost() {
        use crate::storage::Store;
        use std::time::Instant;
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("devot.sqlite")).unwrap();
        let body = "A paragraph of a note, long enough to read like one. ".repeat(30);
        let ids: Vec<String> = (0..10_000)
            .map(|n| format!("0192a6f0-0000-7000-8000-{n:012}"))
            .collect();
        for (n, id) in ids.iter().enumerate() {
            let record = NoteRecord {
                id: id.clone(),
                title: format!("Note {n}"),
                body_md: body.clone(),
                // A body's Yjs state with no edit history is about as long as its text.
                ydoc: body.as_bytes().to_vec(),
                ..into_record(dto()).unwrap()
            };
            store.put_note(&record, &[]).unwrap();
        }
        let rows: Vec<String> = ids.iter().step_by(50).cloned().collect();
        assert_eq!(rows.len(), 200);
        let best = |run: &dyn Fn() -> usize| {
            let mut bytes = 0;
            let mut fastest = f64::MAX;
            for _ in 0..5 {
                let start = Instant::now();
                bytes = run();
                fastest = fastest.min(start.elapsed().as_secs_f64() * 1000.0);
            }
            (fastest, bytes)
        };
        let (single_ms, single_bytes) = best(&|| {
            rows.iter()
                .map(|id| {
                    let note = store.get_note(id, true).unwrap().map(NoteDto::from);
                    serde_json::to_vec(&note).unwrap().len()
                })
                .sum()
        });
        let (batched_ms, batched_bytes) = best(&|| {
            serde_json::to_vec(&store.get_bodies(&rows).unwrap())
                .unwrap()
                .len()
        });
        println!(
            "200 rows at 10,000 notes: note_get x200 {single_ms:.2} ms, {single_bytes} B; \
             notes_bodies x1 {batched_ms:.2} ms, {batched_bytes} B"
        );
    }

    #[test]
    fn accepts_a_bounded_list_of_note_ids_for_bodies() {
        let id = "0192a6f0-0000-7000-8000-00000000000a".to_string();
        assert_eq!(validate_body_ids(&[]), Ok(()));
        assert_eq!(validate_body_ids(&vec![id.clone(); MAX_BODY_IDS]), Ok(()));
        assert_eq!(
            validate_body_ids(&vec![id; MAX_BODY_IDS + 1]),
            Err("E_NOTE_IDS_TOO_MANY")
        );
        assert_eq!(
            validate_body_ids(&["../etc".into()]),
            Err("E_NOTE_ID_INVALID")
        );
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

    fn frame(fields: &serde_json::Value, body: &[u8], ydoc: &[u8]) -> Vec<u8> {
        let json = serde_json::to_vec(fields).unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(&u32::try_from(json.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&json);
        out.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(ydoc);
        out
    }

    fn frame_fields() -> serde_json::Value {
        let mut note = serde_json::to_value(dto()).unwrap();
        let fields = note.as_object_mut().unwrap();
        fields.remove("bodyMd");
        fields.remove("ydoc");
        serde_json::json!({ "note": note, "links": [ID], "writes": null })
    }

    #[test]
    fn reads_a_note_frame_as_the_record_note_put_writes() {
        let read = note_frame(&frame(
            &frame_fields(),
            "# T\u{e9}\n".as_bytes(),
            &[1, 2, 3],
        ))
        .unwrap();
        let expected = NoteFrame {
            record: NoteRecord {
                body_md: "# T\u{e9}\n".into(),
                ydoc: vec![1, 2, 3],
                ..into_record(dto()).unwrap()
            },
            links: vec![ID.to_owned()],
            writes: None,
        };
        assert_eq!(read, expected);
    }

    #[test]
    fn refuses_a_malformed_note_frame() {
        let good = frame(&frame_fields(), b"body", &[1, 2, 3]);
        let json_len = serde_json::to_vec(&frame_fields()).unwrap().len();
        let mut bad_fields = frame_fields();
        bad_fields["note"]["status"] = "urgent".into();
        let cases: [(Vec<u8>, &str); 8] = [
            (Vec::new(), "E_NOTE_FRAME_INVALID"),
            (good[..3].to_vec(), "E_NOTE_FRAME_INVALID"),
            // A length past the end.
            (
                [&[255, 255, 255, 0], &good[4..]].concat(),
                "E_NOTE_FRAME_INVALID",
            ),
            // No length of the body.
            (good[..4 + json_len].to_vec(), "E_NOTE_FRAME_INVALID"),
            (
                frame(&serde_json::json!({ "note": 1 }), b"", &[1]),
                "E_NOTE_FRAME_INVALID",
            ),
            (
                frame(&frame_fields(), &[0xff, 0xfe], &[1]),
                "E_NOTE_FRAME_INVALID",
            ),
            (frame(&frame_fields(), b"body", &[]), "E_NOTE_YDOC_INVALID"),
            (frame(&bad_fields, b"body", &[1]), "E_NOTE_STATUS_INVALID"),
        ];
        for (data, code) in cases {
            assert_eq!(note_frame(&data).unwrap_err(), code);
        }
    }

    #[test]
    fn rejects_bad_fields() {
        type Case = (fn(&mut NoteDto), &'static str);
        let cases: [Case; 15] = [
            (|n| n.status = "urgent".into(), "E_NOTE_STATUS_INVALID"),
            (|n| n.dates_hlc = "x".repeat(65), "E_NOTE_HLC_INVALID"),
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
            assert_eq!(into_record(note).unwrap_err(), code);
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
    fn reads_pinned_as_null_true_or_false() {
        let pinned = |value: serde_json::Value| {
            query(serde_json::json!({ "text": [], "sets": [], "pinned": value })).pinned
        };
        assert_eq!(pinned(serde_json::Value::Null), None);
        assert_eq!(pinned(serde_json::json!(true)), Some(true));
        assert_eq!(pinned(serde_json::json!(false)), Some(false));
        let wrong: Result<NoteQuery, _> =
            serde_json::from_value(serde_json::json!({ "text": [], "sets": [], "pinned": "yes" }));
        assert!(wrong.is_err(), "pinned is a boolean or null");
    }

    #[test]
    fn validates_search_queries() {
        let text =
            |value: &str| serde_json::json!({ "field": "any", "value": value, "negate": false });
        let set = |kind: &str, ids: &[&str]| serde_json::json!({ "kind": kind, "ids": ids, "negate": true });
        let check = |text: Vec<serde_json::Value>, sets: Vec<serde_json::Value>| {
            validate_query(&query(
                serde_json::json!({ "text": text, "sets": sets, "pinned": null }),
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
    fn validates_the_search_limit() {
        assert_eq!(validate_search_limit(1), Ok(()));
        assert_eq!(validate_search_limit(MAX_SEARCH_LIMIT), Ok(()));
        assert_eq!(validate_search_limit(0), Err("E_SEARCH_LIMIT_INVALID"));
        assert_eq!(
            validate_search_limit(MAX_SEARCH_LIMIT + 1),
            Err("E_SEARCH_LIMIT_INVALID")
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

    /// The core cuts titles to MAX_TITLE_CHARS code points (src/core/noteLimits.ts; a policy test checks they match). Astral characters count two UTF-16 units each.
    #[test]
    fn counts_a_title_in_characters() {
        let longest = NoteDto {
            title: "\u{1F600}".repeat(MAX_TITLE_CHARS),
            ..dto()
        };
        assert!(into_record(longest).is_ok());
        let longer = NoteDto {
            title: "\u{1F600}".repeat(MAX_TITLE_CHARS + 1),
            ..dto()
        };
        assert_eq!(into_record(longer).unwrap_err(), "E_NOTE_TITLE_INVALID");
    }

    #[test]
    fn accepts_a_note_in_no_notebook() {
        let mut note = dto();
        note.book_id = None;
        note.book_hlc = String::new();
        assert!(into_record(note).is_ok());
    }
}
