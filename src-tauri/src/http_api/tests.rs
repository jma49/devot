//! Each guard over a real socket on 127.0.0.1, with the core faked by a dispatcher that records
//! what reached it; and the contract with the core (`tests/support/http-api-calls.json`).

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use super::routes::{self, Call, Op};
use super::server::{Dispatch, Gate, Limits, Server, status_of};
use super::settings::SettingsStore;
use super::token::{self, MemoryTokens, Scope, TokenStore};
use super::*;

const NOTE: &str = "01890a5d-ac96-774b-bcce-b302099a8057";

#[derive(Default)]
struct Core {
    calls: Mutex<Vec<Call>>,
    fail: Mutex<Option<String>>,
}

impl Dispatch for Core {
    fn dispatch(&self, call: &Call) -> Result<Value, String> {
        self.calls.lock().unwrap().push(call.clone());
        if let Some(code) = self.fail.lock().unwrap().clone() {
            return Err(code);
        }
        Ok(if call.op.creates() {
            json!({ "id": NOTE })
        } else {
            json!({ "op": call.op.as_str() })
        })
    }
}

impl Core {
    fn reached(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

struct Api {
    server: Server,
    gate: Arc<Gate>,
    core: Arc<Core>,
    token: String,
}

fn quick(limits: Limits) -> Limits {
    Limits {
        read_deadline: Duration::from_millis(500),
        ..limits
    }
}

fn start_with(scope: Scope, limits: Limits) -> Api {
    let gate = Arc::new(Gate::new(quick(limits)));
    let token = token::generate().unwrap();
    let sent = token.as_str().to_string();
    gate.allow(token, scope);
    let core = Arc::new(Core::default());
    let server = Server::start(0, Arc::clone(&gate), core.clone()).unwrap();
    Api {
        server,
        gate,
        core,
        token: sent,
    }
}

fn start(scope: Scope) -> Api {
    start_with(scope, Limits::DEFAULT)
}

struct Response {
    status: u16,
    head: String,
    body: Value,
}

impl Response {
    fn code(&self) -> &str {
        self.body["error"].as_str().unwrap_or("")
    }

    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (n, v) = line.split_once(':')?;
            n.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    }
}

fn send_raw(port: u16, bytes: &[u8]) -> Response {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream.write_all(bytes).unwrap();
    read_response(&mut stream)
}

fn read_response(stream: &mut TcpStream) -> Response {
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out);
    let text = String::from_utf8(out).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").expect("a whole response");
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    Response {
        status,
        head: head.to_string(),
        body: serde_json::from_str(body).unwrap_or(Value::Null),
    }
}

