//! The listener: HTTP/1.1 on 127.0.0.1 alone, one request per connection, every guard checked
//! before a call reaches the core. Requests are read by hand to a few small limits (no keep-alive,
//! no chunked bodies), so nothing a client sends is held unbounded. No response ever carries a
//! CORS header, so a web page can never read one.

use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::Refusal;
use super::routes::{self, Call, Op};
use super::token::{self, Scope, Token};

/// Runs a checked call in the core and answers its JSON, or a code.
pub trait Dispatch: Send + Sync {
    fn dispatch(&self, call: &Call) -> Result<Value, String>;
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Requests a token may make at once, and how many it gets back each second.
    pub burst: f64,
    pub per_second: f64,
    pub max_body: usize,
    pub max_connections: usize,
    /// For the whole request to arrive, head and body.
    pub read_deadline: Duration,
}

impl Limits {
    pub const DEFAULT: Self = Self {
        burst: 30.0,
        per_second: 10.0,
        // A whole body of MAX_MARKDOWN_BYTES, escaped as JSON.
        max_body: 2 * routes::MAX_MARKDOWN_BYTES,
        max_connections: 8,
        read_deadline: Duration::from_secs(10),
    };
}

const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// What is read and dropped after a refusal, so the client gets the answer rather than a reset.
const DRAIN_BYTES: usize = 256 * 1024;
const DRAIN_TIME: Duration = Duration::from_millis(250);
/// Refusals logged at once, and how many more each second: a flood cannot fill the log.
const REFUSAL_LOG_BURST: f64 = 20.0;
const REFUSAL_LOG_PER_SECOND: f64 = 1.0;

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn full(burst: f64) -> Self {
        Self {
            tokens: burst,
            at: Instant::now(),
        }
    }

    /// The seconds until one more is free, when none is.
    fn take(&mut self, burst: f64, per_second: f64) -> Result<(), u64> {
        let now = Instant::now();
        let refill = now.duration_since(self.at).as_secs_f64() * per_second;
        self.tokens = (self.tokens + refill).min(burst);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - self.tokens) / per_second).ceil().max(1.0) as u64)
        }
    }
}

struct Access {
    token: Token,
    scope: Scope,
}

/// What requests are checked against: the current token and its scope, and the rate limits. A
/// new token takes effect at once, without a restart.
pub struct Gate {
    access: RwLock<Option<Access>>,
    rate: Mutex<Bucket>,
    refusals: Mutex<Bucket>,
    limits: Limits,
}

impl Gate {
    pub fn new(limits: Limits) -> Self {
        Self {
            access: RwLock::new(None),
            rate: Mutex::new(Bucket::full(limits.burst)),
            refusals: Mutex::new(Bucket::full(REFUSAL_LOG_BURST)),
            limits,
        }
    }

    pub fn allow(&self, token: Token, scope: Scope) {
        if let Ok(mut access) = self.access.write() {
            *access = Some(Access { token, scope });
        }
    }

    pub fn close(&self) {
        if let Ok(mut access) = self.access.write() {
            *access = None;
        }
    }

    /// The scope of the token a request carries in its `Authorization` header.
    fn admit(&self, authorization: Option<&str>) -> Result<Scope, Refusal> {
        let sent = authorization
            .and_then(|value| {
                let (scheme, rest) = value.split_once(' ')?;
                scheme.eq_ignore_ascii_case("bearer").then(|| rest.trim())
            })
            .ok_or(Refusal::new(401, "E_HTTP_TOKEN_MISSING"))?;
        let access = self
            .access
            .read()
            .map_err(|_| Refusal::new(503, "E_HTTP_API_UNAVAILABLE"))?;
        match access.as_ref() {
            Some(a) if token::same(a.token.as_bytes(), sent.as_bytes()) => Ok(a.scope),
            _ => Err(Refusal::new(401, "E_HTTP_TOKEN_INVALID")),
        }
    }

    fn take_rate(&self) -> Result<(), u64> {
        self.rate
            .lock()
            .map_err(|_| 1u64)?
            .take(self.limits.burst, self.limits.per_second)
    }

    fn may_log_refusal(&self) -> bool {
        self.refusals
            .lock()
            .is_ok_and(|mut b| b.take(REFUSAL_LOG_BURST, REFUSAL_LOG_PER_SECOND).is_ok())
    }
}

