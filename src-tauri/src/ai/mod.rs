//! Rust holds the keys and makes the request, so the web view never sees a key; the caller decides whether content may be sent (src/core/aiProvider.ts).

mod anthropic;
pub mod catalog;
#[cfg(any(desktop, test))]
pub(crate) mod cli;
pub mod keychain;
mod openai;
pub mod provider;
pub mod settings;
mod transport;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, Webview};

#[cfg(any(desktop, test))]
pub use cli::CliState;

use crate::licence::Gate;
use crate::task;
use catalog::{Catalog, CatalogModel};
use keychain::KeyStore;
use provider::{
    Completion, GenerateRequest, Generated, Message, Partial, Prepared, ProviderId, Purpose, Role,
    check_request, provider, status_error,
};
use settings::{AiSettings, SettingsStore, StoredSettings, SuggestModel};

const FAILED: &str = "E_AI_FAILED";
/// A model list that takes longer than this is not worth waiting for in Settings.
const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);
/// Try It's whole prompt: it carries no note text.
const TRY_PROMPT: &str = "Reply with the word OK.";
const TRY_MAX_TOKENS: u32 = 1024;
const TRY_TIMEOUT_SECS: u32 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyState {
    Set,
    Unset,
    Unknown,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub endpoint: String,
    pub model: String,
    pub default_endpoint: &'static str,
    pub default_model: &'static str,
    pub key: KeyState,
    pub reasoning: Option<String>,
}

#[cfg(any(desktop, test))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProviderView {
    pub state: CliState,
    pub model: String,
    pub reasoning: Option<String>,
}

#[cfg(any(desktop, test))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliViews {
    pub claude_cli: CliProviderView,
    pub codex_cli: CliProviderView,
}

/// What Settings shows: never a key, only whether one is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active: ProviderId,
    pub suggest_on_idle: bool,
    pub anthropic: ProviderView,
    pub openai: ProviderView,
    #[cfg(any(desktop, test))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli: Option<CliViews>,
    /// Absent: next edit suggestions use the Model setting.
    pub suggest_model: Option<SuggestModel>,
    /// `active` is only the stored fallback: a local tool not checked yet may take its place.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub active_pending: bool,
}

/// The models of each provider asked for; one that could not list them carries its own failure code.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalogs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic: Option<Catalog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai: Option<Catalog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_cli: Option<Catalog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_cli: Option<Catalog>,
}

/// A Try It answer: how long the provider took to reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tried {
    pub provider: ProviderId,
    pub model: String,
    pub elapsed_ms: u64,
}

/// The settings a catalog was fetched under; a cached list is good only while they still hold.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CatalogSource {
    endpoint: String,
    epoch: u64,
}

struct CachedCatalog {
    source: CatalogSource,
    models: Vec<CatalogModel>,
}

/// The provider, model and reasoning a request goes to; `model` None is the provider's Model setting, and empty its default.
struct Choice {
    id: ProviderId,
    model: Option<String>,
    reasoning: Option<String>,
}

pub struct Ai {
    settings: SettingsStore,
    keys: Arc<dyn KeyStore>,
    licence: Gate,
    timeout: Duration,
    streams: Mutex<Streams>,
    catalogs: Mutex<HashMap<ProviderId, CachedCatalog>>,
    /// Bumped when a key or the command-line tools change, so no catalog fetched before is served after.
    catalog_epoch: AtomicU64,
    #[cfg(any(desktop, test))]
    cli: Option<Arc<dyn cli::CliBackend>>,
    #[cfg(any(desktop, test))]
    cli_states: Mutex<Option<cli::CliStates>>,
    #[cfg(any(desktop, test))]
    cli_probe: Mutex<()>,
}

/// How many cancels for streams not yet started, and streams ended, are remembered; a page has a few at a time.
const REMEMBERED_STREAMS: usize = 64;

/// A stream as the page names it: the webview that asked (every main window shares one `Ai`) and its number there.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct StreamKey {
    webview: String,
    id: u64,
}

impl StreamKey {
    pub fn new(webview: impl Into<String>, id: u64) -> Self {
        Self {
            webview: webview.into(),
            id,
        }
    }
}

fn remember(list: &mut VecDeque<StreamKey>, key: &StreamKey) {
    if list.len() == REMEMBERED_STREAMS {
        list.pop_front();
    }
    list.push_back(key.clone());
}

