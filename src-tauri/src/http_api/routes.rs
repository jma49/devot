//! Which call a request makes, with its arguments checked here first (the core checks them again,
//! to its own limits: `src/core/ai.ts`). The calls and their arguments are the contract with the
//! core (`src/core/httpApi.ts`); `tests/support/http-api-calls.json` holds both sides to it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::notes::{MAX_TITLE_CHARS, valid_note_id};

use super::Refusal;

/// What one call may send as Markdown (a body, or all patches together): MAX_AI_BODY_BYTES in
/// `src/core/ai.ts`.
pub const MAX_MARKDOWN_BYTES: usize = 1024 * 1024;
const MAX_QUERY_CHARS: usize = 1_000;
const MAX_SEARCH_LIMIT: u64 = 50;
const MAX_PATCHES: usize = 50;
const MAX_TAGS: usize = 50;
const MAX_NOTEBOOK_REF_CHARS: usize = 500;
// Generous: the core checks names after trimming, against MAX_BOOK_NAME_CHARS (200) and
// MAX_TAG_NAME_CHARS (100), as devot-mcp's tool schemas leave it to.
const MAX_NAME_CHARS: usize = 800;
const MAX_SENT_TITLE_CHARS: usize = MAX_TITLE_CHARS * 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    NotebooksList,
    NotebooksCreate,
    TagsList,
    NotesSearch,
    NotesCreate,
    NotesRead,
    NotesUpdate,
    NotesTrash,
}