pub struct Server {
    address: SocketAddr,
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    /// Port 0 picks a free one (the tests); `port()` says which.
    pub fn start(
        port: u16,
        gate: Arc<Gate>,
        dispatch: Arc<dyn Dispatch>,
    ) -> Result<Self, &'static str> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).map_err(
            |e| match e.kind() {
                ErrorKind::AddrInUse => "E_HTTP_API_PORT_IN_USE",
                ErrorKind::PermissionDenied => "E_HTTP_API_PORT_DENIED",
                _ => "E_HTTP_API_LISTEN_FAILED",
            },
        )?;
        let address = listener
            .local_addr()
            .map_err(|_| "E_HTTP_API_LISTEN_FAILED")?;
        let port = address.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("http-api".into())
            .spawn(move || accept(&listener, port, &stopping, &gate, &dispatch))
            .map_err(|_| "E_HTTP_API_LISTEN_FAILED")?;
        log::info!("I_HTTP_API_STARTED {port}");
        Ok(Self {
            address,
            port,
            stop,
            thread: Some(thread),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    #[cfg(test)]
    pub fn address(&self) -> SocketAddr {
        self.address
    }
}

impl Drop for Server {
    /// Stops listening; a request already being answered finishes.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wakes the blocked accept so it sees the flag.
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_secs(1));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        log::info!("I_HTTP_API_STOPPED {}", self.port);
    }
}

struct Active(Arc<AtomicUsize>);

impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Runs `work` on a new thread, holding one of `active`'s counted connections until it ends; a
/// thread that cannot start gives it back at once (its closure, guard and all, is dropped).
pub fn spawn_counted(
    builder: std::thread::Builder,
    active: Arc<AtomicUsize>,
    work: impl FnOnce() + Send + 'static,
) -> std::io::Result<()> {
    let active = Active(active);
    builder
        .spawn(move || {
            let _active = active;
            work();
        })
        .map(drop)
}

fn accept(
    listener: &TcpListener,
    port: u16,
    stop: &AtomicBool,
    gate: &Arc<Gate>,
    dispatch: &Arc<dyn Dispatch>,
) {
    let active = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(mut stream) = stream else {
            // Out of file descriptors, say: wait rather than spin.
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if active.fetch_add(1, Ordering::SeqCst) >= gate.limits.max_connections {
            active.fetch_sub(1, Ordering::SeqCst);
            let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
            let busy = Reply::refused(Refusal::new(503, "E_HTTP_API_BUSY"));
            let _ = stream.write_all(&busy.bytes());
            continue;
        }
        let (gate, dispatch) = (Arc::clone(gate), Arc::clone(dispatch));
        let spawned = spawn_counted(
            std::thread::Builder::new().name("http-api-request".into()),
            Arc::clone(&active),
            move || serve(stream, port, &gate, dispatch.as_ref()),
        );
        if spawned.is_err() {
            log::warn!("W_HTTP_API_THREAD_FAILED");
        }
    }
}

pub struct Reply {
    pub status: u16,
    body: Vec<u8>,
    retry_after: Option<u64>,
    challenge: bool,
    code: Option<String>,
}

impl Reply {
    fn ok(status: u16, value: &Value) -> Self {
        Self {
            status,
            body: serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec()),
            retry_after: None,
            challenge: false,
            code: None,
        }
    }

    fn failed(status: u16, code: String) -> Self {
        Self {
            status,
            body: serde_json::to_vec(&json!({ "error": code })).unwrap_or_default(),
            retry_after: None,
            challenge: status == 401,
            code: Some(code),
        }
    }

    fn refused(refusal: Refusal) -> Self {
        Self::failed(refusal.status, refusal.code.to_string())
    }

    fn bytes(&self) -> Vec<u8> {
        let mut head = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
            self.status,
            reason(self.status),
            self.body.len()
        );
        if let Some(seconds) = self.retry_after {
            head.push_str(&format!("Retry-After: {seconds}\r\n"));
        }
        if self.challenge {
            head.push_str("WWW-Authenticate: Bearer\r\n");
        }
        head.push_str("\r\n");
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(&self.body);
        bytes
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

/// The HTTP status of a code the core or the window answered with.
pub fn status_of(code: &str) -> u16 {
    match code {
        "E_NOTE_NOT_FOUND" | "E_BOOK_NOT_FOUND" => 404,
        "E_BOOK_AMBIGUOUS"
        | "E_BOOK_NAME_TAKEN"
        | "E_AI_PATCH_NOT_FOUND"
        | "E_AI_PATCH_AMBIGUOUS" => 409,
        "E_NOTE_BODY_TOO_LARGE" => 413,
        "E_STORAGE_BUSY" | "E_CORE_NOT_READY" | "E_HTTP_API_UNAVAILABLE" => 503,
        "E_HTTP_API_TIMEOUT" => 504,
        _ if code.starts_with("E_AI_")
            || code.starts_with("E_SEARCH_")
            || code.ends_with("_INVALID")
            || code == "E_NOTE_LINKS_TOO_MANY" =>
        {
            400
        }
        _ => 500,
    }
}

struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
}

