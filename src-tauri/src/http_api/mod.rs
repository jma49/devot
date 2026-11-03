//! The local HTTP API (Settings > Integrations): other tools on this Mac read and write notes while
//! Devot runs. Off by default; on 127.0.0.1 alone, on the port Settings sets; every request needs
//! the per-install token, a Host of this machine and no Origin (`server`). Rust checks a request and
//! its arguments (`routes`), then hands the call to the main window's core and waits for its answer
//! (`devot://http-api`, `http_api_done`), as quick capture does: the core reads and writes through
//! the AI service, so the API sees only notebooks with Allow AI Access on, and writes like any
//! outside edit (bodies as Yjs operations, metadata by HLC). The MCP bridge reaches the same listener
//! with a token of its own (`mcp_access`, ADR 0012); turning it on does not turn this API on.

pub mod mcp_access;
pub mod rendezvous;
pub mod routes;
pub mod server;
pub mod settings;
pub mod token;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};

use mcp_access::{McpAccess, McpAccessStore};
use rendezvous::Rendezvous;
use routes::{Call, Client};
use server::{Dispatch, Gate, Limits, Server};
use settings::{HttpApiSettings, SettingsStore, check_port};
use token::{Scope, TokenStore};

pub const EVENT: &str = "devot://http-api";
/// A write may wait behind a save, an import's file or a busy database.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
const CODE_MAX: usize = 80;

/// A request refused before it reaches the core: its status and code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub code: &'static str,
}

impl Refusal {
    pub const fn new(status: u16, code: &'static str) -> Self {
        Self { status, code }
    }
}

type Answer = Result<Value, String>;

/// Calls handed to the main window and not answered yet.
#[derive(Default)]
pub struct Answers {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, SyncSender<Answer>>>,
}

impl Answers {
    fn wait(&self) -> Option<(u64, std::sync::mpsc::Receiver<Answer>)> {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (reply, answer) = sync_channel(1);
        self.waiting.lock().ok()?.insert(id, reply);
        Some((id, answer))
    }

    /// False for an ID that is not waiting (answered already, timed out, or never asked).
    fn answer(&self, id: u64, answer: Answer) -> bool {
        let reply = self.waiting.lock().ok().and_then(|mut w| w.remove(&id));
        reply.is_some_and(|reply| reply.send(answer).is_ok())
    }

    fn forget(&self, id: u64) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(&id);
        }
    }

    /// Whether a call is on its way through the core.
    fn busy(&self) -> bool {
        self.waiting.lock().map_or(true, |w| !w.is_empty())
    }

    /// Hands `call` on with `emit` and waits for its answer; `emit` is false when the event could not
    /// be sent. Tauri sends an event no window listens for without an error, so a window that is
    /// not listening yet shows as a timeout.
    fn ask(&self, call: &Call, timeout: Duration, emit: impl FnOnce(Request) -> bool) -> Answer {
        let (id, answer) = self.wait().ok_or("E_HTTP_API_FAILED")?;
        let request = Request {
            id,
            op: call.op.as_str(),
            note: call.note.clone(),
            args: call.args.clone(),
            client: call.client.clone(),
        };
        if !emit(request) {
            self.forget(id);
            return Err("E_HTTP_API_UNAVAILABLE".into());
        }
        match answer.recv_timeout(timeout) {
            Ok(answer) => answer,
            Err(_) => {
                self.forget(id);
                log::warn!("W_HTTP_API_TIMEOUT {} {id}", call.op.as_str());
                Err("E_HTTP_API_TIMEOUT".into())
            }
        }
    }
}

/// What the main window gets (`readHttpApiRequest` in `src/core/httpApi.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Request {
    pub id: u64,
    pub op: &'static str,
    pub note: Option<String>,
    pub args: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<Client>,
}

/// The window's answer as Rust passes it on: its JSON, or a code, never free text.
fn answer_from(result: Option<Value>, error: Option<String>) -> Answer {
    match error {
        None => Ok(result.unwrap_or(Value::Null)),
        Some(code)
            if code.starts_with("E_")
                && (3..=CODE_MAX).contains(&code.len())
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') =>
        {
            Err(code)
        }
        Some(_) => Err("E_HTTP_API_FAILED".into()),
    }
}

struct WindowDispatch {
    app: AppHandle,
    answers: Arc<Answers>,
}

/// Refuses a write once the trial is over without a licence, before the window is asked; the
/// database would refuse it too, but the core could keep a refused edit pending.
struct Licensed<D> {
    licence: crate::licence::Gate,
    inner: D,
}

