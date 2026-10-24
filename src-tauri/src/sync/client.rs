//! The relay's client side (docs/sync-relay.md): vault creation and enrollment over HTTP, and the
//! socket, which a thread of its own reads and writes. The relay sends no CORS headers and the
//! device token must stay out of the web view, so the socket lives here; the core sends plaintext
//! records through commands and Rust seals them under the vault key.

use std::collections::HashMap;
use std::io::{ErrorKind, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::Url;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};
use zeroize::Zeroizing;

use super::{MAX_CHUNK_BYTES, Vault, enrollment_verifier};

pub(crate) const PROTOCOL_VERSION: u64 = 1;
const SUBPROTOCOL: &str = "devot-relay.1";
const TOKEN_SUBPROTOCOL_PREFIX: &str = "devot-token.";
/// The relay's limits (LIMITS in src/core/sync/protocol.ts).
pub(crate) const MAX_CHUNKS: usize = 16;
const MAX_MESSAGE_BYTES: usize = 31 * 1024 * 1024;
const MAX_HTTP_ANSWER: u64 = 4096;
const MAX_URL_LEN: usize = 2048;
const MAX_TOKEN_LEN: usize = 512;
const MAX_LABEL_CHARS: usize = 256;

const CLOSE_UNAUTHORIZED: u16 = 4001;
const CLOSE_REVOKED: u16 = 4003;
const CLOSE_NO_VAULT: u16 = 4004;

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the socket thread waits on a read before it looks for something to send.
const POLL: Duration = Duration::from_millis(25);
/// A WebSocket ping (a control frame, not a billed message) keeps the connection through NATs.
const PING_EVERY: Duration = Duration::from_secs(45);
/// Nothing heard for this long, not even the answer to a ping: the connection is gone.
const SILENT_FOR: Duration = Duration::from_secs(120);
const MAX_RATE_WAITS: u32 = 10;
const MAX_RATE_WAIT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = concat!("devot/", env!("CARGO_PKG_VERSION"));

/// The relay's address: https, or http to this machine only (a relay for development or tests).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RelayUrl(Url);

fn loopback(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

impl RelayUrl {
    pub(crate) fn parse(text: &str) -> Result<Self, &'static str> {
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_URL_LEN {
            return Err("E_SYNC_RELAY_URL_INVALID");
        }
        let url = Url::parse(text).map_err(|_| "E_SYNC_RELAY_URL_INVALID")?;
        let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback(&url));
        if !scheme_ok
            || url.host_str().is_none_or(str::is_empty)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("E_SYNC_RELAY_URL_INVALID");
        }
        let clean = url.as_str().trim_end_matches('/').to_string();
        Url::parse(&clean)
            .map(Self)
            .map_err(|_| "E_SYNC_RELAY_URL_INVALID")
    }

    pub(crate) fn as_str(&self) -> &str {
        self.0.as_str().trim_end_matches('/')
    }

    fn vault_path(&self, vault: &str, rest: &str) -> String {
        format!("{}/v1/vaults/{vault}{rest}", self.as_str())
    }

    fn socket(&self, vault: &str) -> String {
        let http = self.vault_path(vault, "/socket");
        match http.strip_prefix("https://") {
            Some(rest) => format!("wss://{rest}"),
            None => format!("ws://{}", http.trim_start_matches("http://")),
        }
    }
}

/// What the relay answers to a vault's creation and a device's enrollment.
#[derive(Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct Enrolled {
    pub epoch: String,
    pub device: String,
    pub token: String,
    pub time: i64,
}

impl std::fmt::Debug for Enrolled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Enrolled")
            .field("device", &self.device)
            .finish_non_exhaustive()
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .build(),
        )
        .max_redirects(0)
        .proxy(None)
        .timeout_global(Some(HTTP_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into()
}

/// A relay's error code as it sent it, when it is one; never text of its own.
fn relay_code(value: &Value) -> Option<&'static str> {
    let code = value.get("code")?.as_str()?;
    KNOWN_CODES.iter().copied().find(|known| *known == code)
}