#[derive(Default)]
struct Streams {
    active: HashMap<StreamKey, Arc<AtomicBool>>,
    /// Streams the page cancelled before Rust registered them (registration runs on a blocking thread).
    cancelled_early: VecDeque<StreamKey>,
    /// Streams that ended: a cancel that comes after is late, not early, and must not stop a later stream.
    ended: VecDeque<StreamKey>,
}

impl Streams {
    /// The new stream's cancel flag, or None when the page cancelled it before it started.
    fn register(&mut self, key: &StreamKey) -> Option<Arc<AtomicBool>> {
        if self.cancelled_early.contains(key) {
            self.cancelled_early.retain(|early| early != key);
            return None;
        }
        self.ended.retain(|ended| ended != key);
        let flag = Arc::new(AtomicBool::new(false));
        self.active.insert(key.clone(), Arc::clone(&flag));
        Some(flag)
    }

    /// True if the stream was running; one not started yet stops as it starts, and one that ended is left alone.
    fn cancel(&mut self, key: &StreamKey) -> bool {
        if let Some(flag) = self.active.get(key) {
            flag.store(true, Ordering::SeqCst);
            return true;
        }
        if !self.ended.contains(key) {
            remember(&mut self.cancelled_early, key);
        }
        false
    }

    fn finish(&mut self, key: &StreamKey, flag: &Arc<AtomicBool>) {
        if self
            .active
            .get(key)
            .is_some_and(|entry| Arc::ptr_eq(entry, flag))
        {
            self.active.remove(key);
            remember(&mut self.ended, key);
        }
    }
}

struct StreamGuard<'a> {
    streams: &'a Mutex<Streams>,
    key: StreamKey,
    flag: Arc<AtomicBool>,
}

impl Drop for StreamGuard<'_> {
    fn drop(&mut self) {
        let mut guard = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        guard.finish(&self.key, &self.flag);
    }
}

impl Ai {
    pub(crate) fn new(settings: SettingsStore, keys: Arc<dyn KeyStore>, licence: Gate) -> Self {
        Self {
            settings,
            keys,
            licence,
            timeout: transport::TIMEOUT,
            streams: Mutex::new(Streams::default()),
            catalogs: Mutex::new(HashMap::new()),
            catalog_epoch: AtomicU64::new(0),
            #[cfg(any(desktop, test))]
            cli: None,
            #[cfg(any(desktop, test))]
            cli_states: Mutex::new(None),
            #[cfg(any(desktop, test))]
            cli_probe: Mutex::new(()),
        }
    }

    #[cfg(desktop)]
    pub(crate) fn with_local_cli(mut self) -> Self {
        self.cli = Some(Arc::new(cli::SystemCli));
        self
    }

    #[cfg(test)]
    pub(crate) fn with_cli(mut self, backend: Arc<dyn cli::CliBackend>) -> Self {
        self.cli = Some(backend);
        self
    }

    fn key_state(&self, id: ProviderId) -> KeyState {
        match self.keys.has(id) {
            Ok(true) => KeyState::Set,
            Ok(false) => KeyState::Unset,
            Err("E_AI_KEYCHAIN_UNAVAILABLE") => KeyState::Unavailable,
            Err(_) => KeyState::Unknown,
        }
    }

    #[cfg(any(desktop, test))]
    fn cached_cli_states(&self) -> Option<cli::CliStates> {
        self.cli_states.lock().ok().and_then(|guard| *guard)
    }

    #[cfg(any(desktop, test))]
    fn cli_states(&self) -> Option<cli::CliStates> {
        let backend = self.cli.as_ref()?;
        if let Some(cached) = self.cached_cli_states() {
            return Some(cached);
        }
        let _probe = self.cli_probe.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(guard) = self.cli_states.lock()
            && let Some(cached) = *guard
        {
            return Some(cached);
        }
        let probed = backend.probe();
        if let Ok(mut guard) = self.cli_states.lock() {
            *guard = Some(probed);
        }
        Some(probed)
    }

    #[cfg(any(desktop, test))]
    pub fn refresh_cli(&self) -> Snapshot {
        if let Some(backend) = self.cli.as_ref() {
            let _probe = self.cli_probe.lock().unwrap_or_else(|e| e.into_inner());
            let probed = backend.probe();
            if let Ok(mut guard) = self.cli_states.lock() {
                *guard = Some(probed);
            }
            self.forget_catalogs();
        }
        self.snapshot()
    }

