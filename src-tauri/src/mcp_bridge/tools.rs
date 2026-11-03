//! The tools, as `mcp/tools.json` declares them: each is one or two calls of the local HTTP API, and
//! every rule about notes is the core's. A failure answers with its code and a short hint, never
//! with note content.

use serde_json::{Map, Value, json};

use crate::commands::notes::{MAX_BODY_BYTES, MAX_TITLE_CHARS};
use crate::http_api::routes::MAX_MARKDOWN_BYTES;

pub const SERVER_NAME: &str = "devot";
pub const SERVER_INSTRUCTIONS: &str = "Devot is a Markdown note app. These tools see only notebooks whose owner turned on Allow AI Access, and only the notes filed directly in them. Notes are Markdown. Edits apply directly; Devot keeps the text from before each edit in the note history, and trashed notes stay in the Trash until the owner empties it.";
/// The tool list. `tests/core/mcp-tools.test.ts` holds its limits to the core's.
const TOOLS: &str = include_str!("../../mcp/tools.json");

pub const NO_AI_ACCESS: &str = "E_MCP_NO_AI_ACCESS";
/// Says what to do and nothing about what notebooks exist, so it tells no client of hidden ones.
pub const NO_AI_ACCESS_HINT: &str = "No notebook allows AI access, so no note is visible. In Devot, right-click a notebook in the sidebar and choose Allow AI Access; Settings > Integrations can turn it on for several notebooks at once. create_notebook makes one with it on.";

const MAX_BOOK_NAME_CHARS: usize = 200;
const MAX_TAG_NAME_CHARS: usize = 100;
const MAX_NOTE_LINKS: usize = 10_000;
const MAX_PATCHES: usize = 50;
const MAX_TAGS: usize = 50;