const KNOWN_CODES: [&str; 17] = [
    "E_SYNC_BAD_MESSAGE",
    "E_SYNC_PROTOCOL",
    "E_SYNC_TOO_LARGE",
    "E_SYNC_RATE",
    "E_SYNC_NO_DEVICE",
    "E_SYNC_INTERNAL",
    "E_SYNC_REVOKED",
    "E_SYNC_UNAUTHORIZED",
    "E_SYNC_NO_VAULT",
    "E_SYNC_VAULT_EXISTS",
    "E_SYNC_ENROLL_DENIED",
    "E_SYNC_TOO_MANY_DEVICES",
    "E_SYNC_NOT_FOUND",
    "E_SYNC_QUOTA",
    "E_RELAY_CONFIG",
    "E_SYNC_RELAY_SECRET",
    "E_SYNC_FORBIDDEN",
];

fn post(url: &str, body: &Value, bearer: Option<&str>) -> Result<Value, &'static str> {
    let agent = agent();
    let mut call = agent
        .post(url)
        .header("User-Agent", USER_AGENT)
        .header("Content-Type", "application/json");
    let authorization = bearer.map(|secret| Zeroizing::new(format!("Bearer {secret}")));
    if let Some(value) = &authorization {
        call = call.header("Authorization", value.as_str());
    }
    let body = serde_json::to_vec(body).map_err(|_| "E_SYNC_INTERNAL")?;
    let mut response = call.send(&body[..]).map_err(|_| "E_SYNC_OFFLINE")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_HTTP_ANSWER + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "E_SYNC_OFFLINE")?;
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status == 200 && bytes.len() as u64 <= MAX_HTTP_ANSWER {
        return Ok(value);
    }
    Err(relay_code(&value).unwrap_or(match status {
        401 | 403 => "E_SYNC_RELAY_SECRET",
        404 => "E_SYNC_NO_VAULT",
        _ => "E_SYNC_RELAY_FAILED",
    }))
}

fn enrolled(value: Value) -> Result<Enrolled, &'static str> {
    let reply: Enrolled = serde_json::from_value(value).map_err(|_| "E_SYNC_RELAY_FAILED")?;
    let token_ok = !reply.token.is_empty()
        && reply.token.len() <= MAX_TOKEN_LEN
        && reply
            .token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    if !token_ok || !valid_relay_id(&reply.device) || !valid_relay_id(&reply.epoch) {
        return Err("E_SYNC_RELAY_FAILED");
    }
    Ok(reply)
}

fn valid_relay_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn clean_label(label: &str) -> String {
    label.chars().take(MAX_LABEL_CHARS).collect()
}

/// Creates the vault on the relay, which asks for its own secret; only the enrollment secret's
/// verifier goes there. The relay secret is used for this request and dropped.
pub(crate) fn create_vault(
    relay: &RelayUrl,
    relay_secret: &str,
    vault: &Vault,
    label: &str,
) -> Result<Enrolled, &'static str> {
    let verifier = enrollment_verifier(&vault.enrollment_secret());
    let body = json!({
        "v": PROTOCOL_VERSION,
        "type": "create",
        "verifier": URL_SAFE_NO_PAD.encode(verifier),
        "label": clean_label(label),
    });
    let reply = post(
        &relay.vault_path(&vault.id().to_string(), ""),
        &body,
        Some(relay_secret),
    )
    .map_err(|code| match code {
        "E_SYNC_UNAUTHORIZED" | "E_SYNC_FORBIDDEN" => "E_SYNC_RELAY_SECRET",
        other => other,
    })?;
    enrolled(reply)
}

/// Enrolls this device in a vault the relay holds, with the secret any holder of the vault key
/// derives.
pub(crate) fn enroll(
    relay: &RelayUrl,
    vault: &Vault,
    label: &str,
) -> Result<Enrolled, &'static str> {
    let secret = vault.enrollment_secret();
    let encoded = Zeroizing::new(URL_SAFE_NO_PAD.encode(secret.as_ref()));
    let body = json!({
        "v": PROTOCOL_VERSION,
        "type": "enroll",
        "secret": encoded.as_str(),
        "label": clean_label(label),
    });
    enrolled(post(
        &relay.vault_path(&vault.id().to_string(), "/devices"),
        &body,
        None,
    )?)
}