    /// Without `probe`, a local tool not checked yet counts as not ready.
    /// The provider the Model setting resolves to, and whether that waits on the local tools' first check.
    fn effective_active(
        &self,
        stored: &StoredSettings,
        anthropic_key: KeyState,
        probe: bool,
    ) -> (ProviderId, bool) {
        #[cfg(not(desktop))]
        {
            let _ = (anthropic_key, probe);
            let active = if stored.settings.active.is_cli() {
                ProviderId::Anthropic
            } else {
                stored.settings.active
            };
            (active, false)
        }
        #[cfg(desktop)]
        {
            if stored.explicit_active || anthropic_key != KeyState::Unset {
                return (stored.settings.active, false);
            }
            let states = if probe {
                self.cli_states()
            } else {
                self.cached_cli_states()
            };
            match states {
                Some(states) if states.claude_cli == CliState::Ready => {
                    (ProviderId::ClaudeCli, false)
                }
                Some(states) if states.codex_cli == CliState::Ready => {
                    (ProviderId::CodexCli, false)
                }
                Some(_) => (stored.settings.active, false),
                None => (stored.settings.active, self.cli.is_some()),
            }
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.view(true)
    }

    /// Settings opens on this: the local tools' first check takes seconds, so until it answers they read `Checking`.
    pub fn snapshot_unprobed(&self) -> Snapshot {
        self.view(false)
    }

    fn view(&self, probe: bool) -> Snapshot {
        let stored = self.settings.get_stored();
        let settings = &stored.settings;
        let view = |id: ProviderId| {
            let entry = settings.of(id);
            let p = provider(id);
            ProviderView {
                endpoint: entry.map_or_else(String::new, |s| s.endpoint.clone()),
                model: entry.map_or_else(String::new, |s| s.model.clone()),
                default_endpoint: p.map_or("", |impl_| impl_.default_endpoint()),
                default_model: p
                    .and_then(|impl_| impl_.default_model())
                    .unwrap_or_default(),
                key: self.key_state(id),
                reasoning: settings.reasoning(id).map(str::to_string),
            }
        };
        let anthropic = view(ProviderId::Anthropic);
        let (active, active_pending) = self.effective_active(&stored, anthropic.key, probe);
        #[cfg(any(desktop, test))]
        let states = if probe {
            self.cli_states()
        } else {
            self.cli
                .as_ref()
                .map(|_| self.cached_cli_states().unwrap_or(cli::CliStates::CHECKING))
        };
        #[cfg(any(desktop, test))]
        let cli = states.map(|states| CliViews {
            claude_cli: CliProviderView {
                state: states.claude_cli,
                model: settings.claude_cli.model.clone(),
                reasoning: settings
                    .reasoning(ProviderId::ClaudeCli)
                    .map(str::to_string),
            },
            codex_cli: CliProviderView {
                state: states.codex_cli,
                model: settings.codex_cli.model.clone(),
                reasoning: settings.reasoning(ProviderId::CodexCli).map(str::to_string),
            },
        });
        Snapshot {
            active,
            suggest_on_idle: settings.suggest_on_idle,
            anthropic,
            openai: view(ProviderId::Openai),
            #[cfg(any(desktop, test))]
            cli,
            suggest_model: settings.suggest_model.get().cloned(),
            active_pending,
        }
    }

    /// A key is for the server it was entered for: an endpoint that moves to another origin takes its provider's key away first.
    pub fn set_settings(&self, settings: AiSettings) -> Result<Snapshot, &'static str> {
        let settings = settings.validated()?;
        #[cfg(not(desktop))]
        if settings.active.is_cli()
            || settings
                .suggest_model
                .get()
                .is_some_and(|suggest| suggest.provider.is_cli())
        {
            return Err("E_AI_PROVIDER_UNAVAILABLE");
        }
        let saved = self
            .clear_moved_keys(&settings)
            .and_then(|()| self.settings.set(settings));
        // A key may have gone even when the save then fails.
        self.forget_catalogs();
        saved?;
        Ok(self.snapshot())
    }

