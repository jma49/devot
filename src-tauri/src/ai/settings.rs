//! Kept on this device only (`<app data>/ai-settings.json`): never synced, never in backups. Keys are in `keychain`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Url;

use super::provider::{MAX_MODEL_CHARS, ProviderId, provider};

pub const FILE: &str = "ai-settings.json";
const MAX_ENDPOINT_LEN: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderSettings {
    pub endpoint: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSettings {
    pub active: ProviderId,
    /// Next edit suggestions on a pause in typing; off unless the user turns it on.
    #[serde(default, rename = "suggestOnIdle")]
    pub suggest_on_idle: bool,
    pub anthropic: ProviderSettings,
    pub openai: ProviderSettings,
}

fn default_for(id: ProviderId) -> ProviderSettings {
    let p = provider(id);
    ProviderSettings {
        endpoint: p.default_endpoint().to_string(),
        model: p.default_model().unwrap_or_default().to_string(),
    }
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            active: ProviderId::Anthropic,
            suggest_on_idle: false,
            anthropic: default_for(ProviderId::Anthropic),
            openai: default_for(ProviderId::Openai),
        }
    }
}

impl AiSettings {
    pub fn of(&self, id: ProviderId) -> &ProviderSettings {
        match id {
            ProviderId::Anthropic => &self.anthropic,
            ProviderId::Openai => &self.openai,
        }
    }

    fn of_mut(&mut self, id: ProviderId) -> &mut ProviderSettings {
        match id {
            ProviderId::Anthropic => &mut self.anthropic,
            ProviderId::Openai => &mut self.openai,
        }
    }

    pub fn validated(mut self) -> Result<Self, &'static str> {
        for id in ProviderId::ALL {
            let entry = self.of_mut(id);
            entry.endpoint = if entry.endpoint.trim().is_empty() {
                provider(id).default_endpoint().to_string()
            } else {
                clean_endpoint(&entry.endpoint)?
            };
            entry.model = clean_model(&entry.model)?;
            if entry.model.is_empty() {
                entry.model = provider(id).default_model().unwrap_or_default().to_string();
            }
        }
        Ok(self)
    }

    fn lenient(value: &Value) -> Self {
        let mut settings = Self::default();
        if let Some(active) = value
            .get("active")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
        {
            settings.active = active;
        }
        if let Some(on) = value.get("suggestOnIdle").and_then(Value::as_bool) {
            settings.suggest_on_idle = on;
        }
        for id in ProviderId::ALL {
            let stored = value.get(id.as_str());
            let text = |key: &str| stored.and_then(|s| s.get(key)).and_then(Value::as_str);
            let entry = settings.of_mut(id);
            if let Some(endpoint) = text("endpoint").and_then(|e| clean_endpoint(e).ok()) {
                entry.endpoint = endpoint;
            }
            if let Some(model) = text("model").and_then(|m| clean_model(m).ok())
                && (!model.is_empty() || provider(id).default_model().is_none())
            {
                entry.model = model;
            }
        }
        settings
    }
}

fn loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// https, or http to this Mac only (a model server running here). The key goes in a header, so it never travels over plain http to another machine.
pub fn clean_endpoint(endpoint: &str) -> Result<String, &'static str> {
    let endpoint = endpoint.trim();
    if endpoint.len() > MAX_ENDPOINT_LEN {
        return Err("E_AI_ENDPOINT_INVALID");
    }
    let url = Url::parse(endpoint).map_err(|_| "E_AI_ENDPOINT_INVALID")?;
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback(&url));
    if !scheme_ok
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("E_AI_ENDPOINT_INVALID");
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// A model name as providers write them (`claude-sonnet-5-5`, `llama3.2:3b`, `vendor/model@2`); empty means the default.
pub fn clean_model(model: &str) -> Result<String, &'static str> {
    let model = model.trim();
    let allowed = |c: char| c.is_ascii_alphanumeric() || "._:/@+-".contains(c);
    if model.chars().count() > MAX_MODEL_CHARS || !model.chars().all(allowed) {
        return Err("E_AI_MODEL_INVALID");
    }
    Ok(model.to_string())
}

pub struct SettingsStore {
    path: PathBuf,
    write: Mutex<()>,
}