impl Op {
    pub fn as_str(self) -> &'static str {
        match self {
            Op::NotebooksList => "notebooks.list",
            Op::NotebooksCreate => "notebooks.create",
            Op::TagsList => "tags.list",
            Op::NotesSearch => "notes.search",
            Op::NotesCreate => "notes.create",
            Op::NotesRead => "notes.read",
            Op::NotesUpdate => "notes.update",
            Op::NotesTrash => "notes.trash",
        }
    }

    /// What a read-only token may not do.
    pub fn writes(self) -> bool {
        matches!(
            self,
            Op::NotebooksCreate | Op::NotesCreate | Op::NotesUpdate | Op::NotesTrash
        )
    }

    pub fn creates(self) -> bool {
        matches!(self, Op::NotebooksCreate | Op::NotesCreate)
    }

    pub fn takes_body(self) -> bool {
        matches!(
            self,
            Op::NotebooksCreate | Op::NotesCreate | Op::NotesUpdate
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub op: Op,
    pub note: Option<String>,
    pub args: Value,
}

const NOT_FOUND: Refusal = Refusal::new(404, "E_HTTP_NOT_FOUND");
const NO_METHOD: Refusal = Refusal::new(405, "E_HTTP_METHOD_NOT_ALLOWED");
const BAD_QUERY: Refusal = Refusal::new(400, "E_HTTP_QUERY_INVALID");
const BAD_BODY: Refusal = Refusal::new(400, "E_HTTP_BODY_INVALID");

/// The call a method and path make, so the scope and the body can be checked before it is read.
/// A path naming no note ID answers like an unknown note.
pub fn route(method: &str, path: &str) -> Result<(Op, Option<String>), Refusal> {
    let only = |op: Op, allowed: &str| {
        if method == allowed {
            Ok((op, None))
        } else {
            Err(NO_METHOD)
        }
    };
    match path {
        "/v1/notebooks" => match method {
            "GET" => Ok((Op::NotebooksList, None)),
            "POST" => Ok((Op::NotebooksCreate, None)),
            _ => Err(NO_METHOD),
        },
        "/v1/tags" => only(Op::TagsList, "GET"),
        "/v1/notes" => match method {
            "GET" => Ok((Op::NotesSearch, None)),
            "POST" => Ok((Op::NotesCreate, None)),
            _ => Err(NO_METHOD),
        },
        _ => {
            let id = path.strip_prefix("/v1/notes/").ok_or(NOT_FOUND)?;
            let op = match method {
                "GET" => Op::NotesRead,
                "PATCH" => Op::NotesUpdate,
                "DELETE" => Op::NotesTrash,
                _ => return Err(NO_METHOD),
            };
            if !valid_note_id(id) {
                return Err(Refusal::new(404, "E_NOTE_NOT_FOUND"));
            }
            Ok((op, Some(id.to_string())))
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NewNote {
    title: String,
    markdown: String,
    notebook: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Patch {
    find: String,
    replace: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    None,
    Active,
    OnHold,
    Completed,
    Dropped,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NoteChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    patches: Option<Vec<Patch>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notebook: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<Status>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NewNotebook {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent: Option<String>,
}

#[derive(Serialize)]
struct Search {
    query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u64>,
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn check_title(title: &str) -> Result<(), Refusal> {
    if chars(title) > MAX_SENT_TITLE_CHARS {
        return Err(Refusal::new(400, "E_NOTE_TITLE_INVALID"));
    }
    Ok(())
}

fn check_markdown(markdown: &str) -> Result<(), Refusal> {
    if markdown.len() > MAX_MARKDOWN_BYTES {
        return Err(Refusal::new(413, "E_NOTE_BODY_TOO_LARGE"));
    }
    Ok(())
}

fn check_notebook_ref(notebook: &str) -> Result<(), Refusal> {
    if notebook.is_empty() || chars(notebook) > MAX_NOTEBOOK_REF_CHARS {
        return Err(Refusal::new(404, "E_BOOK_NOT_FOUND"));
    }
    Ok(())
}

fn check_change(change: &NoteChange) -> Result<(), Refusal> {
    if change.title.is_none()
        && change.markdown.is_none()
        && change.patches.is_none()
        && change.notebook.is_none()
        && change.tags.is_none()
        && change.status.is_none()
    {
        return Err(Refusal::new(400, "E_AI_UPDATE_EMPTY"));
    }
    if change.markdown.is_some() && change.patches.is_some() {
        return Err(Refusal::new(400, "E_AI_BODY_CONFLICT"));
    }
    if let Some(title) = &change.title {
        check_title(title)?;
    }
    if let Some(markdown) = &change.markdown {
        check_markdown(markdown)?;
    }
    if let Some(patches) = &change.patches {
        if patches.is_empty()
            || patches.len() > MAX_PATCHES
            || patches.iter().any(|p| p.find.is_empty())
        {
            return Err(Refusal::new(400, "E_AI_PATCHES_INVALID"));
        }
        let sent: usize = patches.iter().map(|p| p.find.len() + p.replace.len()).sum();
        if sent > MAX_MARKDOWN_BYTES {
            return Err(Refusal::new(413, "E_NOTE_BODY_TOO_LARGE"));
        }
    }
    if let Some(notebook) = &change.notebook {
        check_notebook_ref(notebook)?;
    }
    if let Some(tags) = &change.tags {
        if tags.len() > MAX_TAGS {
            return Err(Refusal::new(400, "E_AI_TAGS_TOO_MANY"));
        }
        if tags.iter().any(|t| chars(t) > MAX_NAME_CHARS) {
            return Err(Refusal::new(400, "E_TAG_NAME_INVALID"));
        }
    }
    Ok(())
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// A query value as forms send it: `+` for a space, `%XX` for a byte, UTF-8 in all.
pub fn decode_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => out.push(b' '),
            b'%' => {
                let high = hex(*bytes.get(at + 1)?)?;
                let low = hex(*bytes.get(at + 2)?)?;
                out.push(high << 4 | low);
                at += 2;
            }
            byte => out.push(byte),
        }
        at += 1;
    }
    String::from_utf8(out).ok()
}

fn search(query: &str) -> Result<Search, Refusal> {
    let mut text = None;
    let mut limit = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').ok_or(BAD_QUERY)?;
        let value = decode_component(value).ok_or(BAD_QUERY)?;
        match key {
            "q" if text.is_none() => text = Some(value),
            "limit" if limit.is_none() => {
                let n = (!value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
                    .then(|| value.parse::<u64>().ok())
                    .flatten()
                    .filter(|n| (1..=MAX_SEARCH_LIMIT).contains(n))
                    .ok_or(BAD_QUERY)?;
                limit = Some(n);
            }
            _ => return Err(BAD_QUERY),
        }
    }
    let text = text.ok_or(BAD_QUERY)?;
    if text.trim().is_empty() || chars(&text) > MAX_QUERY_CHARS {
        return Err(BAD_QUERY);
    }
    Ok(Search { query: text, limit })
}

/// A JSON object of exactly the fields `T` has (serde would take an array for a struct too).
fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, Refusal> {
    let value: Value = serde_json::from_slice(body).map_err(|_| BAD_BODY)?;
    if !value.is_object() {
        return Err(BAD_BODY);
    }
    serde_json::from_value(value).map_err(|_| BAD_BODY)
}

fn args<T: Serialize>(value: &T) -> Result<Value, Refusal> {
    serde_json::to_value(value).map_err(|_| BAD_BODY)
}

/// The call with its arguments as the core takes them: only the fields that were sent.
/// `query` is what follows `?`, `body` the JSON a call that takes one was sent.
pub fn call(
    op: Op,
    note: Option<String>,
    query: Option<&str>,
    body: &[u8],
) -> Result<Call, Refusal> {
    if query.is_some() && op != Op::NotesSearch {
        return Err(BAD_QUERY);
    }
    let args = match op {
        Op::NotebooksList | Op::TagsList | Op::NotesRead | Op::NotesTrash => {
            Value::Object(Default::default())
        }
        Op::NotesSearch => args(&search(query.ok_or(BAD_QUERY)?)?)?,
        Op::NotesCreate => {
            let new: NewNote = parse(body)?;
            check_title(&new.title)?;
            check_markdown(&new.markdown)?;
            check_notebook_ref(&new.notebook)?;
            args(&new)?
        }
        Op::NotesUpdate => {
            let change: NoteChange = parse(body)?;
            check_change(&change)?;
            args(&change)?
        }
        Op::NotebooksCreate => {
            let new: NewNotebook = parse(body)?;
            if chars(&new.name) > MAX_NAME_CHARS {
                return Err(Refusal::new(400, "E_BOOK_NAME_INVALID"));
            }
            if let Some(parent) = &new.parent {
                check_notebook_ref(parent)?;
            }
            args(&new)?
        }
    };
    Ok(Call { op, note, args })
}