/// The relay's greeting on a new socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Welcome {
    pub time: i64,
    pub epoch: String,
    pub seq: u64,
    pub device: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Event {
    Changed(u64),
    /// The socket is gone, with the code that says why.
    Closed(&'static str),
}

#[derive(Debug)]
pub(crate) struct Answer {
    pub message: Map<String, Value>,
    pub payload: Vec<u8>,
}

/// A message with chunks is one binary frame: header length (u32, big-endian), the JSON header,
/// the chunks back to back (`encodeFrame` in src/core/sync/protocol.ts).
fn encode(message: &Map<String, Value>, chunks: &[Vec<u8>]) -> Result<Message, &'static str> {
    let mut header = Map::new();
    header.insert("v".into(), PROTOCOL_VERSION.into());
    header.extend(message.clone());
    let text = serde_json::to_string(&header).map_err(|_| "E_SYNC_INTERNAL")?;
    if chunks.is_empty() {
        return Ok(Message::text(text));
    }
    let total = 4 + text.len() + chunks.iter().map(Vec::len).sum::<usize>();
    if total > MAX_MESSAGE_BYTES {
        return Err("E_SYNC_TOO_LARGE");
    }
    let mut frame = Vec::with_capacity(total);
    frame.extend_from_slice(&(text.len() as u32).to_be_bytes());
    frame.extend_from_slice(text.as_bytes());
    for chunk in chunks {
        frame.extend_from_slice(chunk);
    }
    Ok(Message::binary(frame))
}

fn decode(message: Message) -> Option<Answer> {
    let (header, payload): (Vec<u8>, Vec<u8>) = match message {
        Message::Text(text) => (text.as_bytes().to_vec(), Vec::new()),
        Message::Binary(bytes) => {
            let length = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
            let header = bytes.get(4..4usize.checked_add(length)?)?.to_vec();
            (header, bytes[4 + length..].to_vec())
        }
        _ => return None,
    };
    let Value::Object(message) = serde_json::from_slice(&header).ok()? else {
        return None;
    };
    (message.get("v").and_then(Value::as_u64) == Some(PROTOCOL_VERSION))
        .then_some(Answer { message, payload })
}

fn close_code(code: u16) -> &'static str {
    match code {
        CLOSE_UNAUTHORIZED => "E_SYNC_UNAUTHORIZED",
        CLOSE_REVOKED => "E_SYNC_REVOKED",
        CLOSE_NO_VAULT => "E_SYNC_NO_VAULT",
        _ => "E_SYNC_OFFLINE",
    }
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

fn set_read_timeout(socket: &Socket, timeout: Duration) {
    let result = match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => stream.set_read_timeout(Some(timeout)),
        MaybeTlsStream::NativeTls(stream) => stream.get_ref().set_read_timeout(Some(timeout)),
        _ => Ok(()),
    };
    if result.is_err() {
        log::warn!("W_SYNC_SOCKET_TIMEOUT");
    }
}

fn waiting(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut))
}

fn open_socket(relay: &RelayUrl, vault: &str, token: &str) -> Result<Socket, &'static str> {
    let url = Url::parse(&relay.socket(vault)).map_err(|_| "E_SYNC_RELAY_URL_INVALID")?;
    let host = url.host_str().ok_or("E_SYNC_RELAY_URL_INVALID")?;
    let port = url
        .port_or_known_default()
        .ok_or("E_SYNC_RELAY_URL_INVALID")?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| "E_SYNC_OFFLINE")?;
    let stream = addresses
        .into_iter()
        .find_map(|address| TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).ok())
        .ok_or("E_SYNC_OFFLINE")?;
    stream
        .set_read_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|_| "E_SYNC_OFFLINE")?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "E_SYNC_RELAY_URL_INVALID")?;
    let protocols = Zeroizing::new(format!("{SUBPROTOCOL}, {TOKEN_SUBPROTOCOL_PREFIX}{token}"));
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&protocols).map_err(|_| "E_SYNC_NOT_ENROLLED")?,
    );
    request
        .headers_mut()
        .insert("User-Agent", HeaderValue::from_static(USER_AGENT));
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES + 2 * 1024 * 1024))
        .max_frame_size(Some(MAX_MESSAGE_BYTES + 2 * 1024 * 1024));
    match tungstenite::client_tls_with_config(request, stream, Some(config), None) {
        Ok((socket, _)) => Ok(socket),
        Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response)))
            if response.status().as_u16() == 401 =>
        {
            Err("E_SYNC_TOKEN_REFUSED")
        }
        Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response)))
            if response.status().as_u16() == 404 =>
        {
            Err("E_SYNC_NO_VAULT")
        }
        Err(_) => Err("E_SYNC_OFFLINE"),
    }
}