impl SettingsStore {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
            write: Mutex::new(()),
        }
    }

    pub fn get(&self) -> AiSettings {
        match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => AiSettings::lenient(&value),
                Err(_) => {
                    log::warn!("W_AI_SETTINGS_UNREADABLE");
                    if crate::atomic_file::keep_damaged(&self.path, &bytes).is_err() {
                        log::warn!("W_AI_SETTINGS_COPY_FAILED");
                    }
                    AiSettings::default()
                }
            },
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("W_AI_SETTINGS_READ_FAILED");
                }
                AiSettings::default()
            }
        }
    }

    pub fn set(&self, settings: AiSettings) -> Result<AiSettings, &'static str> {
        let settings = settings.validated()?;
        let _writing = self
            .write
            .lock()
            .map_err(|_| "E_AI_SETTINGS_WRITE_FAILED")?;
        let json =
            serde_json::to_vec_pretty(&settings).map_err(|_| "E_AI_SETTINGS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_AI_SETTINGS_WRITE_FAILED")?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_file::DAMAGED_SUFFIX;

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(&dir.path().join(FILE));
        (dir, store)
    }

    #[test]
    fn starts_with_claude_active_and_its_defaults() {
        let (_dir, store) = store();
        let settings = store.get();
        assert_eq!(settings.active, ProviderId::Anthropic);
        assert_eq!(settings.anthropic.endpoint, "https://api.anthropic.com");
        assert_eq!(settings.anthropic.model, "claude-sonnet-5-5");
        assert_eq!(settings.openai.endpoint, "https://api.openai.com/v1");
        assert_eq!(settings.openai.model, "");
    }

    #[test]
    fn a_change_is_stored_and_read_back_normalised() {
        let (dir, store) = store();
        let mut settings = store.get();
        settings.active = ProviderId::Openai;
        settings.openai.endpoint = " http://localhost:11434/v1/ ".into();
        settings.openai.model = "llama3.2:3b".into();
        settings.anthropic.model = String::new();
        let stored = store.set(settings).unwrap();
        assert_eq!(stored.openai.endpoint, "http://localhost:11434/v1");
        assert_eq!(stored.anthropic.model, "claude-sonnet-5-5");
        assert_eq!(store.get(), stored);
        let text = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(text.contains("\"active\": \"openai\""), "{text}");
    }

    #[test]
    fn suggestions_on_a_pause_are_off_until_turned_on() {
        let (dir, store) = store();
        assert!(!store.get().suggest_on_idle);
        let mut settings = store.get();
        settings.suggest_on_idle = true;
        assert!(store.set(settings).unwrap().suggest_on_idle);
        assert!(store.get().suggest_on_idle);
        let text = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(text.contains("\"suggestOnIdle\": true"), "{text}");
        std::fs::write(dir.path().join(FILE), r#"{"suggestOnIdle":"yes"}"#).unwrap();
        assert!(!store.get().suggest_on_idle);
    }

    #[test]
    fn a_bad_value_refuses_the_whole_change() {
        let (_dir, store) = store();
        let before = store.get();
        type Edit = fn(&mut AiSettings);
        let cases: [(&str, Edit); 6] = [
            ("E_AI_ENDPOINT_INVALID", |s| {
                s.openai.endpoint = "http://example.com/v1".into()
            }),
            ("E_AI_ENDPOINT_INVALID", |s| {
                s.openai.endpoint = "ftp://localhost".into()
            }),
            ("E_AI_ENDPOINT_INVALID", |s| {
                s.anthropic.endpoint = "https://user:pw@api.anthropic.com".into();
            }),
            ("E_AI_ENDPOINT_INVALID", |s| {
                s.anthropic.endpoint = "https://x.test/?k=1".into()
            }),
            ("E_AI_MODEL_INVALID", |s| {
                s.openai.model = "two words".into()
            }),
            ("E_AI_MODEL_INVALID", |s| {
                s.openai.model = "m".repeat(MAX_MODEL_CHARS + 1)
            }),
        ];
        for (code, edit) in cases {
            let mut settings = before.clone();
            edit(&mut settings);
            assert_eq!(store.set(settings).unwrap_err(), code);
        }
        assert_eq!(store.get(), before);
    }

    #[test]
    fn http_is_allowed_to_this_mac_only() {
        for ok in [
            "http://localhost:8080",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:1234",
            "https://gateway.example.com/v1",
        ] {
            assert!(clean_endpoint(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://192.168.1.5/v1",
            "http://localhost.evil.test",
            "not a url",
            "",
        ] {
            assert_eq!(clean_endpoint(bad), Err("E_AI_ENDPOINT_INVALID"), "{bad}");
        }
    }

    #[test]
    fn reading_keeps_good_values_and_defaults_the_rest() {
        let (dir, store) = store();
        std::fs::write(
            dir.path().join(FILE),
            r#"{"active":"openai","anthropic":{"endpoint":"http://evil.test","model":"claude-opus"},"openai":{"model":"gpt-x"},"extra":1}"#,
        )
        .unwrap();
        let settings = store.get();
        assert_eq!(settings.active, ProviderId::Openai);
        assert_eq!(settings.anthropic.endpoint, "https://api.anthropic.com");
        assert_eq!(settings.anthropic.model, "claude-opus");
        assert_eq!(settings.openai.model, "gpt-x");
    }

    #[test]
    fn an_unreadable_file_is_kept_and_defaults_apply() {
        let (dir, store) = store();
        std::fs::write(dir.path().join(FILE), b"{ nope").unwrap();
        assert_eq!(store.get(), AiSettings::default());
        let kept = dir.path().join(format!("{FILE}{DAMAGED_SUFFIX}"));
        assert_eq!(std::fs::read(kept).unwrap(), b"{ nope");
    }
}
