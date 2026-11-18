//! The contract every provider keeps, run against a mock HTTP provider on this machine: one case table per implementation, the same expectations for all.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use super::keychain::{KeyStore, MemoryKeys};
use super::provider::{GenerateRequest, Message, ProviderId, Role, Stop};
use super::settings::{AiSettings, FILE, SettingsStore};
use super::{Ai, KeyState, Snapshot, StreamKey, Streams};
use crate::licence::Gate;

const KEY: &str = "test-key-0123456789";
const PROMPT_CANARY: &str = "PROMPT-CANARY-7731";

struct Seen {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}

type Reply = (u16, String, Vec<(&'static str, String)>);
type Edit = fn(&mut GenerateRequest);

struct Mock {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Mock {
    /// Answers the requests that come, in order, with `replies` (status, body, extra headers); a request after the last gets the last again.
    fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for (n, stream) in listener.incoming().enumerate() {
                let Ok(mut stream) = stream else { return };
                let request = read_request(&mut stream);
                log.lock().unwrap().push(request);
                let (status, body, headers) = &replies[n.min(replies.len() - 1)];
                let extra: String = headers
                    .iter()
                    .map(|(k, v)| format!("{k}: {v}\r\n"))
                    .collect();
                let head = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        Self { base, seen }
    }

    fn replying(status: u16, body: impl Into<String>) -> Self {
        Self::start(vec![(status, body.into(), vec![])])
    }

    fn hits(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Seen {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).unwrap();
        raw.extend_from_slice(&chunk[..n]);
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        assert!(n > 0, "request ended inside its head");
    };
    let head = String::from_utf8(raw[..head_end].to_vec()).unwrap();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap().split(' ');
    let (method, path) = (
        first.next().unwrap().to_string(),
        first.next().unwrap().to_string(),
    );
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers["content-length"].parse().unwrap();
    while raw.len() < head_end + length {
        let n = stream.read(&mut chunk).unwrap();
        raw.extend_from_slice(&chunk[..n]);
    }
    Seen {
        method,
        path,
        headers,
        body: serde_json::from_slice(&raw[head_end..head_end + length]).unwrap(),
    }
}

/// What one implementation promises, in its own wire format.
struct Contract {
    id: ProviderId,
    path: &'static str,
    ok: fn(&str) -> Value,
    truncated: Value,
    refusal: Value,
    wrong_shape: Value,
    check_auth: fn(&Seen),
    check_body: fn(&Seen),
}

fn contracts() -> [Contract; 2] {
    [
        Contract {
            id: ProviderId::Anthropic,
            path: "/v1/messages",
            ok: |text| {
                json!({
                    "id": "msg_1", "type": "message", "role": "assistant", "model": "m",
                    "content": [
                        {"type": "text", "text": text},
                        {"type": "thinking", "thinking": "hidden"},
                        {"type": "text", "text": " more"}
                    ],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 11, "output_tokens": 7}
                })
            },
            truncated: json!({"content": [{"type": "text", "text": "cut"}], "stop_reason": "max_tokens"}),
            refusal: json!({"content": [], "stop_reason": "refusal"}),
            wrong_shape: json!({"content": "a string", "stop_reason": "end_turn"}),
            check_auth: |seen| {
                assert_eq!(seen.headers["x-api-key"], KEY);
                assert_eq!(seen.headers["anthropic-version"], "2023-06-01");
                assert!(!seen.headers.contains_key("authorization"));
            },
            check_body: |seen| {
                assert_eq!(seen.body["system"], "Be brief.");
                assert_eq!(seen.body["max_tokens"], 256);
                assert_eq!(seen.body["messages"].as_array().unwrap().len(), 3);
                assert_eq!(seen.body["messages"][1]["role"], "assistant");
            },
        },
        Contract {
            id: ProviderId::Openai,
            path: "/chat/completions",
            ok: |text| {
                json!({
                    "id": "c1", "object": "chat.completion",
                    "choices": [{"index": 0, "finish_reason": "stop",
                        "message": {"role": "assistant", "content": format!("{text} more")}}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}
                })
            },
            truncated: json!({"choices": [{"finish_reason": "length", "message": {"content": "cut"}}]}),
            refusal: json!({"choices": [{"finish_reason": "stop", "message": {"content": null, "refusal": "no"}}]}),
            wrong_shape: json!({"choices": []}),
            check_auth: |seen| {
                assert_eq!(seen.headers["authorization"], format!("Bearer {KEY}"));
                assert!(!seen.headers.contains_key("x-api-key"));
            },
            check_body: |seen| {
                assert_eq!(seen.body["max_completion_tokens"], 256);
                let messages = seen.body["messages"].as_array().unwrap();
                assert_eq!(messages.len(), 4);
                assert_eq!(messages[0]["role"], "system");
                assert_eq!(messages[0]["content"], "Be brief.");
            },
        },
    ]
}

struct Setup {
    _dir: tempfile::TempDir,
    ai: Ai,
    keys: Arc<MemoryKeys>,
}

/// An app whose `id` provider talks to `base` with model `model-x`.
fn setup(id: ProviderId, base: &str) -> Setup {
    setup_with(id, base, Gate::open())
}

fn setup_with(id: ProviderId, base: &str, licence: Gate) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(&dir.path().join(FILE));
    let mut settings = store.get();
    settings.active = id;
    for p in [&mut settings.anthropic, &mut settings.openai] {
        p.endpoint = base.to_string();
        p.model = "model-x".into();
    }
    store.set(settings).unwrap();
    let keys = Arc::new(MemoryKeys::default());
    let ai = Ai::new(store, Arc::clone(&keys) as Arc<dyn KeyStore>, licence);
    Setup {
        _dir: dir,
        ai,
        keys,
    }
}

fn ask() -> GenerateRequest {
    let message = |role, content: &str| Message {
        role,
        content: content.into(),
    };
    GenerateRequest {
        provider: None,
        system: Some("Be brief.".into()),
        messages: vec![
            message(Role::User, &format!("Summarise {PROMPT_CANARY}")),
            message(Role::Assistant, "Sure."),
            message(Role::User, "Shorter."),
        ],
        max_tokens: Some(256),
        timeout_secs: None,
    }
}

#[test]
fn every_provider_sends_its_request_and_returns_the_text() {
    for c in contracts() {
        let mock = Mock::replying(200, (c.ok)("Hello").to_string());
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        let got = app.ai.generate(&ask()).unwrap();
        assert_eq!(got.provider, c.id);
        assert_eq!(got.model, "model-x");
        assert!(got.text.starts_with("Hello"), "{:?}: {}", c.id, got.text);
        assert_eq!(got.stop, Stop::End);
        let usage = got.usage.unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens), (11, 7));
        let seen = mock.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            (seen[0].method.as_str(), seen[0].path.as_str()),
            ("POST", c.path)
        );
        assert_eq!(seen[0].body["model"], "model-x");
        assert!(seen[0].body.to_string().contains(PROMPT_CANARY));
        (c.check_auth)(&seen[0]);
        (c.check_body)(&seen[0]);
    }
}