fn hint(code: &str) -> String {
    let text: &str = match code {
        "E_NOTE_NOT_FOUND" => "No note with this ID is available to AI.",
        "E_BOOK_NOT_FOUND" => {
            "No notebook with this ID or exact name allows AI access. Call list_notebooks to see them."
        }
        "E_BOOK_AMBIGUOUS" => {
            "Several notebooks that allow AI access have this name; pass the notebook ID."
        }
        "E_SEARCH_QUERY_EMPTY" => "The query has no search terms.",
        "E_NOTE_TITLE_INVALID" => {
            return format!("The title must be one line of 1 to {MAX_TITLE_CHARS} characters.");
        }
        "E_NOTE_BODY_TOO_LARGE" => {
            return format!(
                "The Markdown sent (a body, or all patches together) must be at most {MAX_MARKDOWN_BYTES} bytes, and a patched note at most {MAX_BODY_BYTES} bytes."
            );
        }
        "E_NOTE_LINKS_TOO_MANY" => {
            return format!("The Markdown body may link to at most {MAX_NOTE_LINKS} notes.");
        }
        "E_NOTE_STATUS_INVALID" => {
            "The status must be one of none, active, on_hold, completed, dropped."
        }
        "E_AI_UPDATE_EMPTY" => {
            "Nothing to change: pass a title, markdown, patches, notebook, tags or status."
        }
        "E_AI_BODY_CONFLICT" => "Pass either markdown (the whole body) or patches, not both.",
        "E_AI_PATCHES_INVALID" => {
            return format!("Pass 1 to {MAX_PATCHES} patches, each with a non-empty find.");
        }
        "E_AI_PATCH_NOT_FOUND" => {
            "A patch find text is not in the note body (as earlier patches left it). Read the note again and copy the text exactly."
        }
        "E_AI_PATCH_AMBIGUOUS" => {
            "A patch find text occurs more than once in the note body. Include more surrounding text so it matches once."
        }
        "E_AI_TAGS_TOO_MANY" => {
            return format!("A note may be given at most {MAX_TAGS} tags at once.");
        }
        "E_TAG_NAME_INVALID" => {
            return format!(
                "Each tag name must be one line of 1 to {MAX_TAG_NAME_CHARS} characters. If the name is valid, pick another."
            );
        }
        "E_BOOK_NAME_INVALID" => {
            return format!(
                "The notebook name must be one line of 1 to {MAX_BOOK_NAME_CHARS} characters."
            );
        }
        "E_BOOK_NAME_TAKEN" => {
            "A notebook that allows AI access already has this name. Use it, or choose another name."
        }
        "E_STORAGE_BUSY" => "Devot is busy writing. Try again.",
        "E_LICENCE_REQUIRED" => {
            "Devot's trial has ended, so it is read-only without a licence. Notes can still be read; add a licence in Devot to write."
        }
        "E_HTTP_READ_ONLY" => {
            "Devot allows AI tools to read only. The owner can choose Read and Write in Settings > Integrations."
        }
        "E_MCP_ACCESS_OFF" => {
            "AI tools are turned off in Devot. The owner can turn them on in Settings > Integrations."
        }
        "E_MCP_BACKGROUND_START_OFF" => {
            "Devot is not running and the owner turned off starting it in the background. Ask the owner to open Devot, or to turn on background starts in Settings > Integrations."
        }
        "E_MCP_START_FAILED" => {
            "Devot could not be started. Ask the owner to open it; if it was moved, reconnect this tool from Settings > Integrations."
        }
        "E_MCP_START_TIMEOUT" => {
            "Devot did not get ready in time. Try again; if this keeps happening, ask the owner to open Devot."
        }
        "E_MCP_NOT_READY" => {
            "Devot is running but does not answer AI tools yet. Try again; Settings > Integrations says if something is in the way, such as another program on its port."
        }
        "E_MCP_TOKEN_MISSING" | "E_HTTP_TOKEN_INVALID" => {
            "This tool has no valid access to Devot. The owner can reconnect it from Settings > Integrations."
        }
        "E_MCP_KEYCHAIN_FAILED" => {
            "Devot's access token could not be read from the keychain. Ask the owner to open Devot and allow access."
        }
        "E_MCP_CONNECTION_LOST" => {
            "The connection to Devot ended before it answered, as when it quits. A write may or may not have been made: read the note before trying again."
        }
        "E_HTTP_API_TIMEOUT" => {
            "Devot did not answer in time. A write may still land: read the note before trying again."
        }
        "E_HTTP_RATE_LIMITED" => "Too many requests at once. Wait a moment and try again.",
        "E_CORE_NOT_READY" | "E_HTTP_API_UNAVAILABLE" | "E_HTTP_API_BUSY" => {
            "Devot is busy or still starting. Try again."
        }
        _ => "Devot could not complete the request.",
    };
    text.to_string()
}

/// A request of the local HTTP API, as `http_api::routes` reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiRequest {
    pub method: &'static str,
    pub target: String,
    pub body: Option<Value>,
}

/// Runs a request and answers its JSON, or a code.
pub trait Api: Send {
    fn call(&self, request: &ApiRequest) -> Result<Value, String>;
}

pub(crate) fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn note_target(args: &Map<String, Value>) -> String {
    let id = args.get("id").and_then(Value::as_str).unwrap_or("");
    format!("/v1/notes/{}", percent_encode(id))
}

fn without_id(args: &Map<String, Value>) -> Value {
    let mut body = args.clone();
    body.remove("id");
    Value::Object(body)
}