    /// A key belongs to the origin it was entered for, so a provider moved to another origin loses it.
    fn clear_moved_keys(&self, next: &AiSettings) -> Result<(), &'static str> {
        let before = self.settings.get();
        for id in ProviderId::HTTP {
            if let (Some(prev), Some(next)) = (before.of(id), next.of(id))
                && !settings::same_origin(&prev.endpoint, &next.endpoint)
            {
                match self.keys.clear(id) {
                    Ok(()) | Err("E_AI_KEYCHAIN_UNAVAILABLE") => {}
                    Err(code) => return Err(code),
                }
            }
        }
        Ok(())
    }

    pub fn set_key(&self, id: ProviderId, key: &str) -> Result<Snapshot, &'static str> {
        if id.is_cli() {
            return Err("E_AI_REQUEST_INVALID");
        }
        self.keys.set(id, keychain::clean_key(key)?)?;
        self.forget_catalogs();
        Ok(self.snapshot())
    }

    pub fn clear_key(&self, id: ProviderId) -> Result<Snapshot, &'static str> {
        if id.is_cli() {
            return Err("E_AI_REQUEST_INVALID");
        }
        let cleared = self.keys.clear(id);
        self.forget_catalogs();
        cleared?;
        Ok(self.snapshot())
    }

    /// Every AI request, from any feature and to any provider, is sent here or by `stream` and nowhere else.
    pub fn generate(&self, request: &GenerateRequest) -> Result<Generated, &'static str> {
        self.generate_with(request, None)
    }

    fn generate_with(
        &self,
        request: &GenerateRequest,
        pick: Option<Choice>,
    ) -> Result<Generated, &'static str> {
        let (prepared, call) = self.prepare(request, false, pick)?;
        match call {
            PreparedCall::Http(call) => {
                let _ = prepared;
                let outcome = transport::post(&call.wire, call.timeout).and_then(|answer| {
                    if (200..300).contains(&answer.status) {
                        call.implementation
                            .parse(&answer.body)
                            .map(|done| (answer.status, done))
                    } else {
                        Err(call.refused(answer.status))
                    }
                });
                match outcome {
                    Ok((status, done)) => {
                        log::info!(
                            "I_AI_GENERATED provider={} status={status}",
                            call.id.as_str()
                        );
                        Ok(call.answer(done))
                    }
                    Err(code) => Err(call.failed(code)),
                }
            }
            #[cfg(desktop)]
            PreparedCall::Cli {
                id,
                model,
                reasoning,
                timeout,
                backend,
            } => match backend.run(
                id,
                cli::CliChoice {
                    model: &model,
                    reasoning: reasoning.as_deref(),
                },
                &prepared,
                timeout,
                &|| false,
                &mut |_| true,
            ) {
                Ok(done) => {
                    log::info!("I_AI_GENERATED provider={}", id.as_str());
                    Ok(Generated {
                        provider: id,
                        model: done.model,
                        text: done.completion.text,
                        stop: done.completion.stop,
                        usage: done.completion.usage,
                    })
                }
                Err(code) => {
                    log::warn!("W_AI_FAILED provider={} code={code}", id.as_str());
                    Err(code)
                }
            },
        }
    }

    /// As `generate`, with the answer's text handed to `on_text` as it arrives; `on_text` returning false stops reading.
    #[cfg(test)]
    pub fn stream(
        &self,
        request: &GenerateRequest,
        on_text: impl FnMut(&str) -> bool,
    ) -> Result<Generated, &'static str> {
        self.stream_with_id(None, request, on_text)
    }

    /// As `stream`, binding `stream` (when present) so `cancel_stream` can abort an in-flight stream early.
    pub fn stream_with_id(
        &self,
        stream: Option<StreamKey>,
        request: &GenerateRequest,
        mut on_text: impl FnMut(&str) -> bool,
    ) -> Result<Generated, &'static str> {
        let cancel_guard = match stream {
            Some(key) if key.id == 0 => return Err("E_AI_REQUEST_INVALID"),
            Some(key) => {
                let mut guard = self.streams.lock().unwrap_or_else(|e| e.into_inner());
                let flag = guard.register(&key).ok_or("E_AI_CANCELLED")?;
                Some(StreamGuard {
                    streams: &self.streams,
                    key,
                    flag,
                })
            }
            None => None,
        };
        let is_cancelled = || {
            cancel_guard
                .as_ref()
                .is_some_and(|guard| guard.flag.load(Ordering::SeqCst))
        };
        let (prepared, call) = self.prepare(request, true, None)?;
        if is_cancelled() {
            return Err("E_AI_CANCELLED");
        }
        match call {
            PreparedCall::Http(call) => {
                let _ = prepared;
                let mut partial = Partial::default();
                let mut stopped = false;
                let outcome =
                    transport::post_stream(&call.wire, call.timeout, is_cancelled, |data| {
                        let added = call.implementation.event(data, &mut partial)?;
                        if !added.is_empty() && !on_text(&added) {
                            stopped = true;
                            return Ok(false);
                        }
                        Ok(!partial.ended)
                    })
                    .and_then(|streamed| match streamed {
                        transport::Streamed::Status(status) => Err(call.refused(status)),
                        transport::Streamed::Cancelled => Err("E_AI_CANCELLED"),
                        transport::Streamed::Done if stopped => Err("E_AI_CANCELLED"),
                        transport::Streamed::Done => {
                            // A stream that breaks off before the provider says it stopped is not an answer.
                            let stop = partial.stop.ok_or("E_AI_RESPONSE_INVALID")?;
                            Ok(Completion {
                                usage: partial.usage(),
                                text: std::mem::take(&mut partial.text),
                                stop,
                            })
                        }
                    });
                match outcome {
                    Ok(done) => {
                        log::info!("I_AI_STREAMED provider={}", call.id.as_str());
                        Ok(call.answer(done))
                    }
                    Err(code) => Err(call.failed(code)),
                }
            }
            #[cfg(desktop)]
            PreparedCall::Cli {
                id,
                model,
                reasoning,
                timeout,
                backend,
            } => match backend.run(
                id,
                cli::CliChoice {
                    model: &model,
                    reasoning: reasoning.as_deref(),
                },
                &prepared,
                timeout,
                &is_cancelled,
                &mut on_text,
            ) {
                Ok(done) => {
                    log::info!("I_AI_STREAMED provider={}", id.as_str());
                    Ok(Generated {
                        provider: id,
                        model: done.model,
                        text: done.completion.text,
                        stop: done.completion.stop,
                        usage: done.completion.usage,
                    })
                }
                Err(code) => {
                    log::warn!("W_AI_FAILED provider={} code={code}", id.as_str());
                    Err(code)
                }
            },
        }
    }

    /// Marks stream `stream` cancelled; returns true if it was running, and one not started yet stops as it starts.
    pub fn cancel_stream(&self, stream: &StreamKey) -> Result<bool, &'static str> {
        if stream.id == 0 {
            return Err("E_AI_REQUEST_INVALID");
        }
        let mut guard = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        Ok(guard.cancel(stream))
    }

    #[cfg(test)]
    pub(crate) fn early_cancels(&self) -> usize {
        let guard = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        guard.cancelled_early.len()
    }

    /// Where a request goes: the provider it names, else the suggestion model for a suggestion, else the active provider.
    fn choose(&self, request: &GenerateRequest, stored: &StoredSettings) -> Choice {
        let settings = &stored.settings;
        let stored_choice = |id: ProviderId| Choice {
            id,
            model: None,
            reasoning: settings.reasoning(id).map(str::to_string),
        };
        if let Some(id) = request.provider {
            return stored_choice(id);
        }
        if request.purpose == Purpose::Suggest
            && let Some(suggest) = settings.suggest_model.get()
        {
            return Choice {
                id: suggest.provider,
                model: (!suggest.model.is_empty()).then(|| suggest.model.clone()),
                reasoning: suggest.reasoning.clone(),
            };
        }
        stored_choice(
            self.effective_active(stored, self.key_state(ProviderId::Anthropic), true)
                .0,
        )
    }

    fn prepare<'a>(
        &self,
        request: &'a GenerateRequest,
        stream: bool,
        pick: Option<Choice>,
    ) -> Result<(Prepared<'a>, PreparedCall), &'static str> {
        self.licence.require()?;
        let mut prepared = check_request(request)?;
        prepared.stream = stream;
        let stored = self.settings.get_stored();
        let choice = pick.unwrap_or_else(|| self.choose(request, &stored));
        let id = choice.id;
        let timeout = request.timeout_secs.map_or(self.timeout, |s| {
            self.timeout.min(Duration::from_secs(s.into()))
        });
        if id.is_cli() {
            #[cfg(not(desktop))]
            {
                let _ = prepared;
                let _ = timeout;
                log::warn!(
                    "W_AI_FAILED provider={} code=E_AI_PROVIDER_UNAVAILABLE",
                    id.as_str()
                );
                return Err("E_AI_PROVIDER_UNAVAILABLE");
            }
            #[cfg(desktop)]
            {
                let Some(backend) = self.cli.as_ref().map(Arc::clone) else {
                    log::warn!(
                        "W_AI_FAILED provider={} code=E_AI_PROVIDER_UNAVAILABLE",
                        id.as_str()
                    );
                    return Err("E_AI_PROVIDER_UNAVAILABLE");
                };
                let model = choice
                    .model
                    .unwrap_or_else(|| stored.settings.cli_model(id).to_string());
                return Ok((
                    prepared,
                    PreparedCall::Cli {
                        id,
                        model,
                        reasoning: choice.reasoning,
                        timeout,
                        backend,
                    },
                ));
            }
        }
        let implementation = provider(id).ok_or("E_AI_PROVIDER_UNAVAILABLE")?;
        let entry = stored.settings.of(id).ok_or("E_AI_PROVIDER_UNAVAILABLE")?;
        let named = choice.model.as_deref().unwrap_or(&entry.model);
        let model = if named.is_empty() {
            implementation.default_model().ok_or("E_AI_MODEL_MISSING")?
        } else {
            named
        };
        let key = self.keys.get(id)?.ok_or("E_AI_KEY_MISSING")?;
        let wire = implementation.build(
            &entry.endpoint,
            model,
            &key,
            choice.reasoning.as_deref(),
            &prepared,
        );
        Ok((
            prepared,
            PreparedCall::Http(Call {
                id,
                implementation,
                model: model.to_string(),
                wire,
                timeout,
            }),
        ))
    }

    /// Sends Try It's fixed prompt to `id` with this model and reasoning, and times the answer.
    pub fn try_model(
        &self,
        id: ProviderId,
        model: &str,
        reasoning: Option<&str>,
    ) -> Result<Tried, &'static str> {
        let model = settings::clean_model(model)?;
        let reasoning = settings::clean_reasoning(reasoning)?;
        let request = GenerateRequest {
            provider: Some(id),
            system: None,
            messages: vec![Message {
                role: Role::User,
                content: TRY_PROMPT.to_string(),
            }],
            max_tokens: Some(TRY_MAX_TOKENS),
            timeout_secs: Some(TRY_TIMEOUT_SECS),
            purpose: Purpose::Main,
        };
        let started = Instant::now();
        self.generate_with(
            &request,
            Some(Choice {
                id,
                model: Some(model.clone()),
                reasoning,
            }),
        )?;
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        log::info!("I_AI_TRIED provider={} ms={elapsed_ms}", id.as_str());
        Ok(Tried {
            provider: id,
            model,
            elapsed_ms,
        })
    }

    fn forget_catalogs(&self) {
        self.catalog_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// The models of each provider in `providers`, from the cache unless `refresh`; a provider that fails does not fail the others.
    pub fn models(
        &self,
        providers: &[ProviderId],
        refresh: bool,
    ) -> Result<Catalogs, &'static str> {
        let distinct = providers
            .iter()
            .enumerate()
            .all(|(i, id)| !providers[..i].contains(id));
        if providers.is_empty() || !distinct {
            return Err("E_AI_REQUEST_INVALID");
        }
        let settings = self.settings.get();
        let epoch = self.catalog_epoch.load(Ordering::SeqCst);
        Ok(std::thread::scope(|scope| {
            let handles: Vec<_> = providers
                .iter()
                .map(|&id| {
                    let settings = &settings;
                    (
                        id,
                        scope.spawn(move || self.catalog(id, settings, epoch, refresh)),
                    )
                })
                .collect();
            let mut catalogs = Catalogs::default();
            for (id, handle) in handles {
                let catalog = handle.join().unwrap_or(Catalog::Failed { code: FAILED });
                let slot = match id {
                    ProviderId::Anthropic => &mut catalogs.anthropic,
                    ProviderId::Openai => &mut catalogs.openai,
                    ProviderId::ClaudeCli => &mut catalogs.claude_cli,
                    ProviderId::CodexCli => &mut catalogs.codex_cli,
                };
                *slot = Some(catalog);
            }
            catalogs
        }))
    }

    fn catalog(&self, id: ProviderId, settings: &AiSettings, epoch: u64, refresh: bool) -> Catalog {
        let source = CatalogSource {
            endpoint: settings
                .of(id)
                .map_or_else(String::new, |entry| entry.endpoint.clone()),
            epoch,
        };
        let default_model = provider(id).and_then(|p| p.default_model());
        if !refresh {
            let cache = self.catalogs.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(hit) = cache.get(&id).filter(|hit| hit.source == source) {
                return Catalog::Ready {
                    models: hit.models.clone(),
                    default_model,
                };
            }
        }
        match self.fetch_models(id, settings) {
            Ok(models) => {
                log::info!(
                    "I_AI_MODELS provider={} count={}",
                    id.as_str(),
                    models.len()
                );
                let mut cache = self.catalogs.lock().unwrap_or_else(|e| e.into_inner());
                if self.catalog_epoch.load(Ordering::SeqCst) == epoch {
                    cache.insert(
                        id,
                        CachedCatalog {
                            source,
                            models: models.clone(),
                        },
                    );
                }
                Catalog::Ready {
                    models,
                    default_model,
                }
            }
            Err(code) => {
                log::warn!("W_AI_MODELS_FAILED provider={} code={code}", id.as_str());
                Catalog::Failed { code }
            }
        }
    }

    fn fetch_models(
        &self,
        id: ProviderId,
        settings: &AiSettings,
    ) -> Result<Vec<CatalogModel>, &'static str> {
        if id.is_cli() {
            #[cfg(any(desktop, test))]
            {
                let backend = self.cli.as_ref().ok_or("E_AI_PROVIDER_UNAVAILABLE")?;
                return backend.models(id);
            }
            #[cfg(not(any(desktop, test)))]
            return Err("E_AI_PROVIDER_UNAVAILABLE");
        }
        let implementation = provider(id).ok_or("E_AI_PROVIDER_UNAVAILABLE")?;
        let entry = settings.of(id).ok_or("E_AI_PROVIDER_UNAVAILABLE")?;
        // Asked without a prompt first, so a provider with no key never reads the keychain.
        if !self.keys.has(id)? {
            return Err("E_AI_KEY_MISSING");
        }
        let key = self.keys.get(id)?.ok_or("E_AI_KEY_MISSING")?;
        // Reading the key can wait on the keychain; a key stays with the endpoint it was read for.
        let current = self.settings.get();
        if current.of(id).map(|now| now.endpoint.as_str()) != Some(entry.endpoint.as_str()) {
            return Err("E_AI_SETTINGS_CHANGED");
        }
        let wire = implementation.models_request(&entry.endpoint, &key);
        let answer = transport::get(&wire, self.timeout.min(CATALOG_TIMEOUT))?;
        if !(200..300).contains(&answer.status) {
            log::warn!(
                "W_AI_HTTP provider={} status={}",
                id.as_str(),
                answer.status
            );
            return Err(status_error(answer.status));
        }
        implementation.parse_models(&answer.body)
    }
}