#[test]
fn the_key_is_in_a_header_and_never_in_the_body_or_the_path() {
    for c in contracts() {
        let mock = Mock::replying(200, (c.ok)("Hi").to_string());
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        app.ai.generate(&ask()).unwrap();
        let seen = mock.seen.lock().unwrap();
        assert!(!seen[0].body.to_string().contains(KEY));
        assert!(!seen[0].path.contains(KEY));
    }
}

#[test]
fn a_cut_off_answer_says_so_and_a_refusal_is_a_code() {
    for c in contracts() {
        let mock = Mock::replying(200, c.truncated.to_string());
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        let got = app.ai.generate(&ask()).unwrap();
        assert_eq!((got.text.as_str(), got.stop), ("cut", Stop::MaxTokens));
        assert_eq!(got.usage, None);

        let mock = Mock::replying(200, c.refusal.to_string());
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_AI_REFUSED");
    }
}

#[test]
fn a_response_of_the_wrong_shape_is_a_code() {
    for c in contracts() {
        for body in [c.wrong_shape.to_string(), "not json".into(), String::new()] {
            let mock = Mock::replying(200, body);
            let app = setup(c.id, &mock.base);
            app.keys.set(c.id, KEY).unwrap();
            assert_eq!(
                app.ai.generate(&ask()).unwrap_err(),
                "E_AI_RESPONSE_INVALID",
                "{:?}",
                c.id
            );
        }
    }
}

#[test]
fn failures_are_codes_that_quote_nothing() {
    let cases = [
        (401, "E_AI_AUTH_FAILED"),
        (403, "E_AI_AUTH_FAILED"),
        (404, "E_AI_NOT_FOUND"),
        (429, "E_AI_RATE_LIMITED"),
        (400, "E_AI_REQUEST_REJECTED"),
        (413, "E_AI_REQUEST_REJECTED"),
        (500, "E_AI_PROVIDER_UNAVAILABLE"),
        (529, "E_AI_PROVIDER_UNAVAILABLE"),
        (418, "E_AI_HTTP"),
    ];
    for c in contracts() {
        for (status, code) in cases {
            let echo = json!({"error": {"message": format!("{PROMPT_CANARY} {KEY}")}});
            let mock = Mock::replying(status, echo.to_string());
            let app = setup(c.id, &mock.base);
            app.keys.set(c.id, KEY).unwrap();
            assert_eq!(
                app.ai.generate(&ask()).unwrap_err(),
                code,
                "{:?} {status}",
                c.id
            );
        }
    }
}

#[test]
fn redirects_are_not_followed_so_the_key_goes_nowhere_else() {
    for c in contracts() {
        let elsewhere = Mock::replying(200, (c.ok)("Hi").to_string());
        let mock = Mock::start(vec![(
            307,
            String::new(),
            vec![("location", format!("{}/stolen", elsewhere.base))],
        )]);
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_AI_HTTP");
        assert_eq!(elsewhere.hits(), 0);
    }
}

#[test]
fn nothing_is_sent_without_a_key() {
    for c in contracts() {
        let mock = Mock::replying(200, (c.ok)("Hi").to_string());
        let app = setup(c.id, &mock.base);
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_AI_KEY_MISSING");
        assert_eq!(mock.hits(), 0);
        app.keys.set(c.id, KEY).unwrap();
        app.keys.clear(c.id).unwrap();
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_AI_KEY_MISSING");
        assert_eq!(mock.hits(), 0);
    }
}

#[test]
fn nothing_is_sent_to_any_provider_without_a_licence_once_the_build_gates_ai() {
    use crate::licence::testing;
    for c in contracts() {
        let mock = Mock::replying(200, (c.ok)("Hi").to_string());
        let dir = tempfile::tempdir().unwrap();
        let licence = testing::licence(dir.path(), true);
        let app = setup_with(c.id, &mock.base, Gate::of(&licence));
        app.keys.set(c.id, KEY).unwrap();
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_LICENCE_REQUIRED");
        assert_eq!(mock.hits(), 0);
        licence.set(&testing::key(testing::ID)).unwrap();
        assert!(app.ai.generate(&ask()).is_ok());
        assert_eq!(mock.hits(), 1);
        licence.remove().unwrap();
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_LICENCE_REQUIRED");
        assert_eq!(mock.hits(), 1);
    }
}

