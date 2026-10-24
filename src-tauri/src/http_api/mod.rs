//! The local HTTP API (Settings > Integrations): other tools on this Mac read and write notes while
//! Devot runs. Off by default; on 127.0.0.1 alone, on the port Settings sets; every request needs
//! the per-install token, a Host of this machine and no Origin (`server`). Rust checks a request and
//! its arguments (`routes`), then hands the call to the main window's core and waits for its answer
//! (`devot://http-api`, `http_api_done`), as quick capture does: the core reads and writes through
//! the AI service, so the API sees only notebooks with Allow AI Access on, and writes like any
//! outside edit (bodies as Yjs operations, metadata by HLC).

pub mod routes;
pub mod server;
pub mod settings;
pub mod token;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};

use routes::Call;
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

struct Running {
    server: Option<Server>,
    problem: Option<&'static str>,
}

pub struct HttpApi {
    settings: SettingsStore,
    tokens: Arc<dyn TokenStore>,
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
            gate: Arc::new(Gate::new(limits)),
            dispatch,
            answers,
            running: Mutex::new(Running {
                server: None,
                problem: None,
            }),
        }
    }

    /// The app's: calls go to the main window.
    pub fn for_app(app: &AppHandle, data_dir: &std::path::Path, identifier: &str) -> Self {
        let answers = Arc::new(Answers::default());
        let dispatch = Arc::new(WindowDispatch {
            app: app.clone(),
            answers: Arc::clone(&answers),
        });
        Self::new(
            SettingsStore::new(&data_dir.join(settings::FILE)),
            Arc::new(token::Keychain::new(identifier)),
            dispatch,
            answers,
            Limits::DEFAULT,
        )
    }

    pub fn view(&self) -> View {
        let settings = self.settings.get();
        let (listening, problem) = self
            .running
            .lock()
            .map(|r| (r.server.as_ref().map(Server::port), r.problem))
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

    /// Listens or stops as the settings say: at launch, and after every change.
    pub fn apply(&self) {
        let settings = self.settings.get();
        let Ok(mut running) = self.running.lock() else {
            return;
        };
        if !settings.enabled {
            running.server = None;
            running.problem = None;
            self.gate.close();
            return;
        }
        match self.token() {
            Ok(token) => self.gate.allow(token, settings.scope),
            Err(code) => {
                log::warn!("W_HTTP_API_START_FAILED {code}");
                running.server = None;
                running.problem = Some(code);
                self.gate.close();
                return;
            }
        }
        if running.server.as_ref().map(Server::port) == Some(settings.port) {
            running.problem = None;
            return;
        }
        running.server = None;
        match Server::start(
            settings.port,
            Arc::clone(&self.gate),
            Arc::clone(&self.dispatch),
        ) {
            Ok(server) => {
                running.server = Some(server);
                running.problem = None;
            }
            Err(code) => {
                log::warn!("W_HTTP_API_START_FAILED {code}");
                running.problem = Some(code);
            }
        }
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