fn read_welcome(socket: &mut Socket) -> Result<Welcome, &'static str> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut refused: Option<&'static str> = None;
    loop {
        if Instant::now() > deadline {
            return Err("E_SYNC_OFFLINE");
        }
        let message = match socket.read() {
            Ok(message) => message,
            Err(error) if waiting(&error) => continue,
            Err(_) => return Err(refused.unwrap_or("E_SYNC_OFFLINE")),
        };
        if let Message::Close(frame) = &message {
            return Err(frame
                .as_ref()
                .map(|f| close_code(u16::from(f.code)))
                .or(refused)
                .unwrap_or("E_SYNC_OFFLINE"));
        }
        let Some(answer) = decode(message) else {
            continue;
        };
        match answer.message.get("type").and_then(Value::as_str) {
            Some("welcome") => {
                let m = &answer.message;
                let welcome = Welcome {
                    time: m
                        .get("time")
                        .and_then(Value::as_i64)
                        .ok_or("E_SYNC_PROTOCOL")?,
                    epoch: m
                        .get("epoch")
                        .and_then(Value::as_str)
                        .filter(|e| valid_relay_id(e))
                        .ok_or("E_SYNC_PROTOCOL")?
                        .to_string(),
                    seq: m
                        .get("seq")
                        .and_then(Value::as_u64)
                        .ok_or("E_SYNC_PROTOCOL")?,
                    device: m
                        .get("device")
                        .and_then(Value::as_str)
                        .filter(|d| valid_relay_id(d))
                        .ok_or("E_SYNC_PROTOCOL")?
                        .to_string(),
                };
                return Ok(welcome);
            }
            Some("error") => refused = relay_code(&Value::Object(answer.message)),
            _ => {}
        }
    }
}

enum Outgoing {
    Send(Message),
    Close,
}

type Waiters = Arc<Mutex<HashMap<u64, Sender<Result<Answer, &'static str>>>>>;

/// An open socket to a vault. Requests may come from several threads at once: each carries its own
/// `rid`, and the socket thread hands every answer to the request that waits for it.
pub(crate) struct Connection {
    outgoing: Sender<Outgoing>,
    waiters: Waiters,
    next_rid: AtomicU64,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection").finish_non_exhaustive()
    }
}

impl Connection {
    /// Opens the socket and waits for the relay's welcome; `on_event` hears `changed` and the close.
    pub(crate) fn open(
        relay: &RelayUrl,
        vault: &str,
        token: &str,
        on_event: Box<dyn Fn(Event) + Send>,
    ) -> Result<(Self, Welcome), &'static str> {
        let mut socket = open_socket(relay, vault, token)?;
        let welcome = read_welcome(&mut socket)?;
        set_read_timeout(&socket, POLL);
        let (outgoing, incoming) = mpsc::channel();
        let waiters: Waiters = Arc::default();
        let thread_waiters = Arc::clone(&waiters);
        let thread = std::thread::Builder::new()
            .name("sync-socket".into())
            .spawn(move || run(socket, incoming, &thread_waiters, on_event.as_ref()))
            .map_err(|_| "E_SYNC_INTERNAL")?;
        Ok((
            Self {
                outgoing,
                waiters,
                next_rid: AtomicU64::new(1),
                thread: Mutex::new(Some(thread)),
            },
            welcome,
        ))
    }

    fn send_once(
        &self,
        message: &Map<String, Value>,
        chunks: &[Vec<u8>],
    ) -> Result<Answer, &'static str> {
        let rid = self.next_rid.fetch_add(1, Ordering::Relaxed);
        let mut message = message.clone();
        message.insert("rid".into(), rid.into());
        let frame = encode(&message, chunks)?;
        let (reply, answer) = mpsc::channel();
        self.waiters
            .lock()
            .map_err(|_| "E_SYNC_INTERNAL")?
            .insert(rid, reply);
        if self.outgoing.send(Outgoing::Send(frame)).is_err() {
            self.forget(rid);
            return Err("E_SYNC_OFFLINE");
        }
        match answer.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.forget(rid);
                Err("E_SYNC_TIMEOUT")
            }
            Err(RecvTimeoutError::Disconnected) => Err("E_SYNC_OFFLINE"),
        }
    }

    fn forget(&self, rid: u64) {
        if let Ok(mut waiters) = self.waiters.lock() {
            waiters.remove(&rid);
        }
    }

    /// Sends a message and waits for its answer; waits out the relay's rate limit as it asks. An
    /// `error` answer becomes its code.
    pub(crate) fn request(
        &self,
        message: &Map<String, Value>,
        chunks: &[Vec<u8>],
    ) -> Result<Answer, &'static str> {
        for _ in 0..MAX_RATE_WAITS {
            let answer = self.send_once(message, chunks)?;
            if answer.message.get("type").and_then(Value::as_str) != Some("error") {
                return Ok(answer);
            }
            let code =
                relay_code(&Value::Object(answer.message.clone())).unwrap_or("E_SYNC_RELAY_FAILED");
            if code != "E_SYNC_RATE" {
                return Err(code);
            }
            let wait = answer
                .message
                .get("retryAfter")
                .and_then(Value::as_u64)
                .map_or(MAX_RATE_WAIT, Duration::from_millis);
            std::thread::sleep(wait.min(MAX_RATE_WAIT));
        }
        Err("E_SYNC_RATE")
    }

    pub(crate) fn close(&self) {
        let _ = self.outgoing.send(Outgoing::Close);
        let thread = self.thread.lock().ok().and_then(|mut t| t.take());
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.close();
    }
}