#[test]
fn ai_needs_no_licence_while_the_build_gates_nothing() {
    let c = &contracts()[0];
    let mock = Mock::replying(200, (c.ok)("Hi").to_string());
    let dir = tempfile::tempdir().unwrap();
    let licence = crate::licence::testing::licence(dir.path(), false);
    let app = setup_with(c.id, &mock.base, Gate::of(&licence));
    app.keys.set(c.id, KEY).unwrap();
    assert!(app.ai.generate(&ask()).is_ok());
}

#[test]
fn a_bad_request_is_refused_before_anything_is_sent() {
    let edits: [(&str, Edit); 6] = [
        ("E_AI_REQUEST_INVALID", |r| r.messages.clear()),
        ("E_AI_REQUEST_INVALID", |r| {
            r.messages.remove(0);
        }),
        ("E_AI_REQUEST_INVALID", |r| {
            r.messages[1].content = "  ".into()
        }),
        ("E_AI_REQUEST_INVALID", |r| r.max_tokens = Some(0)),
        ("E_AI_REQUEST_INVALID", |r| r.max_tokens = Some(1_000_000)),
        ("E_AI_REQUEST_TOO_LARGE", |r| {
            r.messages[0].content = "x".repeat(2 * 1024 * 1024 + 1)
        }),
    ];
    for c in contracts() {
        let mock = Mock::replying(200, (c.ok)("Hi").to_string());
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        for (code, edit) in edits {
            let mut request = ask();
            edit(&mut request);
            assert_eq!(app.ai.generate(&request).unwrap_err(), code);
        }
        assert_eq!(mock.hits(), 0);
    }
}

#[test]
fn the_active_provider_answers_unless_one_is_named() {
    let [claude, other] = contracts();
    let mock = Mock::replying(200, (claude.ok)("Hi").to_string());
    let app = setup(claude.id, &mock.base);
    app.keys.set(claude.id, KEY).unwrap();
    app.keys.set(other.id, KEY).unwrap();
    assert_eq!(app.ai.generate(&ask()).unwrap().provider, claude.id);
    assert_eq!(mock.seen.lock().unwrap()[0].path, claude.path);

    let mock = Mock::replying(200, (other.ok)("Hi").to_string());
    let app = setup(claude.id, &mock.base);
    app.keys.set(other.id, KEY).unwrap();
    let mut named = ask();
    named.provider = Some(other.id);
    assert_eq!(app.ai.generate(&named).unwrap().provider, other.id);
    assert_eq!(mock.seen.lock().unwrap()[0].path, other.path);
}

#[test]
fn claude_has_a_default_model_and_a_compatible_server_needs_one() {
    let [claude, other] = contracts();
    for (c, model) in [(&claude, Some("claude-sonnet-5-5")), (&other, None)] {
        let mock = Mock::replying(200, (c.ok)("Hi").to_string());
        let app = setup(c.id, &mock.base);
        let mut settings = app.ai.settings.get();
        settings.anthropic.model = String::new();
        settings.openai.model = String::new();
        app.ai.settings.set(settings).unwrap();
        app.keys.set(c.id, KEY).unwrap();
        match model {
            Some(model) => {
                assert_eq!(app.ai.generate(&ask()).unwrap().model, model);
                assert_eq!(mock.seen.lock().unwrap()[0].body["model"], model);
            }
            None => {
                assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_AI_MODEL_MISSING");
                assert_eq!(mock.hits(), 0);
            }
        }
    }
}

#[test]
fn an_unreachable_or_silent_server_is_a_code() {
    for c in contracts() {
        let gone = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        let app = setup(c.id, &gone);
        app.keys.set(c.id, KEY).unwrap();
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_AI_NETWORK_FAILED");

        let silent = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", silent.local_addr().unwrap());
        let mut app = setup(c.id, &base);
        app.keys.set(c.id, KEY).unwrap();
        app.ai.timeout = Duration::from_millis(300);
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_AI_TIMEOUT");
    }
}

#[test]
fn a_request_can_ask_for_a_shorter_time_limit_but_not_a_longer_one() {
    let silent = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", silent.local_addr().unwrap());
    let app = setup(ProviderId::Anthropic, &base);
    app.keys.set(ProviderId::Anthropic, KEY).unwrap();
    let started = std::time::Instant::now();
    let mut request = ask();
    request.timeout_secs = Some(1);
    assert_eq!(app.ai.generate(&request).unwrap_err(), "E_AI_TIMEOUT");
    assert!(started.elapsed() < Duration::from_secs(30));
    request.timeout_secs = Some(0);
    assert_eq!(
        app.ai.generate(&request).unwrap_err(),
        "E_AI_REQUEST_INVALID"
    );

    let mut app = setup(ProviderId::Anthropic, &base);
    app.keys.set(ProviderId::Anthropic, KEY).unwrap();
    app.ai.timeout = Duration::from_millis(300);
    request.timeout_secs = Some(3600);
    let started = std::time::Instant::now();
    assert_eq!(app.ai.generate(&request).unwrap_err(), "E_AI_TIMEOUT");
    assert!(started.elapsed() < Duration::from_secs(30));
}

#[test]
fn a_response_over_the_cap_is_refused() {
    let [claude, _] = contracts();
    let big = (claude.ok)(&"x".repeat(super::transport::MAX_RESPONSE_BYTES)).to_string();
    let mock = Mock::replying(200, big);
    let app = setup(claude.id, &mock.base);
    app.keys.set(claude.id, KEY).unwrap();
    assert_eq!(
        app.ai.generate(&ask()).unwrap_err(),
        "E_AI_RESPONSE_TOO_LARGE"
    );
}