impl Head {
    /// The one value of a header; a header sent twice is refused.
    fn one(&self, name: &str) -> Result<Option<&str>, Refusal> {
        let mut found = self.headers.iter().filter(|(n, _)| n == name);
        let first = found.next().map(|(_, v)| v.as_str());
        if found.next().is_some() {
            return Err(Refusal::new(400, "E_HTTP_BAD_REQUEST"));
        }
        Ok(first)
    }

    fn has(&self, name: &str) -> bool {
        self.headers.iter().any(|(n, _)| n == name)
    }
}

const BAD_REQUEST: Refusal = Refusal::new(400, "E_HTTP_BAD_REQUEST");
const TIMED_OUT: Refusal = Refusal::new(408, "E_HTTP_TIMEOUT");

fn parse_head(bytes: &[u8]) -> Result<Head, Refusal> {
    let text = std::str::from_utf8(bytes).map_err(|_| BAD_REQUEST)?;
    let mut lines = text.split("\r\n");
    let line = lines.next().ok_or(BAD_REQUEST)?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(BAD_REQUEST);
    };
    if method.is_empty()
        || !method.bytes().all(|b| b.is_ascii_uppercase())
        || !target.starts_with('/')
        || !target.bytes().all(|b| b.is_ascii_graphic())
        || !matches!(version, "HTTP/1.1" | "HTTP/1.0")
    {
        return Err(BAD_REQUEST);
    }
    let mut headers = Vec::new();
    for line in lines {
        if headers.len() == MAX_HEADERS {
            return Err(Refusal::new(431, "E_HTTP_HEADERS_TOO_LARGE"));
        }
        let (name, value) = line.split_once(':').ok_or(BAD_REQUEST)?;
        let token = |b: u8| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b);
        if name.is_empty()
            || !name.bytes().all(token)
            || value.chars().any(|c| c.is_control() && c != '\t')
        {
            return Err(BAD_REQUEST);
        }
        headers.push((name.to_ascii_lowercase(), value.trim().to_string()));
    }
    Ok(Head {
        method: method.to_string(),
        target: target.to_string(),
        headers,
    })
}

fn find_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Reads into `buffer` until `done` says so, the deadline passes or the peer stops sending.
fn read_until(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
    deadline: Instant,
    mut done: impl FnMut(&[u8]) -> Result<bool, Refusal>,
) -> Result<(), Refusal> {
    let mut chunk = [0u8; 8192];
    while !done(buffer)? {
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(TIMED_OUT)?;
        stream
            .set_read_timeout(Some(left))
            .map_err(|_| BAD_REQUEST)?;
        match stream.read(&mut chunk) {
            Ok(0) => return Err(BAD_REQUEST),
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return Err(TIMED_OUT);
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return Err(BAD_REQUEST),
        }
    }
    Ok(())
}

fn host_allowed(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|host| {
        host == format!("127.0.0.1:{port}")
            || host.eq_ignore_ascii_case(&format!("localhost:{port}"))
    })
}

fn is_json(content_type: Option<&str>) -> bool {
    let Some(value) = content_type else {
        return false;
    };
    let mut parts = value.split(';').map(str::trim);
    parts
        .next()
        .is_some_and(|media| media.eq_ignore_ascii_case("application/json"))
        && parts.all(|p| {
            p.split_once('=').is_some_and(|(k, v)| {
                k.trim().eq_ignore_ascii_case("charset")
                    && v.trim().trim_matches('"').eq_ignore_ascii_case("utf-8")
            })
        })
}

/// What one request made: its answer, and what the log says of it.
struct Outcome {
    reply: Reply,
    op: Option<Op>,
    note: Option<String>,
}

impl From<Refusal> for Outcome {
    fn from(refusal: Refusal) -> Self {
        Self {
            reply: Reply::refused(refusal),
            op: None,
            note: None,
        }
    }
}

fn serve(mut stream: TcpStream, port: u16, gate: &Gate, dispatch: &dyn Dispatch) {
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let outcome = handle(&mut stream, port, gate, dispatch).unwrap_or_else(Outcome::from);
    log_outcome(gate, &outcome);
    let _ = stream.write_all(&outcome.reply.bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Write);
    drain(&mut stream);
}

fn drain(stream: &mut TcpStream) {
    let until = Instant::now() + DRAIN_TIME;
    let mut chunk = [0u8; 8192];
    let mut read = 0;
    while read < DRAIN_BYTES {
        let Some(left) = until
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
        else {
            return;
        };
        if stream.set_read_timeout(Some(left)).is_err() {
            return;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => read += n,
        }
    }
}

fn log_outcome(gate: &Gate, outcome: &Outcome) {
    let status = outcome.reply.status;
    let note = outcome
        .note
        .as_deref()
        .map(|n| format!(" {n}"))
        .unwrap_or_default();
    let code = outcome
        .reply
        .code
        .as_deref()
        .map(|c| format!(" {c}"))
        .unwrap_or_default();
    match outcome.op {
        Some(op) if status < 400 => log::info!("I_HTTP_API_REQUEST {} {status}{note}", op.as_str()),
        Some(op) => log::warn!("W_HTTP_API_REQUEST {} {status}{code}{note}", op.as_str()),
        None if gate.may_log_refusal() => log::warn!("W_HTTP_API_REFUSED {status}{code}"),
        None => {}
    }
}

