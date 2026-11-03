//! The bridge's side of the local HTTP API: one request a connection, over the app's Unix socket in
//! this user's private folder. Before a byte goes out the peer must be a process of this user, so
//! the token reaches no one else whatever happened to Devot meanwhile (ADR 0012). The token stays
//! in the keychain and in this process's memory; it is never an argument, an environment
//! variable, a config file's or a log's.

use std::io::{ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::http_api::token::{self, Keychain, Token, TokenStore};

use super::start::Live;
use super::tools::{Api, ApiRequest, percent_encode};

const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// The app answers within its own 15 s, or says it timed out.
const READ_TIMEOUT: Duration = Duration::from_secs(20);
/// Well past any note: a listener that sends more is not Devot.
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RETRY_WAIT: u64 = 5;
/// A quit refuses calls until Devot is gone; then the next one may start it again.
const QUIT_RETRIES: usize = 3;
const QUIT_WAIT: Duration = Duration::from_secs(1);
const SESSION_BYTES: usize = 8;

#[derive(Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub retry_after: Option<u64>,
    pub body: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExchangeError {
    /// Nothing was sent: safe to find Devot again.
    Unreachable,
    /// A request was sent, or partly: it may have been made.
    Lost,
    /// The peer is not a process of this user: nothing was sent.
    Untrusted,
}

pub struct Caller<'a> {
    pub token: &'a str,
    pub client: &'a str,
    pub session: &'a str,
}

fn head_of(request: &ApiRequest, caller: &Caller, length: usize) -> String {
    let mut head = format!(
        "{} {} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nX-Devot-Session: {}\r\nConnection: close\r\n",
        request.method, request.target, caller.token, caller.session
    );
    if !caller.client.is_empty() {
        head.push_str(&format!(
            "X-Devot-Client: {}\r\n",
            percent_encode(caller.client)
        ));
    }
    if request.body.is_some() {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {length}\r\n"
        ));
    }
    head.push_str("\r\n");
    head
}

fn parse_answer(bytes: &[u8]) -> Option<Answer> {
    let end = bytes.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&bytes[..end]).ok()?;
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let retry_after = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("retry-after")
            .then(|| value.trim().parse().ok())
            .flatten()
    });
    Some(Answer {
        status,
        retry_after,
        body: bytes[end + 4..].to_vec(),
    })
}

pub fn exchange(
    socket: &Path,
    request: &ApiRequest,
    caller: &Caller,
    uid: u32,
) -> Result<Answer, ExchangeError> {
    let body = match &request.body {
        Some(body) => serde_json::to_vec(body).map_err(|_| ExchangeError::Unreachable)?,
        None => Vec::new(),
    };
    let mut stream = UnixStream::connect(socket).map_err(|_| ExchangeError::Unreachable)?;
    if crate::atomic_file::peer_uid(&stream) != Some(uid) {
        return Err(ExchangeError::Untrusted);
    }
    let lost = |_| ExchangeError::Lost;
    stream.set_read_timeout(Some(READ_TIMEOUT)).map_err(lost)?;
    stream
        .set_write_timeout(Some(WRITE_TIMEOUT))
        .map_err(lost)?;
    stream
        .write_all(head_of(request, caller, body.len()).as_bytes())
        .and_then(|()| stream.write_all(&body))
        .and_then(|()| stream.flush())
        .map_err(lost)?;
    match stream.shutdown(Shutdown::Write) {
        Err(e) if e.kind() != ErrorKind::NotConnected => return Err(ExchangeError::Lost),
        _ => {}
    }
    let mut bytes = Vec::new();
    (&mut stream)
        .take(MAX_RESPONSE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(lost)?;
    parse_answer(&bytes).ok_or(ExchangeError::Lost)
}

fn new_session() -> Result<String, &'static str> {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut bytes = [0u8; SESSION_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| "E_MCP_INTERNAL")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// What an answer means for a tool: its JSON, or a code; a code that is not one is an internal one.
fn value_of(answer: &Answer) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(&answer.body).map_err(|_| "E_MCP_INTERNAL")?;
    if answer.status < 400 {
        return Ok(value);
    }
    match value.get("error").and_then(Value::as_str) {
        Some(code) if code.starts_with("E_") => Err(code.to_owned()),
        _ => Err("E_MCP_INTERNAL".to_owned()),
    }
}

/// Finds Devot, reads the token and retries the refusals that change nothing: a token that was
/// replaced, a rate limit, and a quit under way. A request that may have been made is never sent twice.
pub struct HttpApiClient {
    live: Box<dyn Fn() -> Result<PathBuf, &'static str> + Send>,
    tokens: Box<dyn TokenStore>,
    token: Mutex<Option<Token>>,
    client: Arc<Mutex<String>>,
    session: Result<String, &'static str>,
}

