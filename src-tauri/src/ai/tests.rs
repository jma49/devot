//! The contract every provider keeps, run against a mock HTTP provider on this machine: one case table per implementation, the same expectations for all.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use super::keychain::{KeyStore, MemoryKeys};
use super::provider::{GenerateRequest, Message, ProviderId, Role, Stop};
use super::settings::{FILE, SettingsStore};
use super::{Ai, KeyState};
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