impl<D: Dispatch> Dispatch for Licensed<D> {
    fn dispatch(&self, call: &Call) -> Result<Value, String> {
        if call.op.writes() {
            self.licence
                .require_write(crate::storage::Write::Content)
                .map_err(String::from)?;
        }
        self.inner.dispatch(call)
    }
}

impl Dispatch for WindowDispatch {
    fn dispatch(&self, call: &Call) -> Result<Value, String> {
        self.answers.ask(call, ANSWER_TIMEOUT, |request| {
            crate::main_windows::emit_front(&self.app, EVENT, request).is_ok()
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenState {
    Set,
    Unset,
    Unknown,
    Unavailable,
}

/// What Settings shows: never the token, only whether one is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub enabled: bool,
    pub port: u16,
    pub scope: Scope,
    /// The port it listens on, while it does.
    pub listening: Option<u16>,
    /// Why it is on but not listening.
    pub problem: Option<&'static str>,
    pub token: TokenState,
}

/// What Settings shows of MCP access: never the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpView {
    pub enabled: bool,
    pub scope: Scope,
    pub background_start: bool,
    /// Whether a connected client can get through now.
    pub reachable: bool,
    /// Why it is on but not reachable.
    pub problem: Option<&'static str>,
}

struct Running {
    server: Option<Server>,
    problem: Option<&'static str>,
    mcp_problem: Option<&'static str>,
}

/// MCP access's own settings, token and rendezvous (ADR 0012).
pub struct McpParts {
    pub access: McpAccessStore,
    pub tokens: Arc<dyn TokenStore>,
    pub rendezvous: Option<Rendezvous>,
}

pub struct HttpApi {
    settings: SettingsStore,
    tokens: Arc<dyn TokenStore>,
    mcp: Option<McpParts>,
    /// A main window listens for calls: a call made before that would wait its whole timeout.
    window_listening: AtomicBool,
    gate: Arc<Gate>,
    dispatch: Arc<dyn Dispatch>,
    answers: Arc<Answers>,
    running: Mutex<Running>,
}

impl HttpApi {
    pub fn new(
        settings: SettingsStore,
        tokens: Arc<dyn TokenStore>,
        dispatch: Arc<dyn Dispatch>,
        answers: Arc<Answers>,
        limits: Limits,
    ) -> Self {
        Self {
            settings,
            tokens,
            mcp: None,
            window_listening: AtomicBool::new(false),
            gate: Arc::new(Gate::new(limits)),
            dispatch,
            answers,
            running: Mutex::new(Running {
                server: None,
                problem: None,
                mcp_problem: None,
            }),
        }
    }

    pub fn with_mcp(mut self, parts: McpParts) -> Self {
        self.mcp = Some(parts);
        self
    }

    /// The app's: calls go to the main window, writes only while the licence allows them.
    pub fn for_app(
        app: &AppHandle,
        data_dir: &std::path::Path,
        identifier: &str,
        licence: crate::licence::Gate,
    ) -> Self {
        let answers = Arc::new(Answers::default());
        let dispatch = Arc::new(Licensed {
            licence,
            inner: WindowDispatch {
                app: app.clone(),
                answers: Arc::clone(&answers),
            },
        });
        Self::new(
            SettingsStore::new(&data_dir.join(settings::FILE)),
            Arc::new(token::Keychain::new(identifier)),
            dispatch,
            answers,
            Limits::DEFAULT,
        )
        .with_mcp(McpParts {
            access: McpAccessStore::new(&data_dir.join(mcp_access::FILE)),
            tokens: Arc::new(token::Keychain::for_mcp(identifier)),
            rendezvous: Rendezvous::for_identifier(identifier),
        })
    }

    pub fn view(&self) -> View {
        let settings = self.settings.get();
        let (listening, problem) = self
            .running
            .lock()
            .map(|r| {
                let port = r.server.as_ref().map(Server::port);
                (port.filter(|_| settings.enabled), r.problem)
            })
            .unwrap_or((None, Some("E_HTTP_API_FAILED")));
        View {
            enabled: settings.enabled,
            port: settings.port,
            scope: settings.scope,
            listening,
            problem,
            token: match self.tokens.has() {
                Ok(true) => TokenState::Set,
                Ok(false) => TokenState::Unset,
                Err("E_HTTP_API_KEYCHAIN_UNAVAILABLE") => TokenState::Unavailable,
                Err(_) => TokenState::Unknown,
            },
        }
    }

    /// The stored token, or a new one (of the stored scope) when there is none yet.
    fn token(&self) -> Result<token::Token, &'static str> {
        match self.tokens.get()? {
            Some(token) if token::is_token(&token) => Ok(token),
            _ => {
                let token = token::generate()?;
                self.tokens.set(&token)?;
                log::info!("I_HTTP_API_TOKEN_CREATED");
                Ok(token)
            }
        }
    }

    fn mcp_access(&self) -> McpAccess {
        self.mcp
            .as_ref()
            .map_or_else(McpAccess::default, |parts| parts.access.get())
    }

    /// The bridge's stored token, or a new one when there is none yet.
    fn mcp_token(parts: &McpParts) -> Result<token::Token, &'static str> {
        match parts.tokens.get()? {
            Some(token) if token::is_token(&token) => Ok(token),
            _ => {
                let token = token::generate()?;
                parts.tokens.set(&token)?;
                log::info!("I_MCP_TOKEN_CREATED");
                Ok(token)
            }
        }
    }