#[test]
fn settings_show_whether_a_key_is_stored_and_never_the_key() {
    let app = setup(ProviderId::Anthropic, "https://api.anthropic.com");
    let before = app.ai.snapshot();
    assert_eq!(
        (before.anthropic.key, before.openai.key),
        (KeyState::Unset, KeyState::Unset)
    );
    assert_eq!(before.anthropic.default_model, "claude-sonnet-5-5");
    let after = app
        .ai
        .set_key(ProviderId::Openai, &format!("  {KEY} "))
        .unwrap();
    assert_eq!(
        (after.anthropic.key, after.openai.key),
        (KeyState::Unset, KeyState::Set)
    );
    assert!(!serde_json::to_string(&after).unwrap().contains(KEY));
    assert_eq!(app.keys.get(ProviderId::Openai), Ok(Some(KEY.to_string())));
    assert_eq!(
        app.ai.set_key(ProviderId::Openai, "bad key").unwrap_err(),
        "E_AI_KEY_INVALID"
    );
    assert_eq!(app.keys.get(ProviderId::Openai), Ok(Some(KEY.to_string())));
    let cleared = app.ai.clear_key(ProviderId::Openai).unwrap();
    assert_eq!(cleared.openai.key, KeyState::Unset);
}

struct FixedKeys {
    has: Result<bool, &'static str>,
    reads: Mutex<usize>,
}

impl KeyStore for FixedKeys {
    fn has(&self, _: ProviderId) -> Result<bool, &'static str> {
        self.has
    }

    fn get(&self, _: ProviderId) -> Result<Option<String>, &'static str> {
        *self.reads.lock().unwrap() += 1;
        Ok(Some(KEY.to_string()))
    }

    fn set(&self, _: ProviderId, _: &str) -> Result<(), &'static str> {
        Ok(())
    }

    fn clear(&self, _: ProviderId) -> Result<(), &'static str> {
        Ok(())
    }
}

#[test]
fn settings_check_a_key_exists_without_reading_it() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(FixedKeys {
        has: Ok(true),
        reads: Mutex::new(0),
    });
    let ai = Ai::new(
        SettingsStore::new(&dir.path().join(FILE)),
        Arc::clone(&keys) as Arc<dyn KeyStore>,
        Gate::open(),
    );
    let view = ai.snapshot();
    assert_eq!(
        (view.anthropic.key, view.openai.key),
        (KeyState::Set, KeyState::Set)
    );
    assert_eq!(*keys.reads.lock().unwrap(), 0);
}

#[test]
fn only_a_missing_keychain_disables_the_key_field() {
    let dir = tempfile::tempdir().unwrap();
    for (has, expected) in [
        (Err("E_AI_KEYCHAIN_UNAVAILABLE"), KeyState::Unavailable),
        (Err("E_AI_KEYCHAIN_FAILED"), KeyState::Unknown),
        (Ok(false), KeyState::Unset),
    ] {
        let ai = Ai::new(
            SettingsStore::new(&dir.path().join(FILE)),
            Arc::new(FixedKeys {
                has,
                reads: Mutex::new(0),
            }),
            Gate::open(),
        );
        assert_eq!(ai.snapshot().openai.key, expected, "{has:?}");
    }
}

#[test]
fn the_key_is_never_written_to_the_settings_file() {
    let app = setup(ProviderId::Anthropic, "https://api.anthropic.com");
    app.ai.set_key(ProviderId::Anthropic, KEY).unwrap();
    app.ai.set_settings(app.ai.settings.get()).unwrap();
    for entry in std::fs::read_dir(app._dir.path()).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        assert!(!text.contains(KEY));
    }
}

fn endpoint_of(settings: &mut AiSettings, id: ProviderId) -> &mut String {
    match id {
        ProviderId::Anthropic => &mut settings.anthropic.endpoint,
        ProviderId::Openai => &mut settings.openai.endpoint,
        ProviderId::ClaudeCli | ProviderId::CodexCli => unreachable!("HTTP provider only"),
    }
}

fn key_of(snapshot: &Snapshot, id: ProviderId) -> KeyState {
    match id {
        ProviderId::Anthropic => snapshot.anthropic.key,
        ProviderId::Openai => snapshot.openai.key,
        ProviderId::ClaudeCli | ProviderId::CodexCli => unreachable!("HTTP provider only"),
    }
}

#[test]
fn a_stored_key_never_goes_to_a_server_it_was_not_entered_for() {
    for c in contracts() {
        let mock = Mock::replying(200, (c.ok)("Hi").to_string());
        let elsewhere = Mock::replying(200, (c.ok)("Hi").to_string());
        let app = setup(c.id, &mock.base);
        let other = match c.id {
            ProviderId::Anthropic => ProviderId::Openai,
            ProviderId::Openai => ProviderId::Anthropic,
            ProviderId::ClaudeCli | ProviderId::CodexCli => unreachable!("HTTP provider only"),
        };
        app.keys.set(c.id, KEY).unwrap();
        app.keys.set(other, KEY).unwrap();

        let mut same_server = app.ai.settings.get();
        *endpoint_of(&mut same_server, c.id) = format!("{}/v1/", mock.base);
        let view = app.ai.set_settings(same_server).unwrap();
        assert_eq!(key_of(&view, c.id), KeyState::Set, "{:?}", c.id);

        let mut moved = app.ai.settings.get();
        *endpoint_of(&mut moved, c.id) = elsewhere.base.clone();
        let view = app.ai.set_settings(moved).unwrap();
        assert_eq!(key_of(&view, c.id), KeyState::Unset, "{:?}", c.id);
        assert_eq!(key_of(&view, other), KeyState::Set, "{:?}", c.id);
        assert_eq!(app.ai.generate(&ask()).unwrap_err(), "E_AI_KEY_MISSING");
        assert_eq!((elsewhere.hits(), mock.hits()), (0, 0));
    }
}