enum PreparedCall {
    Http(Call),
    #[cfg(desktop)]
    Cli {
        id: ProviderId,
        model: String,
        reasoning: Option<String>,
        timeout: Duration,
        backend: Arc<dyn cli::CliBackend>,
    },
}

struct Call {
    id: ProviderId,
    implementation: &'static dyn provider::Provider,
    model: String,
    wire: provider::WireRequest,
    timeout: Duration,
}

impl Call {
    fn refused(&self, status: u16) -> &'static str {
        log::warn!("W_AI_HTTP provider={} status={status}", self.id.as_str());
        status_error(status)
    }

    fn failed(&self, code: &'static str) -> &'static str {
        log::warn!("W_AI_FAILED provider={} code={code}", self.id.as_str());
        code
    }

    fn answer(&self, done: Completion) -> Generated {
        Generated {
            provider: self.id,
            model: self.model.clone(),
            text: done.text,
            stop: done.stop,
            usage: done.usage,
        }
    }
}

/// The main window runs this when the user starts an AI action.
#[tauri::command]
pub async fn ai_generate(
    ai: State<'_, Arc<Ai>>,
    request: GenerateRequest,
) -> Result<Generated, String> {
    task::blocking_with(&ai, FAILED, move |ai| ai.generate(&request)).await
}