    /// Listens or stops as the settings say: at launch, and after every change. One listener serves
    /// both holders, and each token gets in only while its own switch is on.
    pub fn apply(&self) {
        let settings = self.settings.get();
        let access = self.mcp_access();
        let Ok(mut running) = self.running.lock() else {
            return;
        };
        running.problem = None;
        running.mcp_problem = None;
        if settings.enabled {
            match self.token() {
                Ok(token) => self.gate.allow(token, settings.scope),
                Err(code) => {
                    log::warn!("W_HTTP_API_START_FAILED {code}");
                    running.problem = Some(code);
                    self.gate.close();
                }
            }
        } else {
            self.gate.close();
        }
        match self.mcp.as_ref().filter(|_| access.enabled) {
            Some(parts) => match Self::mcp_token(parts) {
                Ok(token) => self.gate.allow_mcp(token, access.scope),
                Err(code) => {
                    log::warn!("W_MCP_START_FAILED {code}");
                    running.mcp_problem = Some(code);
                    self.gate.close_mcp();
                }
            },
            None => self.gate.close_mcp(),
        }
        let http_wanted = settings.enabled && running.problem.is_none();
        let mcp_wanted = access.enabled && running.mcp_problem.is_none();
        if !http_wanted && !mcp_wanted {
            running.server = None;
            self.publish(None);
            return;
        }
        if running.server.as_ref().map(Server::port) != Some(settings.port) {
            self.publish(None);
            running.server = None;
            match Server::start(
                settings.port,
                Arc::clone(&self.gate),
                Arc::clone(&self.dispatch),
            ) {
                Ok(server) => running.server = Some(server),
                Err(code) => {
                    log::warn!("W_HTTP_API_START_FAILED {code}");
                    if http_wanted {
                        running.problem = Some(code);
                    }
                    if mcp_wanted {
                        running.mcp_problem = Some(code);
                    }
                }
            }
        }
        let reachable = running
            .server
            .as_ref()
            .filter(|_| mcp_wanted && self.window_listening.load(Ordering::SeqCst))
            .map(Server::port);
        self.publish(reachable);
    }

    fn publish(&self, port: Option<u16>) {
        let Some(rendezvous) = self.mcp.as_ref().and_then(|p| p.rendezvous.as_ref()) else {
            return;
        };
        match port {
            Some(port) => {
                if let Err(code) = rendezvous.publish(port) {
                    log::warn!("W_MCP_START_FAILED {code}");
                }
            }
            None => rendezvous.withdraw(),
        }
    }

    /// A main window has begun to take calls: only now may the bridge be told where to send them.
    pub fn window_listening(&self) {
        self.window_listening.store(true, Ordering::SeqCst);
        self.apply();
    }

    /// Takes back what the last launch may have left, before anything else can read it.
    pub fn forget_rendezvous(&self) {
        self.publish(None);
    }

    pub fn mcp_view(&self) -> McpView {
        let access = self.mcp_access();
        let (listening, problem) = self
            .running
            .lock()
            .map(|r| (r.server.is_some(), r.mcp_problem))
            .unwrap_or((false, Some("E_HTTP_API_FAILED")));
        McpView {
            enabled: access.enabled,
            scope: access.scope,
            background_start: access.background_start,
            reachable: access.enabled && listening && problem.is_none(),
            problem,
        }
    }