struct StuckKeys;

impl KeyStore for StuckKeys {
    fn has(&self, _: ProviderId) -> Result<bool, &'static str> {
        Ok(true)
    }

    fn get(&self, _: ProviderId) -> Result<Option<String>, &'static str> {
        Ok(Some(KEY.to_string()))
    }

    fn set(&self, _: ProviderId, _: &str) -> Result<(), &'static str> {
        Ok(())
    }

    fn clear(&self, _: ProviderId) -> Result<(), &'static str> {
        Err("E_AI_KEYCHAIN_FAILED")
    }
}

#[test]
fn an_endpoint_does_not_move_while_its_key_cannot_be_removed() {
    let dir = tempfile::tempdir().unwrap();
    let ai = Ai::new(
        SettingsStore::new(&dir.path().join(FILE)),
        Arc::new(StuckKeys),
        Gate::open(),
    );
    let before = ai.settings.get();
    let mut moved = before.clone();
    moved.anthropic.endpoint = "https://gateway.example.com".into();
    assert_eq!(ai.set_settings(moved).unwrap_err(), "E_AI_KEYCHAIN_FAILED");
    assert_eq!(ai.settings.get(), before);
}

fn sse(events: &[Value]) -> String {
    events.iter().map(|e| format!("data: {e}\n\n")).collect()
}