/// A request as a tool sends it: the right Host, a JSON body when there is one.
fn request(api: &Api, method: &str, target: &str, extra: &[&str], body: Option<&str>) -> Response {
    let port = api.server.port();
    let mut text = format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    for line in extra {
        text.push_str(line);
        text.push_str("\r\n");
    }
    if let Some(body) = body {
        text.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    text.push_str("\r\n");
    text.push_str(body.unwrap_or(""));
    send_raw(port, text.as_bytes())
}

fn bearer(api: &Api) -> String {
    format!("Authorization: Bearer {}", api.token)
}

fn authorized(api: &Api, method: &str, target: &str, body: Option<&str>) -> Response {
    request(api, method, target, &[&bearer(api)], body)
}

fn assert_no_cors(response: &Response) {
    assert!(
        !response
            .head
            .to_ascii_lowercase()
            .contains("access-control-"),
        "{}",
        response.head
    );
}

#[test]
fn listens_on_127_0_0_1_only() {
    let api = start(Scope::Read);
    assert_eq!(
        api.server.address(),
        SocketAddr::from((Ipv4Addr::LOCALHOST, api.server.port()))
    );
    assert_eq!(authorized(&api, "GET", "/v1/notebooks", None).status, 200);
}

#[test]
fn refuses_a_request_without_the_token() {
    let api = start(Scope::ReadWrite);
    for extra in [
        vec![],
        vec!["Authorization: Basic dXNlcjpwYXNz"],
        vec!["Authorization: Bearer"],
        vec!["Authorization: bearer "],
    ] {
        let response = request(&api, "GET", "/v1/notebooks", &extra, None);
        assert_eq!(
            (response.status, response.code()),
            (401, "E_HTTP_TOKEN_MISSING"),
            "{extra:?}"
        );
        assert_eq!(
            response.header("WWW-Authenticate").as_deref(),
            Some("Bearer")
        );
        assert_no_cors(&response);
    }
    assert_eq!(api.core.reached(), 0);
}

#[test]
fn refuses_a_wrong_or_stale_token() {
    let api = start(Scope::ReadWrite);
    let other = token::generate().unwrap();
    let mut near = api.token.clone();
    near.pop();
    near.push(if api.token.ends_with('A') { 'B' } else { 'A' });
    for sent in [other.as_str(), near.as_str(), &api.token[..20], "dvt_"] {
        let auth = format!("Authorization: Bearer {sent}");
        let response = request(&api, "GET", "/v1/notebooks", &[&auth], None);
        assert_eq!(
            (response.status, response.code()),
            (401, "E_HTTP_TOKEN_INVALID")
        );
    }
    // Two Authorization headers are never read as either.
    let both = request(
        &api,
        "GET",
        "/v1/notebooks",
        &[&bearer(&api), "Authorization: Bearer x"],
        None,
    );
    assert_eq!(both.status, 400);
    // A new token takes effect at once; the old one stops working.
    let fresh = token::generate().unwrap();
    let fresh_text = fresh.as_str().to_string();
    api.gate.allow(fresh, Scope::ReadWrite);
    assert_eq!(authorized(&api, "GET", "/v1/notebooks", None).status, 401);
    let auth = format!("Authorization: Bearer {fresh_text}");
    assert_eq!(
        request(&api, "GET", "/v1/notebooks", &[&auth], None).status,
        200
    );
    api.gate.close();
    assert_eq!(
        request(&api, "GET", "/v1/notebooks", &[&auth], None).status,
        401
    );
    assert_eq!(api.core.reached(), 1);
}

#[test]
fn refuses_a_host_other_than_this_machine_on_this_port() {
    let api = start(Scope::Read);
    let port = api.server.port();
    let auth = bearer(&api);
    for host in [
        format!("evil.test:{port}"),
        format!("127.0.0.1:{}", port.wrapping_add(1)),
        format!("127.0.0.2:{port}"),
        format!("[::1]:{port}"),
        format!("localhost.evil.test:{port}"),
        "127.0.0.1".to_string(),
        "localhost".to_string(),
        String::new(),
    ] {
        let raw = format!("GET /v1/notebooks HTTP/1.1\r\nHost: {host}\r\n{auth}\r\n\r\n");
        let response = send_raw(port, raw.as_bytes());
        assert_eq!(
            (response.status, response.code()),
            (403, "E_HTTP_HOST_REFUSED"),
            "{host}"
        );
        assert_no_cors(&response);
    }
    let missing = send_raw(
        port,
        format!("GET /v1/notebooks HTTP/1.0\r\n{auth}\r\n\r\n").as_bytes(),
    );
    assert_eq!(missing.code(), "E_HTTP_HOST_REFUSED");
    let twice = format!(
        "GET /v1/notebooks HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nHost: evil.test\r\n{auth}\r\n\r\n"
    );
    assert_eq!(send_raw(port, twice.as_bytes()).status, 400);
    assert_eq!(api.core.reached(), 0);
    for host in [format!("localhost:{port}"), format!("LocalHost:{port}")] {
        let raw = format!("GET /v1/notebooks HTTP/1.1\r\nHost: {host}\r\n{auth}\r\n\r\n");
        assert_eq!(send_raw(port, raw.as_bytes()).status, 200, "{host}");
    }
}

#[test]
fn refuses_any_request_a_browser_sends() {
    let api = start(Scope::ReadWrite);
    let port = api.server.port();
    let auth = bearer(&api);
    for origin in [
        "Origin: https://evil.test".to_string(),
        format!("Origin: http://127.0.0.1:{port}"),
        format!("Origin: http://localhost:{port}"),
        "Origin: null".to_string(),
        "Origin:".to_string(),
    ] {
        for method in ["GET", "OPTIONS"] {
            let response = request(&api, method, "/v1/notebooks", &[&auth, &origin], None);
            assert_eq!(
                (response.status, response.code()),
                (403, "E_HTTP_ORIGIN_REFUSED"),
                "{method} {origin}"
            );
            assert_no_cors(&response);
        }
    }
    let fetched = request(
        &api,
        "GET",
        "/v1/notebooks",
        &[&auth, "Sec-Fetch-Site: same-origin"],
        None,
    );
    assert_eq!(
        (fetched.status, fetched.code()),
        (403, "E_HTTP_BROWSER_REFUSED")
    );
    assert_eq!(api.core.reached(), 0);
}

#[test]
fn never_sends_cors_headers() {
    let api = start(Scope::ReadWrite);
    let note = format!("/v1/notes/{NOTE}");
    for response in [
        authorized(&api, "GET", "/v1/notebooks", None),
        authorized(&api, "GET", &note, None),
        authorized(&api, "OPTIONS", "/v1/notebooks", None),
        authorized(&api, "GET", "/nowhere", None),
        request(&api, "GET", "/v1/tags", &[], None),
    ] {
        assert_no_cors(&response);
        assert_eq!(
            response.header("Content-Type").as_deref(),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(
            response.header("Cache-Control").as_deref(),
            Some("no-store")
        );
    }
}

#[test]
fn refuses_an_oversize_request_before_reading_it() {
    let api = start(Scope::ReadWrite);
    let port = api.server.port();
    let auth = bearer(&api);
    let max = Limits::DEFAULT.max_body;
    // The length alone refuses it: no body is sent.
    let raw = format!(
        "POST /v1/notes HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        max + 1
    );
    let response = send_raw(port, raw.as_bytes());
    assert_eq!(
        (response.status, response.code()),
        (413, "E_HTTP_BODY_TOO_LARGE")
    );
    let huge = format!(
        "POST /v1/notes HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}\r\nContent-Type: application/json\r\nContent-Length: 99999999999999999999999\r\n\r\n"
    );
    assert_eq!(
        send_raw(port, huge.as_bytes()).code(),
        "E_HTTP_BODY_TOO_LARGE"
    );
    // Headers past their limit.
    let padding = format!("X-Pad: {}\r\n", "p".repeat(20 * 1024));
    let raw = format!("GET /v1/tags HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}\r\n{padding}\r\n");
    let response = send_raw(port, raw.as_bytes());
    assert_eq!(
        (response.status, response.code()),
        (431, "E_HTTP_HEADERS_TOO_LARGE")
    );
    let many: String = (0..80).map(|i| format!("X-{i}: 1\r\n")).collect();
    let raw = format!("GET /v1/tags HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}\r\n{many}\r\n");
    assert_eq!(send_raw(port, raw.as_bytes()).status, 431);
    // A body within the request limit whose Markdown is past what one call may send.
    let markdown = "m".repeat(routes::MAX_MARKDOWN_BYTES + 1);
    let body = json!({ "title": "Big", "markdown": markdown, "notebook": "Shared" }).to_string();
    let response = authorized(&api, "POST", "/v1/notes", Some(&body));
    assert_eq!(
        (response.status, response.code()),
        (413, "E_NOTE_BODY_TOO_LARGE")
    );
    assert_eq!(api.core.reached(), 0);
}

#[test]
fn limits_the_rate_of_a_token_and_says_when_to_try_again() {
    let api = start_with(
        Scope::Read,
        Limits {
            burst: 3.0,
            per_second: 0.01,
            ..Limits::DEFAULT
        },
    );
    // Refused requests do not use the token's allowance up.
    for _ in 0..5 {
        assert_eq!(request(&api, "GET", "/v1/tags", &[], None).status, 401);
    }
    for _ in 0..3 {
        assert_eq!(authorized(&api, "GET", "/v1/tags", None).status, 200);
    }
    let limited = authorized(&api, "GET", "/v1/tags", None);
    assert_eq!(
        (limited.status, limited.code()),
        (429, "E_HTTP_RATE_LIMITED")
    );
    let wait: u64 = limited.header("Retry-After").unwrap().parse().unwrap();
    assert!((1..=100).contains(&wait), "{wait}");
    assert_eq!(api.core.reached(), 3);
}

#[test]
fn a_read_only_token_reads_and_never_writes() {
    let api = start(Scope::Read);
    let note = format!("/v1/notes/{NOTE}");
    assert_eq!(authorized(&api, "GET", &note, None).status, 200);
    assert_eq!(
        authorized(&api, "GET", "/v1/notes?q=kiwi", None).status,
        200
    );
    for (method, target, body) in [
        (
            "POST",
            "/v1/notes",
            Some(r#"{"title":"a","markdown":"","notebook":"b"}"#),
        ),
        ("PATCH", note.as_str(), Some(r#"{"title":"a"}"#)),
        ("DELETE", note.as_str(), None),
        ("POST", "/v1/notebooks", Some(r#"{"name":"a"}"#)),
    ] {
        let response = authorized(&api, method, target, body);
        assert_eq!(
            (response.status, response.code()),
            (403, "E_HTTP_READ_ONLY"),
            "{method} {target}"
        );
    }
    assert_eq!(api.core.reached(), 2);
}

#[test]
fn takes_json_only() {
    let api = start(Scope::ReadWrite);
    let port = api.server.port();
    let auth = bearer(&api);
    let note = format!("/v1/notes/{NOTE}");
    let post = |content_type: &str, body: &str| {
        let raw = format!(
            "PATCH {note} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}\r\n{content_type}Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        send_raw(port, raw.as_bytes())
    };
    for content_type in [
        "",
        "Content-Type: text/plain\r\n",
        "Content-Type: application/x-www-form-urlencoded\r\n",
        "Content-Type: application/json; charset=latin1\r\n",
    ] {
        let response = post(content_type, r#"{"title":"a"}"#);
        assert_eq!(
            (response.status, response.code()),
            (415, "E_HTTP_JSON_REQUIRED"),
            "{content_type}"
        );
    }
    assert_eq!(
        post(
            "Content-Type: Application/JSON; charset=UTF-8\r\n",
            r#"{"title":"a"}"#
        )
        .status,
        200
    );
    for body in [
        "title=a",
        "[]",
        r#"{"title":"a","extra":1}"#,
        r#"{"title":3}"#,
        r#"{"status":"urgent"}"#,
        "{",
    ] {
        let response = authorized(&api, "PATCH", &note, Some(body));
        assert_eq!(
            (response.status, response.code()),
            (400, "E_HTTP_BODY_INVALID"),
            "{body}"
        );
    }
    let chunked = format!(
        "POST /v1/notes HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
    );
    assert_eq!(
        send_raw(port, chunked.as_bytes()).code(),
        "E_HTTP_LENGTH_REQUIRED"
    );
    let unlengthed = format!(
        "POST /v1/notes HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}\r\nContent-Type: application/json\r\n\r\n"
    );
    assert_eq!(
        send_raw(port, unlengthed.as_bytes()).code(),
        "E_HTTP_LENGTH_REQUIRED"
    );
    let response = authorized(&api, "GET", "/v1/tags", Some("{}"));
    assert_eq!(
        (response.status, response.code()),
        (400, "E_HTTP_BODY_UNEXPECTED")
    );
    assert_eq!(api.core.reached(), 1);
}

#[test]
fn checks_arguments_before_the_core_sees_them() {
    let api = start(Scope::ReadWrite);
    let note = format!("/v1/notes/{NOTE}");
    type Case<'a> = (&'a str, String, Option<String>, (u16, &'a str));
    let cases: Vec<Case> = vec![
        (
            "GET",
            "/v1/notes".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/notes?q=".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/notes?q=a&limit=0".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/notes?q=a&limit=51".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/notes?q=a&q=b".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/notes?q=%ZZ".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/notes?q=%FF".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/notes?q=a&sort=x".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            format!("/v1/notes?q={}", "a".repeat(1_001)),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/tags?x=1".into(),
            None,
            (400, "E_HTTP_QUERY_INVALID"),
        ),
        (
            "GET",
            "/v1/notes/not-an-id".into(),
            None,
            (404, "E_NOTE_NOT_FOUND"),
        ),
        (
            "GET",
            "/v1/notes/0189".into(),
            None,
            (404, "E_NOTE_NOT_FOUND"),
        ),
        ("GET", "/v1/nothing".into(), None, (404, "E_HTTP_NOT_FOUND")),
        (
            "PUT",
            "/v1/notes".into(),
            None,
            (405, "E_HTTP_METHOD_NOT_ALLOWED"),
        ),
        (
            "POST",
            "/v1/tags".into(),
            Some("{}".into()),
            (405, "E_HTTP_METHOD_NOT_ALLOWED"),
        ),
        (
            "PATCH",
            note.clone(),
            Some("{}".into()),
            (400, "E_AI_UPDATE_EMPTY"),
        ),
        (
            "PATCH",
            note.clone(),
            Some(r#"{"markdown":"a","patches":[{"find":"a","replace":"b"}]}"#.into()),
            (400, "E_AI_BODY_CONFLICT"),
        ),
        (
            "PATCH",
            note.clone(),
            Some(r#"{"patches":[]}"#.into()),
            (400, "E_AI_PATCHES_INVALID"),
        ),
        (
            "PATCH",
            note.clone(),
            Some(r#"{"patches":[{"find":"","replace":"b"}]}"#.into()),
            (400, "E_AI_PATCHES_INVALID"),
        ),
        (
            "PATCH",
            note.clone(),
            Some(json!({ "tags": vec!["t"; 51] }).to_string()),
            (400, "E_AI_TAGS_TOO_MANY"),
        ),
        (
            "PATCH",
            note.clone(),
            Some(json!({ "title": "t".repeat(4_001) }).to_string()),
            (400, "E_NOTE_TITLE_INVALID"),
        ),
        (
            "PATCH",
            note.clone(),
            Some(r#"{"notebook":""}"#.into()),
            (404, "E_BOOK_NOT_FOUND"),
        ),
        (
            "POST",
            "/v1/notes".into(),
            Some(r#"{"title":"a","markdown":""}"#.into()),
            (400, "E_HTTP_BODY_INVALID"),
        ),
        (
            "POST",
            "/v1/notebooks".into(),
            Some(json!({ "name": "n".repeat(801) }).to_string()),
            (400, "E_BOOK_NAME_INVALID"),
        ),
    ];
    for (method, target, body, expected) in cases {
        let response = authorized(&api, method, &target, body.as_deref());
        assert_eq!(
            (response.status, response.code()),
            expected,
            "{method} {target} {body:?}"
        );
    }
    assert_eq!(api.core.reached(), 0);
}

#[test]
fn answers_what_the_core_answers_with_codes_alone() {
    let api = start(Scope::ReadWrite);
    let note = format!("/v1/notes/{NOTE}");
    for (code, status) in [
        ("E_NOTE_NOT_FOUND", 404),
        ("E_BOOK_NAME_TAKEN", 409),
        ("E_AI_PATCH_NOT_FOUND", 409),
        ("E_NOTE_TITLE_INVALID", 400),
        ("E_STORAGE_BUSY", 503),
        ("E_HTTP_API_TIMEOUT", 504),
        ("E_HTTP_API_UNAVAILABLE", 503),
        ("E_HTTP_API_FAILED", 500),
    ] {
        *api.core.fail.lock().unwrap() = Some(code.into());
        let response = authorized(&api, "GET", &note, None);
        assert_eq!(
            (response.status, &response.body),
            (status, &json!({ "error": code }))
        );
    }
}

#[test]
fn gives_up_on_a_request_that_does_not_arrive_in_time() {
    let api = start(Scope::Read);
    let port = api.server.port();
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .write_all(b"GET /v1/tags HTTP/1.1\r\nHost: 127.0.0.1")
        .unwrap();
    let response = read_response(&mut stream);
    assert_eq!((response.status, response.code()), (408, "E_HTTP_TIMEOUT"));
}

#[test]
fn turns_away_connections_past_its_limit() {
    let api = start_with(
        Scope::Read,
        Limits {
            max_connections: 1,
            read_deadline: Duration::from_secs(3),
            ..Limits::DEFAULT
        },
    );
    let port = api.server.port();
    let mut held = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    held.write_all(b"GET").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let response = request(&api, "GET", "/v1/tags", &[&bearer(&api)], None);
    assert_eq!((response.status, response.code()), (503, "E_HTTP_API_BUSY"));
    drop(held);
}

#[test]
fn stops_listening_when_dropped() {
    let api = start(Scope::Read);
    let port = api.server.port();
    drop(api.server);
    assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
}

#[test]
fn logs_each_request_by_call_status_and_note_never_content() {
    crate::test_log::capture();
    let api = start(Scope::ReadWrite);
    let body = r#"{"title":"Secret plan","markdown":"secret words","notebook":"Shared"}"#;
    assert_eq!(
        authorized(&api, "POST", "/v1/notes", Some(body)).status,
        201
    );
    let patch = r#"{"title":"Secret plan B"}"#;
    assert_eq!(
        authorized(&api, "PATCH", &format!("/v1/notes/{NOTE}"), Some(patch)).status,
        200
    );
    let lines = crate::test_log::lines();
    assert!(
        lines.contains(&format!("INFO I_HTTP_API_REQUEST notes.create 201 {NOTE}")),
        "{lines:?}"
    );
    assert!(
        lines.contains(&format!("INFO I_HTTP_API_REQUEST notes.update 200 {NOTE}")),
        "{lines:?}"
    );
    assert!(
        !lines
            .iter()
            .any(|l| l.contains("ecret") || l.contains(&api.token)),
        "{lines:?}"
    );
}

#[test]
fn maps_codes_to_statuses() {
    assert_eq!(status_of("E_BOOK_NOT_FOUND"), 404);
    assert_eq!(status_of("E_SEARCH_QUERY_EMPTY"), 400);
    assert_eq!(status_of("E_NOTE_LINKS_TOO_MANY"), 400);
    assert_eq!(status_of("E_NOTE_BODY_TOO_LARGE"), 413);
    assert_eq!(status_of("E_CORE_NOT_READY"), 503);
    assert_eq!(status_of("E_SOMETHING"), 500);
}

/// The calls of `tests/support/http-api-calls.json`, which `tests/core/http-api.test.ts` runs in
/// the core: each request routes to exactly that call, over the socket too.
#[test]
fn routes_each_request_of_the_contract_to_its_call() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../tests/support/http-api-calls.json")).unwrap();
    let api = start(Scope::ReadWrite);
    for (i, case) in cases.iter().enumerate() {
        let text = |key: &str| case[key].as_str().unwrap().replace("{note}", NOTE);
        let (method, target) = (text("method"), text("target"));
        let body = case.get("body").map(Value::to_string);
        let (path, query) = match target.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (target.as_str(), None),
        };
        let (op, note) = routes::route(&method, path).unwrap();
        let call = routes::call(op, note, query, body.as_deref().unwrap_or("").as_bytes()).unwrap();
        let expected = &case["call"];
        assert_eq!(call.op.as_str(), expected["op"], "{}", case["name"]);
        assert_eq!(
            call.note.as_deref(),
            expected["note"]
                .as_str()
                .map(|n| n.replace("{note}", NOTE))
                .as_deref()
        );
        assert_eq!(call.args, expected["args"], "{}", case["name"]);

        let response = authorized(&api, &method, &target, body.as_deref());
        assert_eq!(
            u64::from(response.status),
            case["status"].as_u64().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(api.core.calls.lock().unwrap()[i], call);
    }
    let routed: std::collections::HashSet<_> = cases
        .iter()
        .map(|c| c["call"]["op"].as_str().unwrap())
        .collect();
    for op in [
        Op::NotebooksList,
        Op::NotebooksCreate,
        Op::TagsList,
        Op::NotesSearch,
        Op::NotesCreate,
        Op::NotesRead,
        Op::NotesUpdate,
        Op::NotesTrash,
    ] {
        assert!(routed.contains(op.as_str()), "{}", op.as_str());
    }
}

#[test]
fn decodes_query_values_as_forms_send_them() {
    assert_eq!(
        routes::decode_component("a+b%20c").as_deref(),
        Some("a b c")
    );
    assert_eq!(
        routes::decode_component("%C3%A9").as_deref(),
        Some("\u{e9}")
    );
    for bad in ["%", "%2", "%G0", "%C3"] {
        assert_eq!(routes::decode_component(bad), None, "{bad}");
    }
}

fn call(op: Op) -> Call {
    Call {
        op,
        note: Some(NOTE.into()),
        args: json!({}),
    }
}

#[test]
fn hands_the_window_each_call_with_its_id_and_passes_its_answer_on_once() {
    let answers = Arc::new(Answers::default());
    let sent = Arc::new(Mutex::new(Vec::new()));
    let (asking, record) = (Arc::clone(&answers), Arc::clone(&sent));
    let waiting = std::thread::spawn(move || {
        asking.ask(&call(Op::NotesRead), Duration::from_secs(5), |request| {
            record.lock().unwrap().push(request);
            true
        })
    });
    while sent.lock().unwrap().is_empty() {
        std::thread::sleep(Duration::from_millis(5));
    }
    let request = sent.lock().unwrap()[0].clone();
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        json!({ "id": request.id, "op": "notes.read", "note": NOTE, "args": {} })
    );
    assert!(answers.answer(request.id, Ok(json!({ "title": "Plan" }))));
    assert!(!answers.answer(request.id, Ok(json!({}))));
    assert_eq!(waiting.join().unwrap(), Ok(json!({ "title": "Plan" })));
}

#[test]
fn a_call_no_window_takes_or_answers_in_time_fails_with_a_code() {
    let answers = Answers::default();
    let unheard = answers.ask(&call(Op::NotesRead), Duration::from_secs(5), |_| false);
    assert_eq!(unheard, Err("E_HTTP_API_UNAVAILABLE".into()));
    let mut id = 0;
    let late = answers.ask(&call(Op::NotesRead), Duration::from_millis(20), |r| {
        id = r.id;
        true
    });
    assert_eq!(late, Err("E_HTTP_API_TIMEOUT".into()));
    assert!(!answers.answer(id, Ok(json!({}))));
}

#[test]
fn passes_on_codes_from_the_window_and_nothing_else() {
    assert_eq!(
        answer_from(None, Some("E_NOTE_NOT_FOUND".into())),
        Err("E_NOTE_NOT_FOUND".into())
    );
    assert_eq!(answer_from(Some(json!(1)), None), Ok(json!(1)));
    assert_eq!(answer_from(None, None), Ok(Value::Null));
    for bad in [
        "the note text",
        "W_NOTE",
        "E_lower",
        &format!("E_{}", "A".repeat(90)),
    ] {
        assert_eq!(
            answer_from(None, Some(bad.into())),
            Err("E_HTTP_API_FAILED".into()),
            "{bad}"
        );
    }
}

/// A port nothing listens on now; another process could take it before the test does.
fn free_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn api(dir: &tempfile::TempDir) -> (HttpApi, Arc<MemoryTokens>, Arc<Core>) {
    let tokens = Arc::new(MemoryTokens::default());
    let core = Arc::new(Core::default());
    let api = HttpApi::new(
        SettingsStore::new(&dir.path().join(settings::FILE)),
        tokens.clone(),
        core.clone(),
        Arc::new(Answers::default()),
        Limits::DEFAULT,
    );
    (api, tokens, core)
}

#[test]
fn is_off_until_turned_on_and_makes_a_read_only_token_then() {
    let dir = tempfile::tempdir().unwrap();
    let (api, tokens, _core) = api(&dir);
    api.apply();
    let view = api.view();
    assert!(!view.enabled && view.listening.is_none() && view.problem.is_none());
    assert_eq!(view.token, TokenState::Unset);
    let port = free_port();
    let on = api.set(true, port).unwrap();
    assert_eq!(
        (on.listening, on.scope, on.token),
        (Some(port), Scope::Read, TokenState::Set)
    );
    let token = tokens.get().unwrap().unwrap();
    assert!(token::is_token(&token));
    assert_eq!(api.reveal().unwrap().as_str(), token.as_str());
    let off = api.set(false, port).unwrap();
    assert_eq!(off.listening, None);
    assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
    assert_eq!(api.set(true, 80), Err("E_HTTP_API_PORT_INVALID"));
}

#[test]
fn a_new_token_replaces_the_old_one_at_once_with_its_scope() {
    let dir = tempfile::tempdir().unwrap();
    let (api, tokens, core) = api(&dir);
    let port = free_port();
    api.set(true, port).unwrap();
    let old = tokens.get().unwrap().unwrap().as_str().to_string();
    let view = api.rotate(Scope::ReadWrite).unwrap();
    assert_eq!((view.scope, view.listening), (Scope::ReadWrite, Some(port)));
    let new = tokens.get().unwrap().unwrap().as_str().to_string();
    assert_ne!(old, new);
    let send = |token: &str, method: &str| {
        let raw = format!(
            "{method} /v1/notes/{NOTE} HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer {token}\r\n\r\n"
        );
        send_raw(port, raw.as_bytes()).status
    };
    assert_eq!(send(&old, "GET"), 401);
    assert_eq!(send(&new, "DELETE"), 200);
    assert_eq!(core.reached(), 1);
}

#[test]
fn a_port_in_use_is_reported_and_tried_again_on_the_next_change() {
    let dir = tempfile::tempdir().unwrap();
    let (api, _tokens, _core) = api(&dir);
    let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = taken.local_addr().unwrap().port();
    let view = api.set(true, port).unwrap();
    assert_eq!(
        (view.listening, view.problem),
        (None, Some("E_HTTP_API_PORT_IN_USE"))
    );
    drop(taken);
    let view = api.set(true, port).unwrap();
    assert_eq!((view.listening, view.problem), (Some(port), None));
}
