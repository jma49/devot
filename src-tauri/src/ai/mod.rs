//! Rust holds the keys and makes the request, so the web view never sees a key; the caller decides whether content may be sent (src/core/aiProvider.ts).

mod anthropic;
pub mod keychain;
mod openai;
pub mod provider;
pub mod settings;
mod transport;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::licence::Gate;
use crate::task;
use keychain::KeyStore;
use provider::{
    Completion, GenerateRequest, Generated, Partial, ProviderId, check_request, provider,
    status_error,
};
use settings::{AiSettings, SettingsStore};

const FAILED: &str = "E_AI_FAILED";

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
}

/// What Settings shows: never a key, only whether one is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active: ProviderId,
    pub suggest_on_idle: bool,
    pub anthropic: ProviderView,
    pub openai: ProviderView,
}

pub struct Ai {
    settings: SettingsStore,
    keys: Arc<dyn KeyStore>,
    licence: Gate,
    timeout: Duration,
}

impl Ai {
    pub(crate) fn new(settings: SettingsStore, keys: Arc<dyn KeyStore>, licence: Gate) -> Self {
        Self {
            settings,
            keys,
            licence,
            timeout: transport::TIMEOUT,
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let settings = self.settings.get();
        let view = |id: ProviderId| {
            let stored = settings.of(id);
            let p = provider(id);
            ProviderView {
                endpoint: stored.endpoint.clone(),
                model: stored.model.clone(),
                default_endpoint: p.default_endpoint(),
                default_model: p.default_model().unwrap_or_default(),
                key: match self.keys.has(id) {
                    Ok(true) => KeyState::Set,
                    Ok(false) => KeyState::Unset,
                    Err("E_AI_KEYCHAIN_UNAVAILABLE") => KeyState::Unavailable,
                    Err(_) => KeyState::Unknown,
                },
            }
        };
        Snapshot {
            active: settings.active,
            suggest_on_idle: settings.suggest_on_idle,
            anthropic: view(ProviderId::Anthropic),
            openai: view(ProviderId::Openai),
        }
    }

    /// A key is for the server it was entered for: an endpoint that moves to another origin takes its provider's key away first.
    pub fn set_settings(&self, settings: AiSettings) -> Result<Snapshot, &'static str> {
        let settings = settings.validated()?;
        let before = self.settings.get();
        for id in ProviderId::ALL {
            if !settings::same_origin(&before.of(id).endpoint, &settings.of(id).endpoint) {
                match self.keys.clear(id) {
                    Ok(()) | Err("E_AI_KEYCHAIN_UNAVAILABLE") => {}
                    Err(code) => return Err(code),
                }
            }
        }
        self.settings.set(settings)?;
        Ok(self.snapshot())
    }

    pub fn set_key(&self, id: ProviderId, key: &str) -> Result<Snapshot, &'static str> {
        self.keys.set(id, keychain::clean_key(key)?)?;
        Ok(self.snapshot())
    }

    pub fn clear_key(&self, id: ProviderId) -> Result<Snapshot, &'static str> {
        self.keys.clear(id)?;
        Ok(self.snapshot())
    }

    /// Every AI request, from any feature and to any provider, is sent here or by `stream` and nowhere else.
    pub fn generate(&self, request: &GenerateRequest) -> Result<Generated, &'static str> {
        let call = self.prepare(request, false)?;
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

    /// As `generate`, with the answer's text handed to `on_text` as it arrives; `on_text` returning false stops reading.
    pub fn stream(
        &self,
        request: &GenerateRequest,
        mut on_text: impl FnMut(&str) -> bool,
    ) -> Result<Generated, &'static str> {
        let call = self.prepare(request, true)?;
        let mut partial = Partial::default();
        let mut stopped = false;
        let outcome = transport::post_stream(&call.wire, call.timeout, |data| {
            let added = call.implementation.event(data, &mut partial)?;
            if !added.is_empty() && !on_text(&added) {
                stopped = true;
                return Ok(false);
            }
            Ok(!partial.ended)
        })
        .and_then(|streamed| match streamed {
            transport::Streamed::Status(status) => Err(call.refused(status)),
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

    fn prepare(&self, request: &GenerateRequest, stream: bool) -> Result<Call, &'static str> {
        self.licence.require()?;
        let mut prepared = check_request(request)?;
        prepared.stream = stream;
        let settings = self.settings.get();
        let id = request.provider.unwrap_or(settings.active);
        let implementation = provider(id);
        let stored = settings.of(id);
        let model = if stored.model.is_empty() {
            implementation.default_model().ok_or("E_AI_MODEL_MISSING")?
        } else {
            stored.model.as_str()
        };
        let key = self.keys.get(id)?.ok_or("E_AI_KEY_MISSING")?;
        let wire = implementation.build(&stored.endpoint, model, &key, &prepared);
        let timeout = request.timeout_secs.map_or(self.timeout, |s| {
            self.timeout.min(Duration::from_secs(s.into()))
        });
        Ok(Call {
            id,
            implementation,
            model: model.to_string(),
            wire,
            timeout,
        })
    }
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
) -> Result<Generated, String> {
    task::blocking_with(&ai, FAILED, move |ai| {
        let mut pieces = Pieces::new(SEND_EVERY);
        let generated = ai.stream(&request, |text| {
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

/// The bodies of the settings commands, which the iPhone's native Settings call too
/// (`screens::direct`).
pub(crate) async fn ai_settings_get_inner(ai: &Arc<Ai>) -> Result<Snapshot, &'static str> {
    task::coded_with(ai, FAILED, |ai| Ok(ai.snapshot())).await
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