/// A streamed answer in each provider's events: `pieces` of text, then a stop and the counts 11 and 7.
fn streamed(id: ProviderId, pieces: &[&str], stop: &str, end: bool) -> String {
    match id {
        ProviderId::Anthropic => {
            let mut events = vec![
                json!({"type": "message_start", "message": {"usage": {"input_tokens": 11, "output_tokens": 1}}}),
                json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ];
            events.extend(pieces.iter().map(|p| {
                json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": p}})
            }));
            events.push(json!({"type": "content_block_delta", "index": 1, "delta": {"type": "thinking_delta", "thinking": "hidden"}}));
            if end {
                events.push(json!({"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 7}}));
                events.push(json!({"type": "message_stop"}));
            }
            format!(
                "event: ping\ndata: {{\"type\": \"ping\"}}\n\n{}",
                sse(&events)
            )
        }
        ProviderId::Openai => {
            let mut events: Vec<Value> = pieces
                .iter()
                .map(|p| json!({"choices": [{"index": 0, "delta": {"content": p}, "finish_reason": null}]}))
                .collect();
            if end {
                events.push(json!({"choices": [{"index": 0, "delta": {}, "finish_reason": stop}]}));
                events.push(
                    json!({"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 7}}),
                );
            }
            let mut body = sse(&events);
            if end {
                body.push_str("data: [DONE]\n\n");
            }
            body
        }
        ProviderId::ClaudeCli | ProviderId::CodexCli => unreachable!("HTTP stream only"),
    }
}

fn ended(id: ProviderId) -> &'static str {
    match id {
        ProviderId::Anthropic => "end_turn",
        ProviderId::Openai => "stop",
        ProviderId::ClaudeCli | ProviderId::CodexCli => unreachable!("HTTP stream only"),
    }
}

#[test]
fn every_provider_streams_its_answer_piece_by_piece() {
    for c in contracts() {
        let pieces = ["Hel", "lo, ", "world"];
        let mock = Mock::replying(200, streamed(c.id, &pieces, ended(c.id), true));
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        let mut heard = Vec::new();
        let got = app
            .ai
            .stream(&ask(), |text| {
                heard.push(text.to_string());
                true
            })
            .unwrap();
        assert_eq!(heard, pieces, "{:?}", c.id);
        assert_eq!(got.text, "Hello, world");
        assert_eq!((got.provider, got.model.as_str()), (c.id, "model-x"));
        assert_eq!(got.stop, Stop::End);
        let usage = got.usage.unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens), (11, 7));
        let seen = mock.seen.lock().unwrap();
        assert_eq!(seen[0].path, c.path);
        assert_eq!(seen[0].body["stream"], true);
        assert_eq!(seen[0].headers["accept"], "text/event-stream");
        (c.check_auth)(&seen[0]);
        (c.check_body)(&seen[0]);
    }
}

#[test]
fn a_plain_request_never_asks_for_a_stream() {
    for c in contracts() {
        let mock = Mock::replying(200, (c.ok)("Hi").to_string());
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        app.ai.generate(&ask()).unwrap();
        assert!(mock.seen.lock().unwrap()[0].body.get("stream").is_none());
    }
}

#[test]
fn a_stream_cut_off_by_the_cap_says_so_and_one_that_breaks_off_is_no_answer() {
    for c in contracts() {
        let cap = match c.id {
            ProviderId::Anthropic => "max_tokens",
            ProviderId::Openai => "length",
            ProviderId::ClaudeCli | ProviderId::CodexCli => unreachable!("HTTP stream only"),
        };
        let mock = Mock::replying(200, streamed(c.id, &["cut"], cap, true));
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        let got = app.ai.stream(&ask(), |_| true).unwrap();
        assert_eq!((got.text.as_str(), got.stop), ("cut", Stop::MaxTokens));

        let mock = Mock::replying(200, streamed(c.id, &["half"], "", false));
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        assert_eq!(
            app.ai.stream(&ask(), |_| true).unwrap_err(),
            "E_AI_RESPONSE_INVALID",
            "{:?}",
            c.id
        );

        let mock = Mock::replying(200, "data: {not json\n\n");
        let app = setup(c.id, &mock.base);
        app.keys.set(c.id, KEY).unwrap();
        assert_eq!(
            app.ai.stream(&ask(), |_| true).unwrap_err(),
            "E_AI_RESPONSE_INVALID"
        );
    }
}

#[test]
fn a_streamed_refusal_or_failure_is_a_code_that_quotes_nothing() {
    let refusal = sse(&[json!({"type": "message_delta", "delta": {"stop_reason": "refusal"}})]);
    let overloaded = sse(&[
        json!({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "a"}}),
        json!({"type": "error", "error": {"type": "overloaded_error", "message": PROMPT_CANARY}}),
    ]);
    for (body, code) in [
        (refusal, "E_AI_REFUSED"),
        (overloaded, "E_AI_PROVIDER_UNAVAILABLE"),
    ] {
        let mock = Mock::replying(200, body);
        let app = setup(ProviderId::Anthropic, &mock.base);
        app.keys.set(ProviderId::Anthropic, KEY).unwrap();
        assert_eq!(app.ai.stream(&ask(), |_| true).unwrap_err(), code);
    }
    let refusal = sse(&[json!({"choices": [{"delta": {"refusal": "no"}, "finish_reason": null}]})]);
    let mock = Mock::replying(200, refusal);
    let app = setup(ProviderId::Openai, &mock.base);
    app.keys.set(ProviderId::Openai, KEY).unwrap();
    assert_eq!(app.ai.stream(&ask(), |_| true).unwrap_err(), "E_AI_REFUSED");

    for c in contracts() {
        for (status, code) in [
            (401, "E_AI_AUTH_FAILED"),
            (529, "E_AI_PROVIDER_UNAVAILABLE"),
        ] {
            let echo = json!({"error": {"message": format!("{PROMPT_CANARY} {KEY}")}});
            let mock = Mock::replying(status, echo.to_string());
            let app = setup(c.id, &mock.base);
            app.keys.set(c.id, KEY).unwrap();
            assert_eq!(app.ai.stream(&ask(), |_| true).unwrap_err(), code);
        }
    }
}

#[test]
fn a_stream_stops_when_its_listener_is_gone_and_needs_what_a_request_needs() {
    let c = &contracts()[0];
    let mock = Mock::replying(200, streamed(c.id, &["one", "two"], "end_turn", true));
    let app = setup(c.id, &mock.base);
    app.keys.set(c.id, KEY).unwrap();
    let mut heard = 0;
    let stopped = app.ai.stream(&ask(), |_| {
        heard += 1;
        false
    });
    assert_eq!(stopped.unwrap_err(), "E_AI_CANCELLED");
    assert_eq!(heard, 1);

    let app = setup(c.id, &mock.base);
    assert_eq!(
        app.ai.stream(&ask(), |_| true).unwrap_err(),
        "E_AI_KEY_MISSING"
    );
    app.keys.set(c.id, KEY).unwrap();
    let mut request = ask();
    request.messages.clear();
    assert_eq!(
        app.ai.stream(&request, |_| true).unwrap_err(),
        "E_AI_REQUEST_INVALID"
    );
    assert_eq!(mock.hits(), 1);
}

#[test]
fn streamed_text_crosses_a_few_pieces_at_a_time() {
    let mut pieces = super::Pieces::new(Duration::from_secs(3600));
    assert_eq!(pieces.push("a").as_deref(), Some("a"));
    assert_eq!(pieces.push("b"), None);
    assert_eq!(pieces.push("c"), None);
    assert_eq!(pieces.rest().as_deref(), Some("bc"));
    assert_eq!(pieces.rest(), None);

    let mut every = super::Pieces::new(Duration::ZERO);
    assert_eq!(every.push("a").as_deref(), Some("a"));
    assert_eq!(every.push("b").as_deref(), Some("b"));
    assert_eq!(every.rest(), None);
}

struct StubCli {
    states: Mutex<super::cli::CliStates>,
    probes: Mutex<usize>,
    runs: Mutex<Vec<(ProviderId, String, bool)>>,
    reply: Mutex<Result<(String, Vec<String>), &'static str>>,
}

impl StubCli {
    fn new(claude: super::CliState, codex: super::CliState) -> Arc<Self> {
        Arc::new(Self {
            states: Mutex::new(super::cli::CliStates {
                claude_cli: claude,
                codex_cli: codex,
            }),
            probes: Mutex::new(0),
            runs: Mutex::new(Vec::new()),
            reply: Mutex::new(Ok(("cli-model".into(), vec!["Hel".into(), "lo".into()]))),
        })
    }
}

impl super::cli::CliBackend for StubCli {
    fn probe(&self) -> super::cli::CliStates {
        *self.probes.lock().unwrap() += 1;
        *self.states.lock().unwrap()
    }

    fn run(
        &self,
        id: ProviderId,
        model: &str,
        request: &super::provider::Prepared<'_>,
        _timeout: Duration,
        cancelled: &dyn Fn() -> bool,
        on_text: &mut dyn FnMut(&str) -> bool,
    ) -> Result<super::cli::CliDone, &'static str> {
        self.runs
            .lock()
            .unwrap()
            .push((id, model.to_string(), request.stream));
        match self.reply.lock().unwrap().clone() {
            Ok((used_model, chunks)) => {
                let mut text = String::new();
                for chunk in chunks {
                    if cancelled() {
                        return Err("E_AI_CANCELLED");
                    }
                    text.push_str(&chunk);
                    if request.stream && !on_text(&chunk) {
                        return Err("E_AI_CANCELLED");
                    }
                }
                Ok(super::cli::CliDone {
                    model: if model.is_empty() {
                        used_model
                    } else {
                        model.to_string()
                    },
                    completion: super::Completion {
                        text,
                        stop: Stop::End,
                        usage: Some(super::provider::Usage {
                            input_tokens: 9,
                            output_tokens: 4,
                        }),
                    },
                })
            }
            Err(code) => Err(code),
        }
    }
}

