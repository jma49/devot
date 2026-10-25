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

use crate::licence::Gate;
use keychain::KeyStore;
use provider::{GenerateRequest, Generated, ProviderId, check_request, provider, status_error};
use settings::{AiSettings, SettingsStore};

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

    pub fn set_settings(&self, settings: AiSettings) -> Result<Snapshot, &'static str> {
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

    /// Every AI request, from any feature and to any provider, is sent here and nowhere else.
    pub fn generate(&self, request: &GenerateRequest) -> Result<Generated, &'static str> {
        self.licence.require()?;
        let prepared = check_request(request)?;
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
        let outcome = transport::post(&wire, timeout).and_then(|answer| {
            if (200..300).contains(&answer.status) {
                implementation
                    .parse(&answer.body)
                    .map(|done| (answer.status, done))
            } else {
                log::warn!(
                    "W_AI_HTTP provider={} status={}",
                    id.as_str(),
                    answer.status
                );
                Err(status_error(answer.status))
            }
        });
        match outcome {
            Ok((status, done)) => {
                log::info!("I_AI_GENERATED provider={} status={status}", id.as_str());
                Ok(Generated {
                    provider: id,
                    model: model.to_string(),
                    text: done.text,
                    stop: done.stop,
                    usage: done.usage,
                })
            }
            Err(code) => {
                log::warn!("W_AI_FAILED provider={} code={code}", id.as_str());
                Err(code)
            }
        }
    }
}

async fn blocking<T: Send + 'static>(
    ai: &Arc<Ai>,
    work: impl FnOnce(&Ai) -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    let ai = Arc::clone(ai);
    tauri::async_runtime::spawn_blocking(move || work(&ai))
        .await
        .map_err(|_| "E_AI_FAILED".to_string())?
        .map_err(String::from)
}

/// The main window runs this when the user starts an AI action.
#[tauri::command]
pub async fn ai_generate(
    ai: State<'_, Arc<Ai>>,
    request: GenerateRequest,
) -> Result<Generated, String> {
    blocking(&ai, move |ai| ai.generate(&request)).await
}

#[tauri::command]
pub async fn ai_settings_get(ai: State<'_, Arc<Ai>>) -> Result<Snapshot, String> {
    blocking(&ai, |ai| Ok(ai.snapshot())).await
}

#[tauri::command]
pub async fn ai_settings_set(
    ai: State<'_, Arc<Ai>>,
    settings: AiSettings,
) -> Result<Snapshot, String> {
    blocking(&ai, move |ai| ai.set_settings(settings)).await
}

#[tauri::command]
pub async fn ai_key_set(
    ai: State<'_, Arc<Ai>>,
    provider: ProviderId,
    key: String,
) -> Result<Snapshot, String> {
    blocking(&ai, move |ai| ai.set_key(provider, &key)).await
}

#[tauri::command]
pub async fn ai_key_clear(
    ai: State<'_, Arc<Ai>>,
    provider: ProviderId,
) -> Result<Snapshot, String> {
    blocking(&ai, move |ai| ai.clear_key(provider)).await
}

#[cfg(test)]
mod tests;