impl HttpApiClient {
    pub fn new(identifier: &str, live: Live, client: Arc<Mutex<String>>) -> Self {
        Self::with(
            Box::new(move || live.reach()),
            Box::new(Keychain::for_mcp(identifier)),
            client,
        )
    }

    fn with(
        live: Box<dyn Fn() -> Result<PathBuf, &'static str> + Send>,
        tokens: Box<dyn TokenStore>,
        client: Arc<Mutex<String>>,
    ) -> Self {
        Self {
            live,
            tokens,
            token: Mutex::new(None),
            client,
            session: new_session(),
        }
    }

    fn token(&self, reread: bool) -> Result<Token, String> {
        let mut held = self.token.lock().map_err(|_| "E_MCP_INTERNAL")?;
        if !reread && let Some(token) = held.as_ref() {
            return Ok(token.clone());
        }
        let stored = self.tokens.get().map_err(|_| "E_MCP_KEYCHAIN_FAILED")?;
        let token = stored
            .filter(|token| token::is_token(token))
            .ok_or("E_MCP_TOKEN_MISSING")?;
        *held = Some(token.clone());
        Ok(token)
    }

    fn send(&self, socket: &Path, request: &ApiRequest, reread: bool) -> Result<Answer, SendError> {
        let token = self.token(reread).map_err(SendError::Code)?;
        let client = self
            .client
            .lock()
            .map(|name| name.clone())
            .unwrap_or_default();
        let session = self
            .session
            .as_deref()
            .map_err(|code| SendError::Code((*code).to_owned()))?;
        exchange(
            socket,
            request,
            &Caller {
                token: &token,
                client: &client,
                session,
            },
            crate::atomic_file::effective_uid(),
        )
        .map_err(SendError::Exchange)
    }
}

enum SendError {
    Code(String),
    Exchange(ExchangeError),
}