#[test]
fn desktop_defaults_to_first_ready_cli_when_unconfigured_and_without_anthropic_key() {
    use super::CliState;
    let dir = tempfile::tempdir().unwrap();
    let cli = StubCli::new(CliState::Ready, CliState::SignedOut);
    let ai = Ai::new(
        SettingsStore::new(&dir.path().join(FILE)),
        Arc::new(MemoryKeys::default()),
        Gate::open(),
    )
    .with_cli(Arc::clone(&cli) as Arc<dyn super::cli::CliBackend>);

    let snap = ai.snapshot();
    assert_eq!(snap.active, ProviderId::ClaudeCli);
    assert_eq!(
        snap.cli
            .as_ref()
            .map(|c| (c.claude_cli.state, c.codex_cli.state)),
        Some((CliState::Ready, CliState::SignedOut))
    );
    // Repeated snapshot hits cache; refresh_cli probes again.
    let _ = ai.snapshot();
    assert_eq!(*cli.probes.lock().unwrap(), 1);
    *cli.states.lock().unwrap() = super::cli::CliStates {
        claude_cli: CliState::NotInstalled,
        codex_cli: CliState::Ready,
    };
    let refreshed = ai.refresh_cli();
    assert_eq!(*cli.probes.lock().unwrap(), 2);
    assert_eq!(refreshed.active, ProviderId::CodexCli);

    // Storing an Anthropic key leaves anthropic when explicit active is unset? Only when key is unset!
    ai.set_key(ProviderId::Anthropic, KEY).unwrap();
    assert_eq!(ai.snapshot().active, ProviderId::Anthropic);
}

#[test]
fn concurrent_refresh_cli_is_never_overwritten_by_earlier_probe() {
    use super::CliState;
    use std::sync::mpsc;

    struct RacedCli {
        calls: Mutex<usize>,
        entered_first: mpsc::SyncSender<()>,
        release_first: Mutex<Option<mpsc::Receiver<()>>>,
    }

    impl super::cli::CliBackend for RacedCli {
        fn probe(&self) -> super::cli::CliStates {
            let call = {
                let mut guard = self.calls.lock().unwrap();
                *guard += 1;
                *guard
            };
            if call == 1 {
                let _ = self.entered_first.send(());
                let rx = self.release_first.lock().unwrap().take().unwrap();
                let _ = rx.recv_timeout(Duration::from_secs(2));
                super::cli::CliStates {
                    claude_cli: CliState::SignedOut,
                    codex_cli: CliState::NotInstalled,
                }
            } else {
                super::cli::CliStates {
                    claude_cli: CliState::Ready,
                    codex_cli: CliState::NotInstalled,
                }
            }
        }

        fn run(
            &self,
            _: ProviderId,
            _: &str,
            _: &super::provider::Prepared<'_>,
            _: Duration,
            _: &dyn Fn() -> bool,
            _: &mut dyn FnMut(&str) -> bool,
        ) -> Result<super::cli::CliDone, &'static str> {
            Err("E_AI_PROVIDER_UNAVAILABLE")
        }
    }

    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let cli = Arc::new(RacedCli {
        calls: Mutex::new(0),
        entered_first: entered_tx,
        release_first: Mutex::new(Some(release_rx)),
    });
    let dir = tempfile::tempdir().unwrap();
    let ai = Arc::new(
        Ai::new(
            SettingsStore::new(&dir.path().join(FILE)),
            Arc::new(MemoryKeys::default()),
            Gate::open(),
        )
        .with_cli(Arc::clone(&cli) as Arc<dyn super::cli::CliBackend>),
    );

    let ai1 = Arc::clone(&ai);
    let t1 = std::thread::spawn(move || ai1.snapshot());
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

    let ai2 = Arc::clone(&ai);
    let t2 = std::thread::spawn(move || ai2.refresh_cli());
    std::thread::sleep(Duration::from_millis(30));

    let _ = release_tx.send(());
    let first = t1.join().unwrap();
    let refreshed = t2.join().unwrap();
    assert_eq!(first.active, ProviderId::Anthropic);
    assert_eq!(refreshed.active, ProviderId::ClaudeCli);
    assert_eq!(
        refreshed.cli.as_ref().map(|c| c.claude_cli.state),
        Some(CliState::Ready)
    );
    assert_eq!(
        ai.snapshot().cli.as_ref().map(|c| c.claude_cli.state),
        Some(CliState::Ready)
    );
    assert_eq!(*cli.calls.lock().unwrap(), 2);
}