fn run(
    mut socket: Socket,
    incoming: Receiver<Outgoing>,
    waiters: &Waiters,
    on_event: &dyn Fn(Event),
) {
    let mut last_ping = Instant::now();
    let mut last_heard = Instant::now();
    let reason = loop {
        let mut closing = false;
        loop {
            match incoming.try_recv() {
                Ok(Outgoing::Send(message)) => {
                    if socket.send(message).is_err() {
                        closing = true;
                        break;
                    }
                }
                Ok(Outgoing::Close) | Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = socket.close(None);
                    let _ = socket.flush();
                    fail_all(waiters, "E_SYNC_OFFLINE");
                    return;
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        if closing {
            break "E_SYNC_OFFLINE";
        }
        if last_heard.elapsed() > SILENT_FOR {
            break "E_SYNC_OFFLINE";
        }
        if last_ping.elapsed() > PING_EVERY {
            last_ping = Instant::now();
            if socket.send(Message::Ping(Vec::new().into())).is_err() {
                break "E_SYNC_OFFLINE";
            }
        }
        match socket.read() {
            Ok(Message::Close(frame)) => {
                break frame.map_or("E_SYNC_OFFLINE", |f| close_code(u16::from(f.code)));
            }
            Ok(message) => {
                last_heard = Instant::now();
                if let Some(answer) = decode(message) {
                    dispatch(answer, waiters, on_event);
                }
            }
            Err(error) if waiting(&error) => {}
            Err(_) => break "E_SYNC_OFFLINE",
        }
    };
    fail_all(waiters, reason);
    on_event(Event::Closed(reason));
}

fn dispatch(answer: Answer, waiters: &Waiters, on_event: &dyn Fn(Event)) {
    let rid = answer.message.get("rid").and_then(Value::as_u64);
    if let Some(rid) = rid {
        let waiter = waiters.lock().ok().and_then(|mut w| w.remove(&rid));
        if let Some(waiter) = waiter {
            let _ = waiter.send(Ok(answer));
        }
        return;
    }
    if answer.message.get("type").and_then(Value::as_str) == Some("changed")
        && let Some(seq) = answer.message.get("seq").and_then(Value::as_u64)
    {
        on_event(Event::Changed(seq));
    }
}

fn fail_all(waiters: &Waiters, code: &'static str) {
    if let Ok(mut waiters) = waiters.lock() {
        for (_, waiter) in waiters.drain() {
            let _ = waiter.send(Err(code));
        }
    }
}

/// A record the relay sent, opened when it is one this build reads.
#[derive(Debug)]
pub(crate) struct Pulled {
    pub id: String,
    pub version: u64,
    pub seq: u64,
    pub kind: String,
    pub plaintext: Result<Zeroizing<Vec<u8>>, &'static str>,
}

#[derive(Debug)]
pub(crate) struct PullPage {
    pub records: Vec<Pulled>,
    pub next: u64,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Pushed {
    Pushed { version: u64, seq: u64 },
    Rejected { version: u64 },
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The records changed after `since`, opened with the vault key. A record that does not open
/// carries its code: the engine skips it.
pub(crate) fn pull(
    connection: &Connection,
    vault: &Vault,
    since: u64,
) -> Result<PullPage, &'static str> {
    let answer = connection.request(&object(json!({ "type": "pull", "since": since })), &[])?;
    if answer.message.get("type").and_then(Value::as_str) != Some("records") {
        return Err("E_SYNC_PROTOCOL");
    }
    let heads = answer
        .message
        .get("records")
        .and_then(Value::as_array)
        .ok_or("E_SYNC_PROTOCOL")?;
    let mut at = 0usize;
    let mut records = Vec::with_capacity(heads.len());
    for head in heads {
        let id = head
            .get("id")
            .and_then(Value::as_str)
            .ok_or("E_SYNC_PROTOCOL")?;
        let version = head
            .get("version")
            .and_then(Value::as_u64)
            .ok_or("E_SYNC_PROTOCOL")?;
        let seq = head
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or("E_SYNC_PROTOCOL")?;
        let kind = head
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("E_SYNC_PROTOCOL")?;
        let lengths = head
            .get("chunks")
            .and_then(Value::as_array)
            .ok_or("E_SYNC_PROTOCOL")?;
        let mut chunks = Vec::with_capacity(lengths.len());
        for length in lengths {
            let length = length.as_u64().ok_or("E_SYNC_PROTOCOL")? as usize;
            let end = at.checked_add(length).ok_or("E_SYNC_PROTOCOL")?;
            chunks.push(answer.payload.get(at..end).ok_or("E_SYNC_PROTOCOL")?);
            at = end;
        }
        let plaintext = if kind == "record" {
            vault
                .decrypt_record(id, version, &chunks)
                .map_err(|error| error.code())
        } else {
            Err("E_SYNC_KIND_UNSUPPORTED")
        };
        records.push(Pulled {
            id: id.to_string(),
            version,
            seq,
            kind: kind.to_string(),
            plaintext,
        });
    }
    if at != answer.payload.len() {
        return Err("E_SYNC_PROTOCOL");
    }
    Ok(PullPage {
        records,
        next: answer
            .message
            .get("next")
            .and_then(Value::as_u64)
            .ok_or("E_SYNC_PROTOCOL")?,
        more: answer
            .message
            .get("more")
            .and_then(Value::as_bool)
            .ok_or("E_SYNC_PROTOCOL")?,
    })
}

/// Seals `plaintext` as version `base + 1` of record `id` and offers it to the relay, which takes
/// it only while it still holds version `base`. A record the relay could not take stays here:
/// `E_SYNC_TOO_LARGE`, found before anything is sent.
pub(crate) fn push(
    connection: &Connection,
    vault: &Vault,
    id: &str,
    base: u64,
    plaintext: &[u8],
) -> Result<Pushed, &'static str> {
    let version = base.checked_add(1).ok_or("E_SYNC_PROTOCOL")?;
    if super::chunk_count(plaintext.len()) > MAX_CHUNKS {
        return Err("E_SYNC_TOO_LARGE");
    }
    let chunks = vault
        .encrypt_record(id, version, plaintext)
        .map_err(|error| match error {
            super::SyncError::RecordTooLarge => "E_SYNC_TOO_LARGE",
            other => other.code(),
        })?;
    if chunks.len() > MAX_CHUNKS || chunks.iter().any(|c| c.len() > MAX_CHUNK_BYTES) {
        return Err("E_SYNC_TOO_LARGE");
    }
    let lengths: Vec<usize> = chunks.iter().map(Vec::len).collect();
    let message = object(json!({
        "type": "push",
        "id": id,
        "base": base,
        "kind": "record",
        "chunks": lengths,
    }));
    let answer = connection.request(&message, &chunks)?;
    let number = |key: &str| {
        answer
            .message
            .get(key)
            .and_then(Value::as_u64)
            .ok_or("E_SYNC_PROTOCOL")
    };
    match answer.message.get("type").and_then(Value::as_str) {
        Some("pushed") => Ok(Pushed::Pushed {
            version: number("version")?,
            seq: number("seq")?,
        }),
        Some("rejected") => Ok(Pushed::Rejected {
            version: number("version")?,
        }),
        _ => Err("E_SYNC_PROTOCOL"),
    }
}

#[cfg(test)]
pub(crate) fn send_raw(connection: &Connection, message: Value) -> Result<Answer, &'static str> {
    connection.request(&object(message), &[])
}