fn handle(
    stream: &mut TcpStream,
    port: u16,
    gate: &Gate,
    dispatch: &dyn Dispatch,
) -> Result<Outcome, Refusal> {
    let deadline = Instant::now() + gate.limits.read_deadline;
    let mut buffer = Vec::new();
    read_until(stream, &mut buffer, deadline, |b| {
        if find_end(b).is_some() {
            Ok(true)
        } else if b.len() > MAX_HEAD_BYTES {
            Err(Refusal::new(431, "E_HTTP_HEADERS_TOO_LARGE"))
        } else {
            Ok(false)
        }
    })?;
    let end = find_end(&buffer).ok_or(BAD_REQUEST)?;
    if end > MAX_HEAD_BYTES {
        return Err(Refusal::new(431, "E_HTTP_HEADERS_TOO_LARGE"));
    }
    let head = parse_head(&buffer[..end])?;
    let mut body = buffer.split_off(end + 4);

    // DNS rebinding: a page on another name that resolves here sends that name.
    if !host_allowed(head.one("host")?, port) {
        return Err(Refusal::new(403, "E_HTTP_HOST_REFUSED"));
    }
    // Browsers name the page a request comes from; nothing else needs to.
    if head.has("origin") {
        return Err(Refusal::new(403, "E_HTTP_ORIGIN_REFUSED"));
    }
    // Browsers always send these and no page script can set them; Node's fetch sends only
    // Sec-Fetch-Mode, so that one alone is no sign of a browser.
    if head.has("sec-fetch-site") || head.has("sec-fetch-dest") {
        return Err(Refusal::new(403, "E_HTTP_BROWSER_REFUSED"));
    }
    let scope = gate.admit(head.one("authorization")?)?;
    if let Err(seconds) = gate.take_rate() {
        let mut outcome = Outcome::from(Refusal::new(429, "E_HTTP_RATE_LIMITED"));
        outcome.reply.retry_after = Some(seconds);
        return Ok(outcome);
    }

    let (path, query) = match head.target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (head.target.as_str(), None),
    };
    let (op, note) = routes::route(&head.method, path)?;
    let fail = |refusal: Refusal, note: &Option<String>| Outcome {
        reply: Reply::refused(refusal),
        op: Some(op),
        note: note.clone(),
    };
    if op.writes() && scope == Scope::Read {
        return Ok(fail(Refusal::new(403, "E_HTTP_READ_ONLY"), &note));
    }
    if head.has("transfer-encoding") {
        return Ok(fail(Refusal::new(411, "E_HTTP_LENGTH_REQUIRED"), &note));
    }
    let length = match head.one("content-length")? {
        None => None,
        Some(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => {
            Some(text.parse::<usize>().unwrap_or(usize::MAX))
        }
        Some(_) => return Err(BAD_REQUEST),
    };
    if op.takes_body() {
        if !is_json(head.one("content-type")?) {
            return Ok(fail(Refusal::new(415, "E_HTTP_JSON_REQUIRED"), &note));
        }
        let Some(length) = length else {
            return Ok(fail(Refusal::new(411, "E_HTTP_LENGTH_REQUIRED"), &note));
        };
        if length > gate.limits.max_body {
            return Ok(fail(Refusal::new(413, "E_HTTP_BODY_TOO_LARGE"), &note));
        }
        if head
            .one("expect")?
            .is_some_and(|e| e.eq_ignore_ascii_case("100-continue"))
        {
            let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
        }
        read_until(stream, &mut body, deadline, |b| Ok(b.len() >= length))?;
        if body.len() != length {
            return Err(BAD_REQUEST);
        }
    } else if length.unwrap_or(0) != 0 || !body.is_empty() {
        return Ok(fail(Refusal::new(400, "E_HTTP_BODY_UNEXPECTED"), &note));
    }

    let call = match routes::call(op, note.clone(), query, &body) {
        Ok(call) => call,
        Err(refusal) => return Ok(fail(refusal, &note)),
    };
    drop(body);
    Ok(match dispatch.dispatch(&call) {
        Ok(value) => {
            let made = if op.creates() {
                value
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| crate::commands::notes::valid_note_id(id))
                    .map(str::to_string)
            } else {
                None
            };
            Outcome {
                reply: Reply::ok(if op.creates() { 201 } else { 200 }, &value),
                op: Some(op),
                note: made.or(note),
            }
        }
        Err(code) => Outcome {
            reply: Reply::failed(status_of(&code), code),
            op: Some(op),
            note,
        },
    })
}