/// The call a tool makes: arguments the schema let through, or a code for a query with no terms.
fn request_of(tool: &str, args: &Map<String, Value>) -> Result<ApiRequest, &'static str> {
    let request = |method, target: &str, body| ApiRequest {
        method,
        target: target.to_string(),
        body,
    };
    Ok(match tool {
        "list_notebooks" => request("GET", "/v1/notebooks", None),
        "list_tags" => request("GET", "/v1/tags", None),
        "search_notes" => {
            let query = args.get("query").and_then(Value::as_str).unwrap_or("");
            if query.trim().is_empty() {
                return Err("E_SEARCH_QUERY_EMPTY");
            }
            let mut target = format!("/v1/notes?q={}", percent_encode(query));
            if let Some(limit) = args.get("limit").and_then(Value::as_u64) {
                target.push_str(&format!("&limit={limit}"));
            }
            request("GET", &target, None)
        }
        "read_note" => request("GET", &note_target(args), None),
        "create_note" => request("POST", "/v1/notes", Some(Value::Object(args.clone()))),
        "update_note" => request("PATCH", &note_target(args), Some(without_id(args))),
        "trash_note" => request("DELETE", &note_target(args), None),
        "create_notebook" => request("POST", "/v1/notebooks", Some(Value::Object(args.clone()))),
        _ => return Err("E_MCP_INTERNAL"),
    })
}

/// A value as `schema` allows it, with properties it does not name left out; the path of the first
/// thing it refuses, and why. Holds only the schema's words and the path, never a value.
fn checked(value: &Value, schema: &Value, path: &str) -> Result<Value, String> {
    let wrong = |what: &str| Err(format!("{what} at {path}"));
    let chars = |text: &str| text.encode_utf16().count() as u64;
    let bound = |key: &str| schema.get(key).and_then(Value::as_u64);
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => {
            let Some(text) = value.as_str() else {
                return wrong("expected a string");
            };
            if bound("minLength").is_some_and(|min| chars(text) < min) {
                return wrong("too short");
            }
            if bound("maxLength").is_some_and(|max| chars(text) > max) {
                return wrong("too long");
            }
            if let Some(allowed) = schema.get("enum").and_then(Value::as_array)
                && !allowed.contains(value)
            {
                return wrong("not one of the allowed values");
            }
            Ok(value.clone())
        }
        Some("integer") => {
            let Some(number) = value.as_i64() else {
                return wrong("expected an integer");
            };
            let at_least = schema.get("minimum").and_then(Value::as_i64);
            let at_most = schema.get("maximum").and_then(Value::as_i64);
            if at_least.is_some_and(|min| number < min) || at_most.is_some_and(|max| number > max) {
                return wrong("out of range");
            }
            Ok(value.clone())
        }
        Some("array") => {
            let Some(items) = value.as_array() else {
                return wrong("expected an array");
            };
            let count = items.len() as u64;
            if bound("minItems").is_some_and(|min| count < min) {
                return wrong("too few items");
            }
            if bound("maxItems").is_some_and(|max| count > max) {
                return wrong("too many items");
            }
            let item_schema = schema.get("items").unwrap_or(&Value::Null);
            items
                .iter()
                .enumerate()
                .map(|(at, item)| checked(item, item_schema, &format!("{path}.{at}")))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        Some("object") => {
            let Some(fields) = value.as_object() else {
                return wrong("expected an object");
            };
            let empty = Map::new();
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            for required in schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !fields.contains_key(required) {
                    return Err(format!("missing {required} at {path}"));
                }
            }
            let mut out = Map::new();
            for (name, property) in properties {
                if let Some(field) = fields.get(name) {
                    out.insert(
                        name.clone(),
                        checked(field, property, &format!("{path}.{name}"))?,
                    );
                }
            }
            Ok(Value::Object(out))
        }
        _ => Ok(value.clone()),
    }
}

/// The body limit counts the JSON's escapes too; a note within the core's limit passes it, and one
/// past it is the same mistake.
fn tool_code(code: String) -> String {
    match code.as_str() {
        "E_HTTP_BODY_TOO_LARGE" => "E_NOTE_BODY_TOO_LARGE".to_string(),
        _ => code,
    }
}

fn text(value: &Value) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(value).unwrap_or_else(|_| String::from("null")),
        }],
    })
}