impl Api for HttpApiClient {
    fn call(&self, request: &ApiRequest) -> Result<Value, String> {
        let mut socket = (self.live)().map_err(String::from)?;
        let mut reread = false;
        let mut found_again = false;
        let mut waited = false;
        let mut quits = 0;
        loop {
            let answer = match self.send(&socket, request, reread) {
                Ok(answer) => answer,
                Err(SendError::Code(code)) => return Err(code),
                Err(SendError::Exchange(ExchangeError::Lost)) => {
                    return Err("E_MCP_CONNECTION_LOST".into());
                }
                Err(SendError::Exchange(ExchangeError::Untrusted)) => {
                    return Err("E_MCP_PEER_REFUSED".into());
                }
                Err(SendError::Exchange(ExchangeError::Unreachable)) => {
                    if found_again {
                        return Err("E_MCP_CONNECTION_LOST".into());
                    }
                    // It quit a moment ago: the next call may start it again if that is allowed.
                    found_again = true;
                    socket = (self.live)().map_err(String::from)?;
                    continue;
                }
            };
            if answer.status == 401 && !reread {
                reread = true;
                continue;
            }
            if answer.status == 429 && !waited {
                waited = true;
                let wait = answer.retry_after.unwrap_or(1).min(MAX_RETRY_WAIT);
                std::thread::sleep(Duration::from_secs(wait));
                continue;
            }
            let value = value_of(&answer);
            // Refused before it reached the core, so asking again cannot make it twice.
            if value.as_ref().is_err_and(|code| code == "E_APP_QUITTING") && quits < QUIT_RETRIES {
                quits += 1;
                std::thread::sleep(QUIT_WAIT);
                socket = (self.live)().map_err(String::from)?;
                continue;
            }
            return value;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_api::routes::{Call, Op};
    use crate::http_api::server::{Dispatch, Gate, Limits, Server};
    use crate::http_api::token::{MemoryTokens, Scope};
    use serde_json::json;
    use std::sync::Arc;

    #[derive(Default)]
    struct Core {
        calls: Mutex<Vec<Call>>,
    }

    impl Dispatch for Core {
        fn dispatch(&self, call: &Call) -> Result<Value, String> {
            self.calls.lock().unwrap().push(call.clone());
            match call.op {
                Op::NotesRead => Err("E_NOTE_NOT_FOUND".into()),
                _ => Ok(json!({ "id": "n1" })),
            }
        }
    }

    struct World {
        server: Server,
        gate: Arc<Gate>,
        core: Arc<Core>,
        tokens: Arc<MemoryTokens>,
        socket: PathBuf,
        _dir: tempfile::TempDir,
    }

    fn world(scope: Scope, limits: Limits) -> World {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("b.sock");
        let gate = Arc::new(Gate::new(limits));
        let token = token::generate().unwrap();
        let tokens = Arc::new(MemoryTokens::default());
        tokens.set(&token).unwrap();
        gate.allow_mcp(token, scope);
        let core = Arc::new(Core::default());
        let server = Server::start_bridge(&socket, Arc::clone(&gate), core.clone()).unwrap();
        World {
            server,
            gate,
            core,
            tokens,
            socket,
            _dir: dir,
        }
    }

    struct Shared(Arc<MemoryTokens>);

    impl TokenStore for Shared {
        fn has(&self) -> Result<bool, &'static str> {
            self.0.has()
        }
        fn get(&self) -> Result<Option<Token>, &'static str> {
            self.0.get()
        }
        fn set(&self, token: &str) -> Result<(), &'static str> {
            self.0.set(token)
        }
    }

    fn client_of(world: &World, name: &str) -> HttpApiClient {
        let socket = world.socket.clone();
        HttpApiClient::with(
            Box::new(move || Ok(socket.clone())),
            Box::new(Shared(Arc::clone(&world.tokens))),
            Arc::new(Mutex::new(name.to_owned())),
        )
    }

    fn create() -> ApiRequest {
        ApiRequest {
            method: "POST",
            target: "/v1/notes".into(),
            body: Some(json!({ "title": "T", "markdown": "M", "notebook": "N" })),
        }
    }

    fn read() -> ApiRequest {
        ApiRequest {
            method: "GET",
            target: "/v1/notes/0192a6f0-0000-7000-8000-000000000001".into(),
            body: None,
        }
    }

    #[test]
    fn a_write_goes_through_the_real_listener_with_the_clients_name_and_session() {
        let world = world(Scope::ReadWrite, Limits::DEFAULT);
        let client = client_of(&world, "Claude Code");
        assert_eq!(client.call(&create()), Ok(json!({ "id": "n1" })));
        client.call(&create()).unwrap();
        let calls = world.core.calls.lock().unwrap();
        let first = calls[0].client.clone().unwrap();
        assert_eq!(first.name, "Claude Code");
        assert_eq!(first.session.len(), 11);
        assert_eq!(calls[1].client.as_ref().unwrap().session, first.session);
    }

    #[test]
    fn a_name_outside_ascii_arrives_as_it_was() {
        let world = world(Scope::ReadWrite, Limits::DEFAULT);
        client_of(&world, "Caf\u{e9} \u{1f916}")
            .call(&create())
            .unwrap();
        let calls = world.core.calls.lock().unwrap();
        assert_eq!(
            calls[0].client.as_ref().unwrap().name,
            "Caf\u{e9} \u{1f916}"
        );
    }

    #[test]
    fn a_read_only_choice_refuses_writes_at_the_listener_and_passes_codes_on() {
        let world = world(Scope::Read, Limits::DEFAULT);
        let client = client_of(&world, "x");
        assert_eq!(client.call(&create()), Err("E_HTTP_READ_ONLY".into()));
        assert_eq!(client.call(&read()), Err("E_NOTE_NOT_FOUND".into()));
        assert_eq!(world.core.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn reads_the_token_again_once_when_it_was_replaced() {
        let world = world(Scope::ReadWrite, Limits::DEFAULT);
        let client = client_of(&world, "x");
        client.call(&create()).unwrap();
        let fresh = token::generate().unwrap();
        world.tokens.set(&fresh).unwrap();
        world.gate.allow_mcp(fresh, Scope::ReadWrite);
        assert_eq!(client.call(&create()), Ok(json!({ "id": "n1" })));
        assert_eq!(world.core.calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn access_turned_off_answers_a_code_and_reaches_nothing() {
        let world = world(Scope::ReadWrite, Limits::DEFAULT);
        world.gate.close_mcp();
        assert_eq!(
            client_of(&world, "x").call(&create()),
            Err("E_HTTP_TOKEN_INVALID".into())
        );
        assert!(world.core.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn no_token_in_the_keychain_answers_a_code() {
        let world = world(Scope::ReadWrite, Limits::DEFAULT);
        *world.tokens.0.lock().unwrap() = None;
        assert_eq!(
            client_of(&world, "x").call(&create()),
            Err("E_MCP_TOKEN_MISSING".into())
        );
    }

    #[test]
    fn nothing_listening_finds_devot_once_more_then_answers_a_code() {
        let world = world(Scope::ReadWrite, Limits::DEFAULT);
        let tokens = Arc::clone(&world.tokens);
        let socket = world.socket.clone();
        drop(world.server);
        let finds = Arc::new(Mutex::new(0));
        let counted = Arc::clone(&finds);
        let client = HttpApiClient::with(
            Box::new(move || {
                *counted.lock().unwrap() += 1;
                Ok(socket.clone())
            }),
            Box::new(Shared(tokens)),
            Arc::new(Mutex::new(String::new())),
        );
        assert_eq!(client.call(&read()), Err("E_MCP_CONNECTION_LOST".into()));
        assert_eq!(*finds.lock().unwrap(), 2);
    }

    #[test]
    fn a_devot_it_cannot_reach_answers_with_that_code_and_never_reads_the_token() {
        let client = HttpApiClient::with(
            Box::new(|| Err("E_MCP_BACKGROUND_START_OFF")),
            Box::new(MemoryTokens::default()),
            Arc::new(Mutex::new(String::new())),
        );
        assert_eq!(
            client.call(&read()),
            Err("E_MCP_BACKGROUND_START_OFF".into())
        );
    }

    #[test]
    fn sends_nothing_to_a_peer_of_another_user() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("x.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let heard = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let _ = stream.read_to_end(&mut got);
            got
        });
        let caller = Caller {
            token: "dvt_secret",
            client: "",
            session: "AAAAAAAAAAA",
        };
        let someone_else = crate::atomic_file::effective_uid().wrapping_add(1);
        assert_eq!(
            exchange(&socket, &read(), &caller, someone_else),
            Err(ExchangeError::Untrusted)
        );
        assert!(
            heard.join().unwrap().is_empty(),
            "not a byte, the token least of all"
        );
    }

    #[test]
    fn reads_the_peers_user_on_a_unix_socket() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(
            crate::atomic_file::peer_uid(&a),
            Some(crate::atomic_file::effective_uid())
        );
    }

    #[test]
    fn the_worst_json_escaping_of_a_note_at_its_limit_passes_the_socket() {
        let world = world(Scope::ReadWrite, Limits::DEFAULT);
        let client = client_of(&world, "x");
        let max = crate::http_api::routes::MAX_MARKDOWN_BYTES;
        for markdown in ["\u{1}".repeat(max), "\\".repeat(max)] {
            let request = ApiRequest {
                method: "POST",
                target: "/v1/notes".into(),
                body: Some(json!({ "title": "T", "markdown": markdown, "notebook": "N" })),
            };
            assert_eq!(client.call(&request), Ok(json!({ "id": "n1" })));
        }
        let over = ApiRequest {
            method: "POST",
            target: "/v1/notes".into(),
            body: Some(json!({ "title": "T", "markdown": "a".repeat(max + 1), "notebook": "N" })),
        };
        assert_eq!(client.call(&over), Err("E_NOTE_BODY_TOO_LARGE".into()));
    }

    #[test]
    fn a_quitting_devot_is_asked_again_once_it_is_gone() {
        struct Quitting(Mutex<usize>);
        impl Dispatch for Quitting {
            fn dispatch(&self, _: &Call) -> Result<Value, String> {
                let mut seen = self.0.lock().unwrap();
                *seen += 1;
                if *seen == 1 {
                    Err("E_APP_QUITTING".into())
                } else {
                    Ok(json!({ "notebooks": [] }))
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("q.sock");
        let gate = Arc::new(Gate::new(Limits::DEFAULT));
        let token = token::generate().unwrap();
        let tokens = Arc::new(MemoryTokens::default());
        tokens.set(&token).unwrap();
        gate.allow_mcp(token, Scope::Read);
        let dispatch = Arc::new(Quitting(Mutex::new(0)));
        let _server = Server::start_bridge(&socket, gate, dispatch.clone()).unwrap();
        let found = socket.clone();
        let client = HttpApiClient::with(
            Box::new(move || Ok(found.clone())),
            Box::new(Shared(tokens)),
            Arc::new(Mutex::new(String::new())),
        );
        let list = ApiRequest {
            method: "GET",
            target: "/v1/notebooks".into(),
            body: None,
        };
        assert_eq!(client.call(&list), Ok(json!({ "notebooks": [] })));
        assert_eq!(*dispatch.0.lock().unwrap(), 2);
    }

    #[test]
    fn a_listener_that_is_not_devot_answers_a_code() {
        assert_eq!(parse_answer(b"not http"), None);
        let answer =
            parse_answer(b"HTTP/1.1 500 Error\r\nRetry-After: 3\r\n\r\n{\"error\":\"nope\"}");
        let answer = answer.unwrap();
        assert_eq!((answer.status, answer.retry_after), (500, Some(3)));
        assert_eq!(value_of(&answer), Err("E_MCP_INTERNAL".into()));
    }
}