    pub fn mcp_set(&self, access: McpAccess) -> Result<McpView, &'static str> {
        self.mcp
            .as_ref()
            .ok_or("E_MCP_ACCESS_UNAVAILABLE")?
            .access
            .set(access)?;
        self.apply();
        Ok(self.mcp_view())
    }

    /// Connecting a client asks for MCP to be on, and changes nothing else about it.
    pub fn mcp_turn_on(&self) -> Result<McpView, &'static str> {
        self.mcp_set(McpAccess {
            enabled: true,
            ..self.mcp_access()
        })
    }

    /// When the bridge last called, and whether a call is on its way (`background`).
    pub fn mcp_activity(&self) -> (Option<std::time::Instant>, bool) {
        (self.gate.last_mcp_call(), self.answers.busy())
    }

    pub fn set(&self, enabled: bool, port: u16) -> Result<View, &'static str> {
        let stored = self.settings.get();
        self.settings.set(HttpApiSettings {
            enabled,
            port: check_port(port)?,
            scope: stored.scope,
        })?;
        self.apply();
        Ok(self.view())
    }

    /// A new token with `scope`: the old one stops working at once. The listener takes the new
    /// token even when the scope cannot be saved, so it always admits the token Settings shows,
    /// with the scope Settings shows.
    pub fn rotate(&self, scope: Scope) -> Result<View, &'static str> {
        let token = token::generate()?;
        self.tokens.set(&token)?;
        log::info!("I_HTTP_API_TOKEN_CREATED");
        let stored = self.settings.get();
        let saved = self.settings.set(HttpApiSettings { scope, ..stored });
        self.apply();
        saved.map(|_| self.view())
    }

    pub fn reveal(&self) -> Result<token::Token, &'static str> {
        self.tokens
            .get()?
            .filter(|t| token::is_token(t))
            .ok_or("E_HTTP_API_TOKEN_MISSING")
    }

    pub fn answer(&self, id: u64, result: Option<Value>, error: Option<String>) -> bool {
        self.answers.answer(id, answer_from(result, error))
    }
}

async fn blocking<T: Send + 'static>(
    api: &Arc<HttpApi>,
    work: impl FnOnce(&HttpApi) -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    let api = Arc::clone(api);
    tauri::async_runtime::spawn_blocking(move || work(&api))
        .await
        .map_err(|_| "E_HTTP_API_FAILED".to_string())?
        .map_err(String::from)
}

#[tauri::command]
pub async fn mcp_access_get(api: State<'_, Arc<HttpApi>>) -> Result<McpView, String> {
    blocking(&api, |api| Ok(api.mcp_view())).await
}

/// The choice of the Settings window alone: every field is a typed value serde has checked.
#[tauri::command]
pub async fn mcp_access_set(
    window: WebviewWindow,
    api: State<'_, Arc<HttpApi>>,
    enabled: bool,
    scope: Scope,
    background_start: bool,
) -> Result<McpView, String> {
    if window.label() != crate::settings::LABEL {
        return Err("E_MCP_ACCESS_WINDOW".into());
    }
    blocking(&api, move |api| {
        api.mcp_set(McpAccess {
            enabled,
            scope,
            background_start,
        })
    })
    .await
}

/// From the main window once it listens for calls (`httpApiHost`).
#[tauri::command]
pub async fn http_api_listening(
    window: WebviewWindow,
    api: State<'_, Arc<HttpApi>>,
) -> Result<(), String> {
    if !crate::main_windows::is_main(window.label()) {
        return Err("E_HTTP_API_WINDOW".into());
    }
    blocking(&api, |api| {
        api.window_listening();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn http_api_get(api: State<'_, Arc<HttpApi>>) -> Result<View, String> {
    blocking(&api, |api| Ok(api.view())).await
}

#[tauri::command]
pub async fn http_api_set(
    api: State<'_, Arc<HttpApi>>,
    enabled: bool,
    port: u16,
) -> Result<View, String> {
    blocking(&api, move |api| api.set(enabled, port)).await
}

#[tauri::command]
pub async fn http_api_token_rotate(
    api: State<'_, Arc<HttpApi>>,
    scope: Scope,
) -> Result<View, String> {
    blocking(&api, move |api| api.rotate(scope)).await
}

/// Settings shows the token when asked, to copy into a tool.
#[tauri::command]
pub async fn http_api_token_reveal(
    window: WebviewWindow,
    api: State<'_, Arc<HttpApi>>,
) -> Result<String, String> {
    if window.label() != crate::settings::LABEL {
        return Err("E_HTTP_API_WINDOW".into());
    }
    blocking(&api, |api| api.reveal().map(|t| t.as_str().to_string())).await
}

#[tauri::command]
pub fn http_api_done(
    window: WebviewWindow,
    api: State<'_, Arc<HttpApi>>,
    id: u64,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if !crate::main_windows::is_main(window.label()) {
        return Err("E_HTTP_API_WINDOW".into());
    }
    if api.answer(id, result, error) {
        Ok(())
    } else {
        Err("E_HTTP_API_UNKNOWN".into())
    }
}

#[cfg(test)]
mod tests;