fn failed(code: &str, hint: &str) -> Value {
    json!({
        "isError": true,
        "content": [{ "type": "text", "text": format!("{code}: {hint}") }],
    })
}

fn with_no_access_hint(mut value: Value) -> Value {
    if let Some(fields) = value.as_object_mut() {
        fields.insert("code".into(), json!(NO_AI_ACCESS));
        fields.insert("hint".into(), json!(NO_AI_ACCESS_HINT));
    }
    value
}

fn is_empty_at(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
}

pub struct Tools {
    api: Box<dyn Api>,
    declared: Vec<Value>,
}

impl Tools {
    pub fn new(api: Box<dyn Api>) -> Self {
        let declared = serde_json::from_str(TOOLS).unwrap_or_default();
        Self { api, declared }
    }

    pub fn list(&self) -> Vec<Value> {
        self.declared.clone()
    }

    fn schema_of(&self, tool: &str) -> Option<&Value> {
        self.declared
            .iter()
            .find(|declared| declared["name"] == tool)
            .map(|declared| &declared["inputSchema"])
    }

    /// An empty list may mean only that no notebook allows AI: then the answer says so.
    fn explained(&self, tool: &str, value: Value) -> Value {
        let empty_key = match tool {
            "list_notebooks" => return self.explained_notebooks(value),
            "search_notes" => "results",
            "list_tags" => "tags",
            _ => return value,
        };
        if !is_empty_at(&value, empty_key) {
            return value;
        }
        let notebooks = ApiRequest {
            method: "GET",
            target: "/v1/notebooks".to_string(),
            body: None,
        };
        match self.api.call(&notebooks) {
            Ok(found) if is_empty_at(&found, "notebooks") => with_no_access_hint(value),
            _ => value,
        }
    }

    fn explained_notebooks(&self, value: Value) -> Value {
        if is_empty_at(&value, "notebooks") {
            with_no_access_hint(value)
        } else {
            value
        }
    }

    /// The `CallToolResult` of a call; any failure is an error result with its code.
    pub fn call(&self, tool: &str, args: Value, log: &(dyn Fn(&str) + Sync)) -> Value {
        let Some(schema) = self.schema_of(tool) else {
            log("W_MCP_TOOL_UNKNOWN");
            return failed(
                "E_MCP_TOOL_UNKNOWN",
                "No tool has this name. Call tools/list.",
            );
        };
        let args = match checked(&args, schema, "arguments") {
            Ok(args) => args,
            Err(why) => {
                log(&format!("W_MCP_TOOL_FAILED {tool} E_MCP_ARGS_INVALID"));
                return failed("E_MCP_ARGS_INVALID", &why);
            }
        };
        let empty = Map::new();
        let fields = args.as_object().unwrap_or(&empty);
        let answer = request_of(tool, fields)
            .map_err(String::from)
            .and_then(|request| self.api.call(&request));
        match answer {
            Ok(value) => {
                log_written(tool, &value, log);
                text(&self.explained(tool, value))
            }
            Err(code) => {
                let code = tool_code(code);
                log(&format!("W_MCP_TOOL_FAILED {tool} {code}"));
                failed(&code, &hint(&code))
            }
        }
    }
}