/// As `ai_generate`, with the answer's text sent to `on_text` as it arrives, a few pieces at a time.
#[tauri::command]
pub async fn ai_stream(
    ai: State<'_, Arc<Ai>>,
    request: GenerateRequest,
    on_text: Channel<String>,
    webview: Webview,
    stream_id: Option<u64>,
) -> Result<Generated, String> {
    let stream = stream_id.map(|id| StreamKey::new(webview.label(), id));
    task::blocking_with(&ai, FAILED, move |ai| {
        let mut pieces = Pieces::new(SEND_EVERY);
        let generated = ai.stream_with_id(stream, &request, |text| {
            pieces
                .push(text)
                .is_none_or(|ready| on_text.send(ready).is_ok())
        })?;
        if let Some(rest) = pieces.rest() {
            let _ = on_text.send(rest);
        }
        Ok(generated)
    })
    .await
}

/// Cancels an active `ai_stream` request of this webview by `stream_id`.
#[tauri::command]
pub async fn ai_stream_cancel(
    ai: State<'_, Arc<Ai>>,
    webview: Webview,
    stream_id: u64,
) -> Result<bool, String> {
    ai.cancel_stream(&StreamKey::new(webview.label(), stream_id))
        .map_err(Into::into)
}

/// How often streamed text crosses to the page: each crossing costs a message, and the eye reads no faster.
const SEND_EVERY: Duration = Duration::from_millis(40);

