//! The envelope of the iPhone screens' bridge (docs/specs/iphone-screens.md, Message envelope).
//! Swift sends requests; the page sends replies and notices; Rust checks each one here before it
//! passes it on, and what it passes on is the checked message written out again.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::direct;
use crate::commands::notes::{MAX_TITLE_CHARS, valid_hlc, valid_note_id};
use crate::storage::NOTE_STATUSES;

pub const VERSION: u64 = 1;
/// The store bridge's reply limit (`STORE_REPLY_LIMIT`).
pub const MAX_MESSAGE_BYTES: usize = 4 << 20;
/// The rows a list shows at once, with room to spare.
const MAX_EXCERPT_IDS: usize = 60;
const MAX_CHANGED_IDS: usize = 10_000;
/// A multiple selection: every row of a long list.
const MAX_BATCH_IDS: usize = 10_000;
/// The core reads at most 10 clauses of at most 100 characters (MAX_SEARCH_TERMS and
/// MAX_TERM_CHARS in src/core/search.ts), each with up to 16 more for a qualifier, a minus, quotes
/// and a space; it never reads a longer query further.
const MAX_QUERY_CHARS: usize = 10 * (100 + 16);
const MAX_CODE_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    All,
    Titles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ids {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Search {
    pub query: String,
    pub scope: Scope,
}

/// A tab of the native tab bar; Search joins when it has a screen of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tab {
    Notes,
    Library,
    Activity,
    Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TabArgs {
    pub tab: Tab,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteCreate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A Settings pane the page still draws under the native Settings, until its native pane lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebPane {
    Appearance,
    Sync,
}

/// A place a web pane opens scrolled to: Sync's pairing, for Pair a device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneAnchor {
    Pairing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShowPane {
    pub pane: WebPane,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<PaneAnchor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteArgs {
    pub note_id: String,
}

/// Where the page may put the caret once Swift asks (`editor.focus`): a new note's body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Focus {
    Body,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShowNote {
    pub note_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<Focus>,
}

/// The editor's two panes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Edit,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModeArgs {
    pub mode: Mode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BookChoice {
    pub book_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusChoice {
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinChoice {
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TagChoice {
    pub tag_id: String,
}

/// `BatchChange` in src/core/batch.ts, less the tag made by name, which the native lists never send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Book(BookChoice),
    Status(StatusChoice),
    Pinned(PinChoice),
    PutTag(TagChoice),
    RemoveTag(TagChoice),
    Trash(Empty),
    Restore(Empty),
    Purge(Empty),
}

/// What taking a completion back needs of the note (`StatusUndo` in src/core/notes/types.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StatusUndo {
    pub status: String,
    pub updated_at: u64,
    pub status_hlc: String,
    pub body_version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UndoStatus {
    pub note_id: String,
    pub undo: StatusUndo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub ids: Vec<String>,
    pub change: Change,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TemplateApply {
    pub template_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_id: Option<String>,
}

/// What Swift may ask the page for: an operation joins with the pull request that first sends it.
/// What Rust answers itself is a `direct::Op`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", content = "args")]
pub enum Op {
    #[serde(rename = "ping")]
    Ping(Empty),
    #[serde(rename = "excerpts")]
    Excerpts(Ids),
    #[serde(rename = "search")]
    Search(Search),
    #[serde(rename = "note.create")]
    NoteCreate(NoteCreate),
    #[serde(rename = "note.discard")]
    NoteDiscard(NoteArgs),
    #[serde(rename = "tabs.show")]
    TabsShow(TabArgs),
    #[serde(rename = "tabs.popToRoot")]
    TabsPopToRoot(TabArgs),
    #[serde(rename = "settings.showPane")]
    SettingsShowPane(ShowPane),
    #[serde(rename = "settings.notebooks")]
    SettingsNotebooks(Empty),
    #[serde(rename = "editor.show")]
    EditorShow(ShowNote),
    #[serde(rename = "editor.prepare")]
    EditorPrepare(NoteArgs),
    #[serde(rename = "editor.hide")]
    EditorHide(Empty),
    #[serde(rename = "editor.setMode")]
    EditorSetMode(ModeArgs),
    #[serde(rename = "editor.info")]
    EditorInfo(Empty),
    #[serde(rename = "editor.focus")]
    EditorFocus(Empty),
    #[serde(rename = "notes.batch")]
    NotesBatch(Batch),
    #[serde(rename = "trash.empty")]
    TrashEmpty(Empty),
    #[serde(rename = "template.create")]
    TemplateCreate(Empty),
    #[serde(rename = "template.apply")]
    TemplateApply(TemplateApply),
    #[serde(rename = "note.text")]
    NoteText(NoteArgs),
    #[serde(rename = "note.complete")]
    NoteComplete(NoteArgs),
    #[serde(rename = "note.undoStatus")]
    NoteUndoStatus(UndoStatus),
}

pub const OPS: &[&str] = &[
    "ping",
    "excerpts",
    "search",
    "note.create",
    "note.discard",
    "tabs.show",
    "tabs.popToRoot",
    "settings.showPane",
    "settings.notebooks",
    "editor.show",
    "editor.prepare",
    "editor.hide",
    "editor.setMode",
    "editor.info",
    "editor.focus",
    "notes.batch",
    "trash.empty",
    "template.create",
    "template.apply",
    "note.text",
    "note.complete",
    "note.undoStatus",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotesChanged {
    pub rev: u64,
    pub ids: Vec<String>,
    /// Sync or another process changed notes the page cannot name: every list reads again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorTitle {
    pub id: String,
    pub title: String,
}

/// What the page shows under the native tab bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TabsState {
    pub tab: Tab,
    pub bar_hidden: bool,
    pub attention: bool,
}

/// A Settings page the page's own sheets open: the License page, its key field first if asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenPane {
    Licence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SettingsOpen {
    pub pane: OpenPane,
    pub focus_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenNote {
    pub note_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EditorMode {
    pub note_id: String,
    pub mode: Mode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EditorScroll {
    pub title_visible: bool,
}

/// New Note in the page's list: Swift's gate decides, then asks `note.create` for this notebook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteNew {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "notice", content = "fields")]
pub enum Notice {
    #[serde(rename = "notes.changed")]
    NotesChanged(NotesChanged),
    #[serde(rename = "editor.title")]
    EditorTitle(EditorTitle),
    #[serde(rename = "tabs.state")]
    TabsState(TabsState),
    #[serde(rename = "settings.open")]
    SettingsOpen(SettingsOpen),
    #[serde(rename = "nav.openNote")]
    NavOpenNote(OpenNote),
    #[serde(rename = "nav.back")]
    NavBack(Empty),
    #[serde(rename = "editor.ready")]
    EditorReady(NoteArgs),
    #[serde(rename = "editor.mode")]
    EditorMode(EditorMode),
    #[serde(rename = "editor.scroll")]
    EditorScroll(EditorScroll),
    #[serde(rename = "note.new")]
    NoteNew(NoteNew),
    #[serde(rename = "books.changed")]
    BooksChanged(Empty),
    #[serde(rename = "tags.changed")]
    TagsChanged(Empty),
    #[serde(rename = "savedSearches.changed")]
    SavedSearchesChanged(Empty),
}

const NOTICES: &[&str] = &[
    "notes.changed",
    "editor.title",
    "tabs.state",
    "settings.open",
    "nav.openNote",
    "nav.back",
    "editor.ready",
    "editor.mode",
    "editor.scroll",
    "note.new",
    "books.changed",
    "tags.changed",
    "savedSearches.changed",
];

/// The notices Rust sends Swift itself; the page can send none of them.
pub const RUST_NOTICES: &[&str] = &["licence.changed"];

/// The licence changed (`licence::CHANGED_EVENT`): Swift reads its snapshot again.
pub fn licence_changed() -> Value {
    json!({ "v": VERSION, "notice": "licence.changed" })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub id: u64,
    pub op: Op,
}

/// A checked request from Swift: for the page, or for Rust to answer (`direct`).
#[derive(Debug, Clone, PartialEq)]
pub enum Asked {
    Page(Request),
    Direct(direct::Asked),
}

impl Asked {
    pub fn id(&self) -> u64 {
        match self {
            Self::Page(request) => request.id,
            Self::Direct(asked) => asked.id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub id: u64,
    pub outcome: Result<Value, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FromPage {
    Reply(Reply),
    Notice(Notice),
}

impl Request {
    pub fn to_value(&self) -> Value {
        let mut message = object(json!({ "v": VERSION, "id": self.id }));
        message.extend(object(
            serde_json::to_value(&self.op).unwrap_or(Value::Null),
        ));
        Value::Object(message)
    }
}

impl Reply {
    pub fn refused(id: u64, code: &str) -> Self {
        Self {
            id,
            outcome: Err(code.to_owned()),
        }
    }

    pub fn to_value(&self) -> Value {
        match &self.outcome {
            Ok(result) => json!({ "v": VERSION, "id": self.id, "ok": true, "result": result }),
            Err(code) => json!({ "v": VERSION, "id": self.id, "ok": false, "code": code }),
        }
    }
}

impl Notice {
    /// The fields sit beside `notice` on the wire, not under a key of their own.
    pub fn to_value(&self) -> Value {
        let mut tagged = object(serde_json::to_value(self).unwrap_or(Value::Null));
        let fields = tagged.remove("fields").map(object).unwrap_or_default();
        let mut message = object(json!({ "v": VERSION }));
        message.extend(tagged);
        message.extend(fields);
        Value::Object(message)
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

enum Kind {
    Request,
    Reply,
    Notice,
}

/// The message's fields without `v`, and which kind it is.
fn envelope(bytes: &[u8]) -> Result<(Kind, Map<String, Value>), &'static str> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err("E_SCREENS_MESSAGE_TOO_LARGE");
    }
    let mut message: Map<String, Value> =
        serde_json::from_slice(bytes).map_err(|_| "E_SCREENS_MESSAGE_INVALID")?;
    match message.remove("v").as_ref().map(Value::as_u64) {
        None | Some(None) => return Err("E_SCREENS_MESSAGE_INVALID"),
        Some(Some(VERSION)) => {}
        Some(Some(_)) => return Err("E_SCREENS_VERSION_UNSUPPORTED"),
    }
    let kind = if message.contains_key("op") {
        Kind::Request
    } else if message.contains_key("ok") {
        Kind::Reply
    } else if message.contains_key("notice") {
        Kind::Notice
    } else {
        return Err("E_SCREENS_MESSAGE_INVALID");
    };
    Ok((kind, message))
}

fn has_only(message: &Map<String, Value>, keys: &[&str]) -> bool {
    message.len() == keys.len() && keys.iter().all(|key| message.contains_key(*key))
}

fn take_id(message: &mut Map<String, Value>) -> Result<u64, &'static str> {
    message
        .remove("id")
        .as_ref()
        .and_then(Value::as_u64)
        .ok_or("E_SCREENS_MESSAGE_INVALID")
}

/// A request from Swift, whose C call carries `request` beside the JSON: the two must agree, so a
/// refusal always reaches the call that sent it.
pub fn from_swift(request: u64, bytes: &[u8]) -> Result<Asked, &'static str> {
    let (kind, mut message) = envelope(bytes)?;
    let Kind::Request = kind else {
        return Err("E_SCREENS_KIND_UNEXPECTED");
    };
    let id = take_id(&mut message)?;
    if !has_only(&message, &["op", "args"]) {
        return Err("E_SCREENS_MESSAGE_INVALID");
    }
    if id != request {
        return Err("E_SCREENS_ID_MISMATCH");
    }
    let name = message
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(name) = direct::OPS.iter().find(|known| **known == name) {
        let op =
            serde_json::from_value(Value::Object(message)).map_err(|_| "E_SCREENS_ARGS_INVALID")?;
        return Ok(Asked::Direct(direct::Asked { id, name, op }));
    }
    if !OPS.contains(&name) {
        return Err("E_SCREENS_OP_UNKNOWN");
    }
    let op: Op =
        serde_json::from_value(Value::Object(message)).map_err(|_| "E_SCREENS_ARGS_INVALID")?;
    validate_op(&op)?;
    Ok(Asked::Page(Request { id, op }))
}

/// A reply or a notice from the page.
pub fn from_page(bytes: &[u8]) -> Result<FromPage, &'static str> {
    let (kind, mut message) = envelope(bytes)?;
    match kind {
        Kind::Request => Err("E_SCREENS_KIND_UNEXPECTED"),
        Kind::Reply => reply(&mut message).map(FromPage::Reply),
        Kind::Notice => notice(message).map(FromPage::Notice),
    }
}

fn reply(message: &mut Map<String, Value>) -> Result<Reply, &'static str> {
    let id = take_id(message)?;
    let outcome = match message.get("ok") {
        Some(Value::Bool(true)) if has_only(message, &["ok", "result"]) => {
            Ok(message.remove("result").unwrap_or(Value::Null))
        }
        Some(Value::Bool(false)) if has_only(message, &["ok", "code"]) => {
            match message.remove("code") {
                Some(Value::String(code)) if valid_code(&code) => Err(code),
                _ => return Err("E_SCREENS_CODE_INVALID"),
            }
        }
        _ => return Err("E_SCREENS_MESSAGE_INVALID"),
    };
    Ok(Reply { id, outcome })
}

fn notice(mut message: Map<String, Value>) -> Result<Notice, &'static str> {
    let Some(Value::String(name)) = message.remove("notice") else {
        return Err("E_SCREENS_MESSAGE_INVALID");
    };
    if !NOTICES.contains(&name.as_str()) {
        return Err("E_SCREENS_NOTICE_UNKNOWN");
    }
    let tagged = json!({ "notice": name, "fields": message });
    let notice: Notice = serde_json::from_value(tagged).map_err(|_| "E_SCREENS_ARGS_INVALID")?;
    validate_notice(&notice)?;
    Ok(notice)
}

/// A code as Rust and the page write them (`E_…` or `W_…`), so a reply never carries text.
fn valid_code(code: &str) -> bool {
    let Some(rest) = code.strip_prefix("E_").or_else(|| code.strip_prefix("W_")) else {
        return false;
    };
    !rest.is_empty()
        && code.len() <= MAX_CODE_CHARS
        && rest
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn note_ids(ids: &[String], max: usize) -> Result<(), &'static str> {
    if ids.len() > max {
        return Err("E_SCREENS_IDS_TOO_MANY");
    }
    if !ids.iter().all(|id| valid_note_id(id)) {
        return Err("E_SCREENS_NOTE_ID_INVALID");
    }
    Ok(())
}

fn title(title: &str) -> Result<(), &'static str> {
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err("E_SCREENS_TITLE_TOO_LONG");
    }
    Ok(())
}

/// A notebook is named by an ID like a note's, or not at all (unfiled).
fn book(id: Option<&String>) -> Result<(), &'static str> {
    id.map_or(Ok(()), |id| note_ids(std::slice::from_ref(id), 1))
}

fn validate_op(op: &Op) -> Result<(), &'static str> {
    match op {
        Op::Ping(_) => Ok(()),
        Op::Excerpts(Ids { ids }) => note_ids(ids, MAX_EXCERPT_IDS),
        Op::Search(search) => {
            if search.query.chars().count() > MAX_QUERY_CHARS {
                return Err("E_SCREENS_QUERY_TOO_LONG");
            }
            Ok(())
        }
        Op::NoteCreate(create) => {
            book(create.book_id.as_ref())?;
            create.title.as_deref().map_or(Ok(()), title)
        }
        Op::NoteDiscard(NoteArgs { note_id }) => note_ids(std::slice::from_ref(note_id), 1),
        Op::SettingsShowPane(ShowPane { pane, anchor }) => match (pane, anchor) {
            (_, None) | (WebPane::Sync, Some(PaneAnchor::Pairing)) => Ok(()),
            _ => Err("E_SCREENS_ARGS_INVALID"),
        },
        Op::EditorShow(ShowNote { note_id, .. })
        | Op::EditorPrepare(NoteArgs { note_id })
        | Op::NoteText(NoteArgs { note_id })
        | Op::NoteComplete(NoteArgs { note_id }) => note_ids(std::slice::from_ref(note_id), 1),
        Op::NoteUndoStatus(UndoStatus { note_id, undo }) => {
            note_ids(std::slice::from_ref(note_id), 1)?;
            if !NOTE_STATUSES.contains(&undo.status.as_str()) || !valid_hlc(&undo.status_hlc) {
                return Err("E_SCREENS_ARGS_INVALID");
            }
            Ok(())
        }
        Op::NotesBatch(batch) => {
            if batch.ids.is_empty() {
                return Err("E_SCREENS_ARGS_INVALID");
            }
            note_ids(&batch.ids, MAX_BATCH_IDS)?;
            change(&batch.change)
        }
        Op::TemplateApply(apply) => {
            note_ids(std::slice::from_ref(&apply.template_id), 1)?;
            book(apply.book_id.as_ref())
        }
        Op::TabsShow(_)
        | Op::TabsPopToRoot(_)
        | Op::SettingsNotebooks(_)
        | Op::EditorHide(_)
        | Op::EditorSetMode(_)
        | Op::EditorInfo(_)
        | Op::EditorFocus(_)
        | Op::TrashEmpty(_)
        | Op::TemplateCreate(_) => Ok(()),
    }
}

fn change(change: &Change) -> Result<(), &'static str> {
    match change {
        Change::Book(BookChoice { book_id }) => book(book_id.as_ref()),
        Change::Status(StatusChoice { status }) if NOTE_STATUSES.contains(&status.as_str()) => {
            Ok(())
        }
        Change::Status(_) => Err("E_SCREENS_ARGS_INVALID"),
        Change::PutTag(TagChoice { tag_id }) | Change::RemoveTag(TagChoice { tag_id }) => {
            note_ids(std::slice::from_ref(tag_id), 1)
        }
        Change::Pinned(_) | Change::Trash(_) | Change::Restore(_) | Change::Purge(_) => Ok(()),
    }
}

fn validate_notice(notice: &Notice) -> Result<(), &'static str> {
    match notice {
        Notice::NotesChanged(changed) => note_ids(&changed.ids, MAX_CHANGED_IDS),
        Notice::EditorTitle(editor) => {
            note_ids(std::slice::from_ref(&editor.id), 1)?;
            title(&editor.title)
        }
        Notice::NavOpenNote(open) => {
            note_ids(std::slice::from_ref(&open.note_id), 1)?;
            title(&open.title)
        }
        Notice::EditorReady(NoteArgs { note_id })
        | Notice::EditorMode(EditorMode { note_id, .. }) => {
            note_ids(std::slice::from_ref(note_id), 1)
        }
        Notice::NoteNew(NoteNew { book_id }) => book(book_id.as_ref()),
        Notice::TabsState(_)
        | Notice::SettingsOpen(_)
        | Notice::NavBack(_)
        | Notice::EditorScroll(_)
        | Notice::BooksChanged(_)
        | Notice::TagsChanged(_)
        | Notice::SavedSearchesChanged(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "01890a5d-ac96-774b-bcce-b302099a8057";

    struct Fixture {
        name: String,
        from: String,
        code: Option<String>,
        message: Value,
    }

    fn fixtures(set: &str) -> Vec<Fixture> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/screens")
            .join(set);
        let mut found: Vec<Fixture> = std::fs::read_dir(&dir)
            .expect("E_TEST_FIXTURES")
            .map(|entry| {
                let path = entry.expect("E_TEST_FIXTURES").path();
                let text = std::fs::read_to_string(&path).expect("E_TEST_FIXTURES");
                let mut fixture: Map<String, Value> =
                    serde_json::from_str(&text).expect("E_TEST_FIXTURES");
                Fixture {
                    name: path.file_name().unwrap().to_string_lossy().into_owned(),
                    from: fixture["from"].as_str().unwrap().to_owned(),
                    code: fixture
                        .get("code")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    message: fixture.remove("message").unwrap(),
                }
            })
            .collect();
        found.sort_by(|a, b| a.name.cmp(&b.name));
        assert!(found.len() > 5, "{set}: too few fixtures");
        found
    }

    fn bytes(message: &Value) -> Vec<u8> {
        serde_json::to_vec(message).unwrap()
    }

    fn request_number(message: &Value) -> u64 {
        message.get("id").and_then(Value::as_u64).unwrap_or(0)
    }

    /// What Rust passes on, written out again from the checked message.
    fn passed_on(fixture: &Fixture) -> Result<Value, &'static str> {
        let message = bytes(&fixture.message);
        match fixture.from.as_str() {
            "swift" => {
                from_swift(request_number(&fixture.message), &message).map(|asked| match asked {
                    Asked::Page(request) => request.to_value(),
                    Asked::Direct(direct) => panic!("{} is answered by Rust", direct.name),
                })
            }
            "page" => from_page(&message).map(|from| match from {
                FromPage::Reply(reply) => reply.to_value(),
                FromPage::Notice(notice) => notice.to_value(),
            }),
            "rust" => {
                let name = fixture.message["notice"].as_str().unwrap_or_default();
                assert!(RUST_NOTICES.contains(&name), "{name} is not Rust's");
                Ok(licence_changed())
            }
            other => panic!("unknown sender {other}"),
        }
    }

    #[test]
    fn passes_on_every_valid_fixture_as_it_came() {
        for fixture in fixtures("valid") {
            assert_eq!(
                passed_on(&fixture),
                Ok(fixture.message.clone()),
                "{}",
                fixture.name
            );
        }
    }

    #[test]
    fn refuses_every_invalid_fixture_with_its_code() {
        for fixture in fixtures("invalid") {
            let code = fixture
                .code
                .as_deref()
                .expect("an invalid fixture names its code");
            assert_eq!(passed_on(&fixture), Err(code), "{}", fixture.name);
        }
    }

    fn ping(id: u64) -> Vec<u8> {
        bytes(&json!({ "v": 1, "id": id, "op": "ping", "args": {} }))
    }

    #[test]
    fn a_request_answers_the_call_that_carried_it() {
        assert_eq!(from_swift(7, &ping(7)).map(|asked| asked.id()), Ok(7));
        assert_eq!(from_swift(8, &ping(7)), Err("E_SCREENS_ID_MISMATCH"));
    }

    #[test]
    fn refuses_what_is_not_json_or_past_four_mebibytes() {
        assert_eq!(
            from_swift(1, b"{\"v\":1,"),
            Err("E_SCREENS_MESSAGE_INVALID")
        );
        assert_eq!(from_page(b""), Err("E_SCREENS_MESSAGE_INVALID"));
        let padding = "a".repeat(MAX_MESSAGE_BYTES);
        let large = json!({ "v": 1, "id": 1, "ok": true, "result": padding });
        assert_eq!(
            from_page(&bytes(&large)),
            Err("E_SCREENS_MESSAGE_TOO_LARGE")
        );
        let at_limit = json!({ "v": 1, "id": 1, "ok": true, "result": "" });
        let room = MAX_MESSAGE_BYTES - bytes(&at_limit).len();
        let full = json!({ "v": 1, "id": 1, "ok": true, "result": "a".repeat(room) });
        assert_eq!(bytes(&full).len(), MAX_MESSAGE_BYTES);
        assert!(matches!(from_page(&bytes(&full)), Ok(FromPage::Reply(_))));
    }

    fn excerpts(count: usize) -> Vec<u8> {
        bytes(&json!({ "v": 1, "id": 1, "op": "excerpts", "args": { "ids": vec![NOTE; count] } }))
    }

    #[test]
    fn asks_for_the_excerpts_of_at_most_sixty_notes() {
        assert!(from_swift(1, &excerpts(MAX_EXCERPT_IDS)).is_ok());
        assert_eq!(
            from_swift(1, &excerpts(MAX_EXCERPT_IDS + 1)),
            Err("E_SCREENS_IDS_TOO_MANY")
        );
    }

    fn create_titled(title: &str) -> Vec<u8> {
        bytes(&json!({ "v": 1, "id": 1, "op": "note.create", "args": { "title": title } }))
    }

    fn editor_title(title: &str) -> Vec<u8> {
        bytes(&json!({ "v": 1, "notice": "editor.title", "id": NOTE, "title": title }))
    }

    #[test]
    fn takes_a_title_of_at_most_max_title_chars_characters() {
        let longest = "\u{e9}".repeat(MAX_TITLE_CHARS);
        let longer = format!("{longest}a");
        assert!(from_swift(1, &create_titled(&longest)).is_ok());
        assert_eq!(
            from_swift(1, &create_titled(&longer)),
            Err("E_SCREENS_TITLE_TOO_LONG")
        );
        assert!(from_page(&editor_title(&longest)).is_ok());
        assert_eq!(
            from_page(&editor_title(&longer)),
            Err("E_SCREENS_TITLE_TOO_LONG")
        );
        assert!(from_page(&open_note(&longest)).is_ok());
        assert_eq!(
            from_page(&open_note(&longer)),
            Err("E_SCREENS_TITLE_TOO_LONG")
        );
    }

    fn open_note(title: &str) -> Vec<u8> {
        bytes(&json!({ "v": 1, "notice": "nav.openNote", "noteId": NOTE, "title": title }))
    }

    fn search(query: &str) -> Vec<u8> {
        bytes(
            &json!({ "v": 1, "id": 1, "op": "search", "args": { "query": query, "scope": "all" } }),
        )
    }

    #[test]
    fn takes_a_query_no_longer_than_ten_clauses_of_a_hundred_characters() {
        let clause = format!("-title:\"{}\" ", "b".repeat(100));
        let ten = clause.repeat(10);
        assert!(from_swift(1, &search(ten.trim_end())).is_ok());
        let longer = "b".repeat(MAX_QUERY_CHARS + 1);
        assert_eq!(
            from_swift(1, &search(&longer)),
            Err("E_SCREENS_QUERY_TOO_LONG")
        );
    }

    #[test]
    fn a_change_names_at_most_ten_thousand_notes() {
        let changed = |count: usize| {
            bytes(&json!({ "v": 1, "notice": "notes.changed", "rev": 1, "ids": vec![NOTE; count] }))
        };
        assert!(from_page(&changed(MAX_CHANGED_IDS)).is_ok());
        assert_eq!(
            from_page(&changed(MAX_CHANGED_IDS + 1)),
            Err("E_SCREENS_IDS_TOO_MANY")
        );
    }

    #[test]
    fn a_failed_reply_carries_a_code_and_never_text() {
        let failed = |code: &str| bytes(&json!({ "v": 1, "id": 1, "ok": false, "code": code }));
        assert!(from_page(&failed("W_SCREENS_OP_UNSUPPORTED")).is_ok());
        assert!(from_page(&failed(&format!("E_{}", "A".repeat(MAX_CODE_CHARS - 2)))).is_ok());
        for code in [
            "E_",
            "E_lower",
            "X_CODE",
            "E_NOTE Groceries",
            &format!("E_{}", "A".repeat(MAX_CODE_CHARS - 1)),
        ] {
            assert_eq!(
                from_page(&failed(code)),
                Err("E_SCREENS_CODE_INVALID"),
                "{code}"
            );
        }
        assert_eq!(
            from_page(&bytes(&json!({ "v": 1, "id": 1, "ok": false, "code": 4 }))),
            Err("E_SCREENS_CODE_INVALID")
        );
    }

    fn create_in(book: Value) -> Vec<u8> {
        bytes(&json!({ "v": 1, "id": 1, "op": "note.create", "args": { "bookId": book } }))
    }

    #[test]
    fn creates_a_note_in_a_notebook_named_by_a_valid_id_or_in_none() {
        assert!(from_swift(1, &create_in(json!(NOTE))).is_ok());
        assert!(from_swift(1, &create_in(Value::Null)).is_ok());
        for refused in [
            json!("inbox"),
            json!(""),
            json!(NOTE.to_uppercase()),
            json!(7),
        ] {
            assert!(
                from_swift(1, &create_in(refused.clone())).is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn new_note_names_a_valid_notebook_or_none() {
        let asked = |fields: Value| {
            let mut message = object(json!({ "v": 1, "notice": "note.new" }));
            message.extend(object(fields));
            from_page(&bytes(&Value::Object(message)))
        };
        assert!(asked(json!({ "bookId": NOTE })).is_ok());
        assert!(asked(json!({ "bookId": null })).is_ok());
        assert!(asked(json!({})).is_ok());
        assert_eq!(
            asked(json!({ "bookId": "inbox" })),
            Err("E_SCREENS_NOTE_ID_INVALID")
        );
    }

    #[test]
    fn the_page_cannot_send_what_only_rust_sends() {
        for name in RUST_NOTICES {
            let notice = bytes(&json!({ "v": 1, "notice": name }));
            assert_eq!(from_page(&notice), Err("E_SCREENS_NOTICE_UNKNOWN"));
            assert!(!NOTICES.contains(name));
        }
        assert_eq!(
            licence_changed(),
            json!({ "v": 1, "notice": "licence.changed" })
        );
    }
}