fn log_written(tool: &str, value: &Value, log: &(dyn Fn(&str) + Sync)) {
    let id = value.get("id").and_then(Value::as_str).unwrap_or("");
    let code = match tool {
        "create_note" => "I_MCP_NOTE_CREATED",
        "update_note" => "I_MCP_NOTE_UPDATED",
        "trash_note" => "I_MCP_NOTE_TRASHED",
        "create_notebook" => "I_MCP_NOTEBOOK_CREATED",
        _ => return,
    };
    log(&format!("{code} {id}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Script {
        asked: Arc<Mutex<Vec<ApiRequest>>>,
        answers: Arc<Mutex<Vec<Result<Value, String>>>>,
    }

    impl Script {
        fn answering(answers: Vec<Result<Value, String>>) -> Self {
            let script = Self::default();
            *script.answers.lock().unwrap() = answers.into_iter().rev().collect();
            script
        }

        fn tools(&self) -> Tools {
            Tools::new(Box::new(self.clone()))
        }

        fn asked(&self) -> Vec<ApiRequest> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl Api for Script {
        fn call(&self, request: &ApiRequest) -> Result<Value, String> {
            self.asked.lock().unwrap().push(request.clone());
            self.answers
                .lock()
                .unwrap()
                .pop()
                .unwrap_or_else(|| Ok(json!({})))
        }
    }

    fn call(script: &Script, tool: &str, args: Value) -> Value {
        script.tools().call(tool, args, &|_: &str| {})
    }

    fn message(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap().to_string()
    }

    fn ok(result: &Value) -> Value {
        assert_eq!(result.get("isError"), None, "{result}");
        serde_json::from_str(&message(result)).unwrap()
    }

    #[test]
    fn declares_the_eight_tools_with_titles_annotations_and_schemas() {
        let tools = Script::default().tools().list();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "list_notebooks",
                "search_notes",
                "read_note",
                "list_tags",
                "create_note",
                "update_note",
                "trash_note",
                "create_notebook"
            ]
        );
        for tool in &tools {
            assert!(tool["title"].is_string(), "{tool}");
            assert!(tool["description"].is_string(), "{tool}");
            assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
            assert!(tool["annotations"]["readOnlyHint"].is_boolean(), "{tool}");
        }
        let hints =
            |name: &str| tools.iter().find(|t| t["name"] == name).unwrap()["annotations"].clone();
        for reads in ["list_notebooks", "search_notes", "read_note", "list_tags"] {
            assert_eq!(hints(reads)["readOnlyHint"], true);
        }
        assert_eq!(hints("trash_note")["destructiveHint"], true);
        assert_eq!(hints("update_note")["readOnlyHint"], false);
    }

    #[test]
    fn each_tool_makes_its_call() {
        let id = "0192a6f0-0000-7000-8000-000000000001";
        for (tool, args, method, target, body) in [
            (
                "list_notebooks",
                json!({}),
                "GET",
                "/v1/notebooks".to_string(),
                None,
            ),
            ("list_tags", json!({}), "GET", "/v1/tags".to_string(), None),
            (
                "search_notes",
                json!({ "query": "kiwi pie", "limit": 3 }),
                "GET",
                "/v1/notes?q=kiwi%20pie&limit=3".to_string(),
                None,
            ),
            (
                "read_note",
                json!({ "id": id }),
                "GET",
                format!("/v1/notes/{id}"),
                None,
            ),
            (
                "create_note",
                json!({ "title": "T", "markdown": "M", "notebook": "N" }),
                "POST",
                "/v1/notes".to_string(),
                Some(json!({ "title": "T", "markdown": "M", "notebook": "N" })),
            ),
            (
                "update_note",
                json!({ "id": id, "tags": [], "status": "active" }),
                "PATCH",
                format!("/v1/notes/{id}"),
                Some(json!({ "tags": [], "status": "active" })),
            ),
            (
                "trash_note",
                json!({ "id": id }),
                "DELETE",
                format!("/v1/notes/{id}"),
                None,
            ),
            (
                "create_notebook",
                json!({ "name": "B", "parent": "P" }),
                "POST",
                "/v1/notebooks".to_string(),
                Some(json!({ "name": "B", "parent": "P" })),
            ),
        ] {
            let script = Script::answering(vec![Ok(
                json!({ "notebooks": [1], "results": [1], "tags": [1] }),
            )]);
            ok(&call(&script, tool, args));
            assert_eq!(
                script.asked(),
                [ApiRequest {
                    method,
                    target,
                    body
                }],
                "{tool}"
            );
        }
    }

    #[test]
    fn a_note_id_that_is_no_id_stays_in_its_path_segment() {
        let script = Script::answering(vec![Err("E_NOTE_NOT_FOUND".into())]);
        let result = call(&script, "read_note", json!({ "id": "../notebooks?x=1" }));
        assert_eq!(script.asked()[0].target, "/v1/notes/..%2Fnotebooks%3Fx%3D1");
        assert_eq!(
            message(&result),
            "E_NOTE_NOT_FOUND: No note with this ID is available to AI."
        );
    }

    #[test]
    fn says_no_notebook_allows_ai_with_a_code_and_nothing_about_hidden_ones() {
        let script = Script::answering(vec![Ok(json!({ "notebooks": [] }))]);
        let answer = ok(&call(&script, "list_notebooks", json!({})));
        assert_eq!(answer["notebooks"], json!([]));
        assert_eq!(answer["code"], NO_AI_ACCESS);
        assert!(answer["hint"].as_str().unwrap().contains("Allow AI Access"));
        assert_eq!(script.asked().len(), 1);

        let script = Script::answering(vec![
            Ok(json!({ "results": [] })),
            Ok(json!({ "notebooks": [] })),
        ]);
        let answer = ok(&call(&script, "search_notes", json!({ "query": "kiwi" })));
        assert_eq!(answer["code"], NO_AI_ACCESS);

        let script = Script::answering(vec![
            Ok(json!({ "tags": [] })),
            Ok(json!({ "notebooks": [{ "id": "b", "name": "N", "notes": 0 }] })),
        ]);
        let answer = ok(&call(&script, "list_tags", json!({})));
        assert_eq!(answer.get("code"), None, "a notebook is allowed");

        let script = Script::answering(vec![Ok(json!({ "notebooks": [{ "id": "b" }] }))]);
        assert_eq!(
            ok(&call(&script, "list_notebooks", json!({}))).get("hint"),
            None
        );
    }

    #[test]
    fn checks_arguments_against_the_schema_and_sends_nothing_when_they_fail() {
        let bad = [
            ("read_note", json!({})),
            ("read_note", json!({ "id": 3 })),
            ("read_note", json!({ "id": "x".repeat(101) })),
            ("search_notes", json!({ "query": "" })),
            ("search_notes", json!({ "query": "x".repeat(1001) })),
            ("search_notes", json!({ "query": "x", "limit": 0 })),
            ("search_notes", json!({ "query": "x", "limit": 51 })),
            ("search_notes", json!({ "query": "x", "limit": 1.5 })),
            ("create_note", json!({ "title": "T", "markdown": "M" })),
            (
                "create_note",
                json!({ "title": "T", "markdown": "M", "notebook": "" }),
            ),
            ("update_note", json!({ "id": "x", "patches": [] })),
            (
                "update_note",
                json!({ "id": "x", "patches": [{ "find": "", "replace": "" }] }),
            ),
            (
                "update_note",
                json!({ "id": "x", "patches": [{ "find": "a" }] }),
            ),
            ("update_note", json!({ "id": "x", "status": "someday" })),
            ("update_note", json!({ "id": "x", "tags": ["a", 1] })),
            ("update_note", json!({ "id": "x", "title": null })),
        ];
        for (tool, args) in bad {
            let script = Script::default();
            let result = call(&script, tool, args.clone());
            assert_eq!(result["isError"], true, "{tool} {args}");
            assert!(
                message(&result).starts_with("E_MCP_ARGS_INVALID: "),
                "{tool} {args}"
            );
            assert!(script.asked().is_empty(), "{tool} {args}");
        }
    }

    #[test]
    fn a_refusal_names_where_and_never_the_value() {
        let script = Script::default();
        let result = call(
            &script,
            "update_note",
            json!({ "id": "x", "status": "my secret note text" }),
        );
        assert!(!message(&result).contains("secret"));
        assert!(message(&result).contains("arguments.status"));
    }

    #[test]
    fn leaves_out_what_the_schema_does_not_name() {
        let script = Script::answering(vec![Ok(json!({ "id": "n" }))]);
        ok(&call(
            &script,
            "update_note",
            json!({ "id": "n", "title": "T", "kind": "http", "patches": [{ "find": "a", "replace": "b", "x": 1 }] }),
        ));
        assert_eq!(
            script.asked()[0].body,
            Some(json!({ "title": "T", "patches": [{ "find": "a", "replace": "b" }] }))
        );
    }

    #[test]
    fn a_query_with_no_terms_is_the_cores_code_and_asks_nothing() {
        let script = Script::default();
        let result = call(&script, "search_notes", json!({ "query": "  " }));
        assert!(message(&result).starts_with("E_SEARCH_QUERY_EMPTY: "));
        assert!(script.asked().is_empty());
    }

    #[test]
    fn every_code_it_can_answer_comes_with_its_own_hint() {
        for code in [
            "E_NOTE_NOT_FOUND",
            "E_BOOK_NOT_FOUND",
            "E_BOOK_AMBIGUOUS",
            "E_SEARCH_QUERY_EMPTY",
            "E_NOTE_TITLE_INVALID",
            "E_NOTE_BODY_TOO_LARGE",
            "E_NOTE_LINKS_TOO_MANY",
            "E_NOTE_STATUS_INVALID",
            "E_AI_UPDATE_EMPTY",
            "E_AI_BODY_CONFLICT",
            "E_AI_PATCHES_INVALID",
            "E_AI_PATCH_NOT_FOUND",
            "E_AI_PATCH_AMBIGUOUS",
            "E_AI_TAGS_TOO_MANY",
            "E_TAG_NAME_INVALID",
            "E_BOOK_NAME_INVALID",
            "E_BOOK_NAME_TAKEN",
            "E_STORAGE_BUSY",
            "E_LICENCE_REQUIRED",
            "E_HTTP_READ_ONLY",
            "E_MCP_ACCESS_OFF",
            "E_MCP_BACKGROUND_START_OFF",
            "E_MCP_START_FAILED",
            "E_MCP_START_TIMEOUT",
            "E_MCP_NOT_READY",
            "E_MCP_TOKEN_MISSING",
            "E_MCP_KEYCHAIN_FAILED",
            "E_MCP_CONNECTION_LOST",
            "E_HTTP_API_TIMEOUT",
            "E_HTTP_RATE_LIMITED",
        ] {
            assert_ne!(hint(code), hint("E_ANYTHING_ELSE"), "{code}");
        }
        assert_eq!(
            hint("E_ANYTHING_ELSE"),
            "Devot could not complete the request."
        );
    }

    #[test]
    fn a_body_past_the_requests_limit_reads_as_the_notes_limit() {
        let script = Script::answering(vec![Err("E_HTTP_BODY_TOO_LARGE".into())]);
        let result = call(
            &script,
            "create_note",
            json!({ "title": "T", "markdown": "M", "notebook": "N" }),
        );
        assert!(message(&result).starts_with("E_NOTE_BODY_TOO_LARGE: "));
    }

    #[test]
    fn an_unknown_tool_is_an_error_result_and_logs_hold_no_content() {
        let lines = Mutex::new(Vec::new());
        let log = |line: &str| lines.lock().unwrap().push(line.to_string());
        let script = Script::answering(vec![Ok(json!({ "id": "n1", "title": "Secret title" }))]);
        let result = script.tools().call("nope", json!({}), &log);
        assert_eq!(result["isError"], true);
        script.tools().call(
            "create_note",
            json!({ "title": "Secret title", "markdown": "Secret body", "notebook": "N" }),
            &log,
        );
        let lines = lines.into_inner().unwrap();
        assert_eq!(lines, ["W_MCP_TOOL_UNKNOWN", "I_MCP_NOTE_CREATED n1"]);
    }
}