/// Text to send, gathered until `every` has passed since the last send.
pub(crate) struct Pieces {
    every: Duration,
    gathered: String,
    sent: Option<std::time::Instant>,
}

impl Pieces {
    pub(crate) fn new(every: Duration) -> Self {
        Self {
            every,
            gathered: String::new(),
            sent: None,
        }
    }

    /// The text to send now, if it is time.
    pub(crate) fn push(&mut self, text: &str) -> Option<String> {
        self.gathered.push_str(text);
        let due = self.sent.is_none_or(|at| at.elapsed() >= self.every);
        if !due {
            return None;
        }
        self.sent = Some(std::time::Instant::now());
        Some(std::mem::take(&mut self.gathered))
    }

    /// What is left to send at the end.
    pub(crate) fn rest(&mut self) -> Option<String> {
        (!self.gathered.is_empty()).then(|| std::mem::take(&mut self.gathered))
    }
}

#[tauri::command]
pub async fn ai_settings_get(ai: State<'_, Arc<Ai>>) -> Result<Snapshot, String> {
    Ok(ai_settings_get_inner(&ai).await?)
}

#[tauri::command]
pub async fn ai_settings_set(
    ai: State<'_, Arc<Ai>>,
    settings: AiSettings,
) -> Result<Snapshot, String> {
    Ok(ai_settings_set_inner(&ai, settings).await?)
}