#[test]
fn cli_providers_enforce_gates_stream_and_refuse_api_keys() {
    use super::CliState;
    use crate::licence::testing;
    let dir = tempfile::tempdir().unwrap();
    let licence = testing::licence(dir.path(), true);
    let cli = StubCli::new(CliState::Ready, CliState::Ready);
    let ai = Ai::new(
        SettingsStore::new(&dir.path().join(FILE)),
        Arc::new(MemoryKeys::default()),
        Gate::of(&licence),
    )
    .with_cli(Arc::clone(&cli) as Arc<dyn super::cli::CliBackend>);

    assert_eq!(ai.generate(&ask()).unwrap_err(), "E_LICENCE_REQUIRED");
    assert!(cli.runs.lock().unwrap().is_empty());

    licence.set(&testing::key(testing::ID)).unwrap();
    let mut bad = ask();
    bad.messages.clear();
    assert_eq!(ai.generate(&bad).unwrap_err(), "E_AI_REQUEST_INVALID");
    assert!(cli.runs.lock().unwrap().is_empty());

    let mut s = ai.settings.get();
    s.active = ProviderId::CodexCli;
    s.codex_cli.model = "gpt-5.4".into();
    ai.set_settings(s).unwrap();

    let generated = ai.generate(&ask()).unwrap();
    assert_eq!(generated.provider, ProviderId::CodexCli);
    assert_eq!(generated.model, "gpt-5.4");
    assert_eq!(generated.text, "Hello");

    let mut heard = Vec::new();
    let streamed = ai
        .stream(&ask(), |piece| {
            heard.push(piece.to_string());
            true
        })
        .unwrap();
    assert_eq!(heard, ["Hel", "lo"]);
    assert_eq!(streamed.text, "Hello");
    assert_eq!(
        *cli.runs.lock().unwrap(),
        [
            (ProviderId::CodexCli, "gpt-5.4".into(), false),
            (ProviderId::CodexCli, "gpt-5.4".into(), true),
        ]
    );

    assert_eq!(
        ai.set_key(ProviderId::ClaudeCli, KEY).unwrap_err(),
        "E_AI_REQUEST_INVALID"
    );
    assert_eq!(
        ai.clear_key(ProviderId::CodexCli).unwrap_err(),
        "E_AI_REQUEST_INVALID"
    );
}

#[test]
fn cancel_stream_stops_active_http_stream_and_validates_id() {
    use std::sync::mpsc;

    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());

    let store = SettingsStore::new(&dir.path().join(FILE));
    let mut s = store.get();
    s.active = ProviderId::Anthropic;
    s.anthropic.endpoint = base;
    store.set(s).unwrap();
    let keys = Arc::new(MemoryKeys::default());
    keys.set(ProviderId::Anthropic, KEY).unwrap();
    let ai = Arc::new(Ai::new(store, keys, Gate::open()));

    assert_eq!(
        ai.cancel_stream(&key(0)).unwrap_err(),
        "E_AI_REQUEST_INVALID"
    );
    assert!(!ai.cancel_stream(&key(99)).unwrap());
    assert_eq!(
        ai.stream_with_id(Some(key(0)), &ask(), |_| true)
            .unwrap_err(),
        "E_AI_REQUEST_INVALID"
    );

    let (release_tx, release_rx) = mpsc::sync_channel::<()>(1);
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let _ = read_request(&mut socket);
        let first = sse(&[
            json!({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "one"}}),
        ]);
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{first}"
        );
        socket.write_all(head.as_bytes()).unwrap();
        socket.flush().unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(2));
        let rest = streamed(ProviderId::Anthropic, &["two"], "end_turn", true);
        let _ = socket.write_all(rest.as_bytes());
        let _ = socket.flush();
    });

    let (first_tx, first_rx) = mpsc::sync_channel::<String>(1);
    let ai_run = Arc::clone(&ai);
    let worker = std::thread::spawn(move || {
        ai_run.stream_with_id(Some(key(42)), &ask(), |piece| {
            let _ = first_tx.send(piece.to_string());
            true
        })
    });

    assert_eq!(
        first_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        "one"
    );
    assert_eq!(ai.cancel_stream(&key(42)), Ok(true));
    let _ = release_tx.send(());

    assert_eq!(worker.join().unwrap().unwrap_err(), "E_AI_CANCELLED");
    server.join().unwrap();
    assert_eq!(ai.cancel_stream(&key(42)), Ok(false));
    // A cancel for a stream that already ended is not kept for a later one: only 99 waits.
    assert_eq!(ai.early_cancels(), 1);
}

#[test]
fn a_cancel_that_arrives_before_the_stream_starts_still_stops_it() {
    let server = Mock::replying(500, "");
    let app = setup(ProviderId::Anthropic, &server.base);
    app.keys.set(ProviderId::Anthropic, KEY).unwrap();

    assert_eq!(app.ai.cancel_stream(&key(7)), Ok(false));
    assert_eq!(
        app.ai
            .stream_with_id(Some(key(7)), &ask(), |_| true)
            .unwrap_err(),
        "E_AI_CANCELLED"
    );
    assert_eq!(server.hits(), 0);

    for early in 100..300 {
        app.ai.cancel_stream(&key(early)).unwrap();
    }
    assert!(app.ai.early_cancels() <= 64);
}

fn key(id: u64) -> StreamKey {
    StreamKey::new("main", id)
}

#[test]
fn streams_of_two_windows_with_one_number_stay_apart() {
    let mut streams = Streams::default();
    let a = StreamKey::new("main", 5);
    let b = StreamKey::new("main-2", 5);
    let flag_a = streams.register(&a).unwrap();
    let flag_b = streams.register(&b).unwrap();
    assert!(streams.cancel(&a));
    assert!(flag_a.load(Ordering::SeqCst));
    assert!(!flag_b.load(Ordering::SeqCst));
    streams.finish(&a, &flag_a);
    assert!(streams.cancel(&b));
    assert!(flag_b.load(Ordering::SeqCst));
}

#[test]
fn a_cancel_after_a_stream_ended_stops_no_later_stream() {
    let mut streams = Streams::default();
    let ended = StreamKey::new("main", 9);
    let flag = streams.register(&ended).unwrap();
    streams.finish(&ended, &flag);
    assert!(!streams.cancel(&ended));
    let again = streams
        .register(&ended)
        .expect("a late cancel is not an early one");
    assert!(!again.load(Ordering::SeqCst));
}
