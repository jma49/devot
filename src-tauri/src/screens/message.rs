//! The envelope of the iPhone screens' bridge (docs/specs/iphone-screens.md, Message envelope).
//! Swift sends requests; the page sends replies and notices; Rust checks each one here before it
//! passes it on, and what it passes on is the checked message written out again.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::direct;
use crate::commands::notes::{MAX_TITLE_CHARS, valid_note_id};

pub const VERSION: u64 = 1;
/// The store bridge's reply limit (`STORE_REPLY_LIMIT`).
pub const MAX_MESSAGE_BYTES: usize = 4 << 20;
/// The rows a list shows at once, with room to spare.
const MAX_EXCERPT_IDS: usize = 60;
const MAX_CHANGED_IDS: usize = 10_000;
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

/// The iPhone's Glass Transparency: -100 is solid, 0 the design, 100 the clearest, in steps of 5.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GlassSet {
    pub transparency: i32,
}

pub const GLASS_TRANSPARENCY_MAX: i32 = 100;
pub const GLASS_TRANSPARENCY_STEP: i32 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShowPane {
    pub pane: WebPane,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<PaneAnchor>,
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
    #[serde(rename = "tabs.show")]
    TabsShow(TabArgs),
    #[serde(rename = "tabs.popToRoot")]
    TabsPopToRoot(TabArgs),
    #[serde(rename = "settings.showPane")]
    SettingsShowPane(ShowPane),
    #[serde(rename = "settings.notebooks")]
    SettingsNotebooks(Empty),
    #[serde(rename = "glass.get")]
    GlassGet(Empty),
    #[serde(rename = "glass.set")]
    GlassSet(GlassSet),
}

pub const OPS: &[&str] = &[
    "ping",
    "excerpts",
    "search",
    "note.create",
    "tabs.show",
    "tabs.popToRoot",
    "settings.showPane",
    "settings.notebooks",
    "glass.get",
    "glass.set",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotesChanged {
    pub rev: u64,
    pub ids: Vec<String>,
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
}

const NOTICES: &[&str] = &[
    "notes.changed",
    "editor.title",
    "tabs.state",
    "settings.open",
];

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
            if let Some(book) = &create.book_id {
                note_ids(std::slice::from_ref(book), 1)?;
            }
            create.title.as_deref().map_or(Ok(()), title)
        }
        Op::SettingsShowPane(ShowPane { pane, anchor }) => match (pane, anchor) {
            (_, None) | (WebPane::Sync, Some(PaneAnchor::Pairing)) => Ok(()),
            _ => Err("E_SCREENS_ARGS_INVALID"),
        },
        Op::GlassSet(GlassSet { transparency }) => {
            if transparency.abs() > GLASS_TRANSPARENCY_MAX
                || transparency % GLASS_TRANSPARENCY_STEP != 0
            {
                return Err("E_SCREENS_ARGS_INVALID");
            }
            Ok(())
        }
        Op::TabsShow(_) | Op::TabsPopToRoot(_) | Op::SettingsNotebooks(_) | Op::GlassGet(_) => {
            Ok(())
        }
    }
}

fn validate_notice(notice: &Notice) -> Result<(), &'static str> {
    match notice {
        Notice::NotesChanged(changed) => note_ids(&changed.ids, MAX_CHANGED_IDS),
        Notice::EditorTitle(editor) => {
            note_ids(std::slice::from_ref(&editor.id), 1)?;
            title(&editor.title)
        }
        Notice::TabsState(_) | Notice::SettingsOpen(_) => Ok(()),
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
}
