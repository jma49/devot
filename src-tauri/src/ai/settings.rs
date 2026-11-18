//! Kept on this device only (`<app data>/ai-settings.json`): never synced, never in backups. Keys are in `keychain`.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Url;

use super::provider::{MAX_MODEL_CHARS, ProviderId, provider};
use crate::settings_file::{Codes, SettingsFile};

pub const FILE: &str = "ai-settings.json";
const MAX_ENDPOINT_LEN: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderSettings {
    pub endpoint: String,
    pub model: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CliProviderSettings {
    pub model: String,
    /// Tracks whether an external payload explicitly supplied this object (`false` preserves stored
    /// desktop CLI models when iOS omits desktop-only fields).
    #[serde(skip)]
    pub(crate) provided: bool,
}

impl PartialEq for CliProviderSettings {
    fn eq(&self, other: &Self) -> bool {
        self.model == other.model
    }
}

impl Eq for CliProviderSettings {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireCliSettings {
    #[serde(default)]
    model: String,
}

impl<'de> Deserialize<'de> for CliProviderSettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = WireCliSettings::deserialize(deserializer)?;
        Ok(Self {
            model: wire.model,
            provided: true,
        })
    }
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
    #[serde(default, rename = "claudeCli")]
    pub claude_cli: CliProviderSettings,
    #[serde(default, rename = "codexCli")]
    pub codex_cli: CliProviderSettings,
}

pub struct StoredSettings {
    pub settings: AiSettings,
    /// Whether `ai-settings.json` explicitly recorded an `active` provider.
    pub explicit_active: bool,
}

fn default_for(id: ProviderId) -> ProviderSettings {
    let Some(p) = provider(id) else {
        return ProviderSettings {
            endpoint: String::new(),
            model: String::new(),
        };
    };
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
            claude_cli: CliProviderSettings::default(),
            codex_cli: CliProviderSettings::default(),
        }
    }
}

impl AiSettings {
    pub fn of(&self, id: ProviderId) -> Option<&ProviderSettings> {
        match id {
            ProviderId::Anthropic => Some(&self.anthropic),
            ProviderId::Openai => Some(&self.openai),
            ProviderId::ClaudeCli | ProviderId::CodexCli => None,
        }
    }

    fn of_mut(&mut self, id: ProviderId) -> Option<&mut ProviderSettings> {
        match id {
            ProviderId::Anthropic => Some(&mut self.anthropic),
            ProviderId::Openai => Some(&mut self.openai),
            ProviderId::ClaudeCli | ProviderId::CodexCli => None,
        }
    }

    pub fn cli_model(&self, id: ProviderId) -> &str {
        match id {
            ProviderId::ClaudeCli => &self.claude_cli.model,
            ProviderId::CodexCli => &self.codex_cli.model,
            ProviderId::Anthropic | ProviderId::Openai => "",
        }
    }