#[tauri::command]
pub async fn ai_key_set(
    ai: State<'_, Arc<Ai>>,
    provider: ProviderId,
    key: String,
) -> Result<Snapshot, String> {
    Ok(ai_key_set_inner(&ai, provider, key).await?)
}

#[tauri::command]
pub async fn ai_key_clear(
    ai: State<'_, Arc<Ai>>,
    provider: ProviderId,
) -> Result<Snapshot, String> {
    Ok(ai_key_clear_inner(&ai, provider).await?)
}

/// The models of each provider in `providers` for the model picker; `refresh` fetches them again instead of using the last lists.
#[tauri::command]
pub async fn ai_models(
    ai: State<'_, Arc<Ai>>,
    providers: Vec<ProviderId>,
    refresh: bool,
) -> Result<Catalogs, String> {
    task::blocking_with(&ai, FAILED, move |ai| ai.models(&providers, refresh)).await
}

/// Try It: a fixed prompt with no note text, sent to one provider and model.
#[tauri::command]
pub async fn ai_try(
    ai: State<'_, Arc<Ai>>,
    provider: ProviderId,
    model: String,
    reasoning: Option<String>,
) -> Result<Tried, String> {
    task::blocking_with(&ai, FAILED, move |ai| {
        ai.try_model(provider, &model, reasoning.as_deref())
    })
    .await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn ai_cli_refresh(ai: State<'_, Arc<Ai>>) -> Result<Snapshot, String> {
    Ok(task::coded_with(&ai, FAILED, |ai| Ok(ai.refresh_cli())).await?)
}

/// The bodies of the settings commands, which the iPhone's native Settings call too
/// (`screens::direct`).
pub(crate) async fn ai_settings_get_inner(ai: &Arc<Ai>) -> Result<Snapshot, &'static str> {
    task::coded_with(ai, FAILED, |ai| Ok(ai.snapshot_unprobed())).await
}

pub(crate) async fn ai_settings_set_inner(
    ai: &Arc<Ai>,
    settings: AiSettings,
) -> Result<Snapshot, &'static str> {
    task::coded_with(ai, FAILED, move |ai| ai.set_settings(settings)).await
}

pub(crate) async fn ai_key_set_inner(
    ai: &Arc<Ai>,
    provider: ProviderId,
    key: String,
) -> Result<Snapshot, &'static str> {
    let key = zeroize::Zeroizing::new(key);
    task::coded_with(ai, FAILED, move |ai| ai.set_key(provider, &key)).await
}

pub(crate) async fn ai_key_clear_inner(
    ai: &Arc<Ai>,
    provider: ProviderId,
) -> Result<Snapshot, &'static str> {
    task::coded_with(ai, FAILED, move |ai| ai.clear_key(provider)).await
}

#[cfg(test)]
mod tests;