    pub fn validated(mut self) -> Result<Self, &'static str> {
        for id in ProviderId::HTTP {
            let Some(p) = provider(id) else { continue };
            let Some(entry) = self.of_mut(id) else {
                continue;
            };
            entry.endpoint = if entry.endpoint.trim().is_empty() {
                p.default_endpoint().to_string()
            } else {
                clean_endpoint(&entry.endpoint)?
            };
            entry.model = clean_model(&entry.model)?;
            if entry.model.is_empty() {
                entry.model = p.default_model().unwrap_or_default().to_string();
            }
        }
        self.claude_cli.model = clean_model(&self.claude_cli.model)?;
        self.codex_cli.model = clean_model(&self.codex_cli.model)?;
        Ok(self)
    }

    fn lenient(value: &Value) -> StoredSettings {
        let mut settings = Self::default();
        let mut explicit_active = false;
        if let Some(active) = value
            .get("active")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
        {
            settings.active = active;
            explicit_active = true;
        }
        if let Some(on) = value.get("suggestOnIdle").and_then(Value::as_bool) {
            settings.suggest_on_idle = on;
        }
        for id in ProviderId::HTTP {
            let Some(p) = provider(id) else { continue };
            let stored = value.get(id.as_str());
            let text = |key: &str| stored.and_then(|s| s.get(key)).and_then(Value::as_str);
            let Some(entry) = settings.of_mut(id) else {
                continue;
            };
            if let Some(endpoint) = text("endpoint").and_then(|e| clean_endpoint(e).ok()) {
                entry.endpoint = endpoint;
            }
            if let Some(model) = text("model").and_then(|m| clean_model(m).ok())
                && (!model.is_empty() || p.default_model().is_none())
            {
                entry.model = model;
            }
        }
        for (key, target) in [
            ("claudeCli", &mut settings.claude_cli),
            ("codexCli", &mut settings.codex_cli),
        ] {
            if let Some(stored) = value.get(key) {
                target.provided = true;
                if let Some(model) = stored
                    .get("model")
                    .and_then(Value::as_str)
                    .and_then(|m| clean_model(m).ok())
                {
                    target.model = model;
                }
            }
        }
        StoredSettings {
            settings,
            explicit_active,
        }
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

pub fn same_origin(a: &str, b: &str) -> bool {
    match (Url::parse(a), Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

/// A model name as providers write them (`claude-sonnet-5-5`, `llama3.2:3b`, `vendor/model@2`); empty means the default.
/// Refuses a leading `-` so a model override can never be interpreted as a CLI flag.
pub fn clean_model(model: &str) -> Result<String, &'static str> {
    let model = model.trim();
    let allowed = |c: char| c.is_ascii_alphanumeric() || "._:/@+-".contains(c);
    if model.starts_with('-')
        || model.chars().count() > MAX_MODEL_CHARS
        || !model.chars().all(allowed)
    {
        return Err("E_AI_MODEL_INVALID");
    }
    Ok(model.to_string())
}

const CODES: Codes = Codes {
    unreadable: "W_AI_SETTINGS_UNREADABLE",
    copy_failed: "W_AI_SETTINGS_COPY_FAILED",
    read_failed: "W_AI_SETTINGS_READ_FAILED",
    write_failed: "E_AI_SETTINGS_WRITE_FAILED",
};

pub struct SettingsStore {
    file: SettingsFile,
    write: Mutex<()>,
}

impl SettingsStore {
    pub fn new(path: &Path) -> Self {
        Self {
            file: SettingsFile::new(path, &CODES),
            write: Mutex::new(()),
        }
    }

    fn read(&self) -> Option<StoredSettings> {
        self.file
            .read_as(|map| Some(AiSettings::lenient(&Value::Object(map))))
    }

    pub fn get_stored(&self) -> StoredSettings {
        self.read().unwrap_or_else(|| StoredSettings {
            settings: AiSettings::default(),
            explicit_active: false,
        })
    }

    /// The defaults while the file cannot be read.
    pub fn get(&self) -> AiSettings {
        self.get_stored().settings
    }

    /// Refused while the file cannot be read, so a change made from the defaults shown meanwhile
    /// never replaces what it holds.
    pub fn set(&self, settings: AiSettings) -> Result<AiSettings, &'static str> {
        let mut settings = settings.validated()?;
        let _writing = self
            .write
            .lock()
            .map_err(|_| "E_AI_SETTINGS_WRITE_FAILED")?;
        let Some(existing) = self.read() else {
            return Err("E_AI_SETTINGS_READ_FAILED");
        };
        if !settings.claude_cli.provided && settings.claude_cli.model.is_empty() {
            settings.claude_cli.model = existing.settings.claude_cli.model;
        }
        if !settings.codex_cli.provided && settings.codex_cli.model.is_empty() {
            settings.codex_cli.model = existing.settings.codex_cli.model;
        }
        self.file.write(&settings)?;
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
    fn an_origin_is_its_scheme_host_and_port() {
        let anthropic = "https://api.anthropic.com";
        assert!(same_origin(anthropic, "https://api.anthropic.com:443/v1"));
        for other in [
            "http://api.anthropic.com",
            "https://api.anthropic.com:8443",
            "https://api.anthropic.com.evil.test",
            "https://gateway.example.com",
            "not a url",
        ] {
            assert!(!same_origin(anthropic, other), "{other}");
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

    #[test]
    fn a_file_that_is_not_an_object_is_kept_aside() {
        let (dir, store) = store();
        std::fs::write(dir.path().join(FILE), b"[1]").unwrap();
        assert_eq!(store.get(), AiSettings::default());
        let kept = dir.path().join(format!("{FILE}{DAMAGED_SUFFIX}"));
        assert_eq!(std::fs::read(kept).unwrap(), b"[1]");
    }

    #[test]
    fn a_file_that_cannot_be_read_is_never_written_over() {
        let (dir, store) = store();
        std::fs::create_dir(dir.path().join(FILE)).unwrap();
        assert_eq!(store.get(), AiSettings::default());
        assert_eq!(
            store.set(AiSettings::default()),
            Err("E_AI_SETTINGS_READ_FAILED")
        );
        assert!(dir.path().join(FILE).is_dir());
    }

    #[test]
    fn cli_model_overrides_reject_leading_hyphens_and_preserve_when_ios_omits_cli_fields() {
        let (_dir, store) = store();
        assert!(!store.get_stored().explicit_active);
        let mut settings = store.get();
        settings.active = ProviderId::ClaudeCli;
        settings.claude_cli.model = "opus".into();
        settings.codex_cli.model = "gpt-5.4".into();
        let saved = store.set(settings).unwrap();
        assert_eq!(saved.claude_cli.model, "opus");
        assert_eq!(saved.codex_cli.model, "gpt-5.4");
        assert!(store.get_stored().explicit_active);

        let mut bad = store.get();
        bad.claude_cli.model = "--dangerously-skip-permissions".into();
        assert_eq!(store.set(bad).unwrap_err(), "E_AI_MODEL_INVALID");

        // An iOS payload omits `claudeCli` and `codexCli`: deserialization defaults them and `set`
        // keeps the previously stored desktop overrides rather than wiping them.
        let ios_payload: AiSettings = serde_json::from_str(
            r#"{
                "active": "openai",
                "suggestOnIdle": true,
                "anthropic": {"endpoint": "https://api.anthropic.com", "model": "claude-sonnet-5-5"},
                "openai": {"endpoint": "https://api.openai.com/v1", "model": "gpt-4o"}
            }"#,
        )
        .unwrap();
        assert!(!ios_payload.claude_cli.provided);
        let after_ios = store.set(ios_payload).unwrap();
        assert_eq!(after_ios.active, ProviderId::Openai);
        assert_eq!(after_ios.claude_cli.model, "opus");
        assert_eq!(after_ios.codex_cli.model, "gpt-5.4");

        // Explicitly sending `claudeCli: { model: "" }` clears the override.
        let cleared_payload: AiSettings = serde_json::from_str(
            r#"{
                "active": "claudeCli",
                "suggestOnIdle": false,
                "anthropic": {"endpoint": "https://api.anthropic.com", "model": ""},
                "openai": {"endpoint": "https://api.openai.com/v1", "model": ""},
                "claudeCli": {"model": ""},
                "codexCli": {"model": ""}
            }"#,
        )
        .unwrap();
        assert!(cleared_payload.claude_cli.provided);
        let after_clear = store.set(cleared_payload).unwrap();
        assert_eq!(after_clear.claude_cli.model, "");
        assert_eq!(after_clear.codex_cli.model, "");
    }
}
