//! Kept on this device only (`<app data>/http-api.json`): never synced, never in backups. The token
//! is in the keychain (`token`); the file says what it may do.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::token::Scope;

pub const FILE: &str = "http-api.json";
pub const DEFAULT_PORT: u16 = 27_484;
/// Below are the ports only root may listen on.
pub const MIN_PORT: u16 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpApiSettings {
    pub enabled: bool,
    pub port: u16,
    pub scope: Scope,
}

impl Default for HttpApiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            scope: Scope::Read,
        }
    }
}

pub fn check_port(port: u16) -> Result<u16, &'static str> {
    if port < MIN_PORT {
        return Err("E_HTTP_API_PORT_INVALID");
    }
    Ok(port)
}

impl HttpApiSettings {
    /// Good values as stored, defaults for the rest; on only when the file says exactly so.
    fn lenient(value: &Value) -> Self {
        let mut settings = Self {
            enabled: value.get("enabled").and_then(Value::as_bool) == Some(true),
            ..Self::default()
        };
        if let Some(port) = value
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
            .and_then(|p| check_port(p).ok())
        {
            settings.port = port;
        }
        if let Some(scope) = value
            .get("scope")
            .and_then(|s| serde_json::from_value(s.clone()).ok())
        {
            settings.scope = scope;
        }
        settings
    }
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

    pub fn get(&self) -> HttpApiSettings {
        match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => HttpApiSettings::lenient(&value),
                Err(_) => {
                    log::warn!("W_HTTP_API_SETTINGS_UNREADABLE");
                    if crate::atomic_file::keep_damaged(&self.path, &bytes).is_err() {
                        log::warn!("W_HTTP_API_SETTINGS_COPY_FAILED");
                    }
                    HttpApiSettings::default()
                }
            },
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("W_HTTP_API_SETTINGS_READ_FAILED");
                }
                HttpApiSettings::default()
            }
        }
    }

    pub fn set(&self, settings: HttpApiSettings) -> Result<HttpApiSettings, &'static str> {
        check_port(settings.port)?;
        let _writing = self
            .write
            .lock()
            .map_err(|_| "E_HTTP_API_SETTINGS_WRITE_FAILED")?;
        let json =
            serde_json::to_vec_pretty(&settings).map_err(|_| "E_HTTP_API_SETTINGS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_HTTP_API_SETTINGS_WRITE_FAILED")?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(&dir.path().join(FILE));
        (dir, store)
    }

    #[test]
    fn starts_off_on_its_default_port_with_a_read_only_token() {
        let (_dir, store) = store();
        assert_eq!(
            store.get(),
            HttpApiSettings {
                enabled: false,
                port: DEFAULT_PORT,
                scope: Scope::Read
            }
        );
    }

    #[test]
    fn a_change_is_stored_and_read_back() {
        let (_dir, store) = store();
        let wanted = HttpApiSettings {
            enabled: true,
            port: 40_000,
            scope: Scope::ReadWrite,
        };
        assert_eq!(store.set(wanted), Ok(wanted));
        assert_eq!(store.get(), wanted);
    }

    #[test]
    fn refuses_a_port_below_1024() {
        let (_dir, store) = store();
        for port in [0, 80, 1023] {
            let change = HttpApiSettings {
                port,
                ..HttpApiSettings::default()
            };
            assert_eq!(store.set(change), Err("E_HTTP_API_PORT_INVALID"));
        }
        assert_eq!(store.get(), HttpApiSettings::default());
    }

    #[test]
    fn reading_keeps_good_values_and_stays_off_unless_on_exactly() {
        let (dir, store) = store();
        std::fs::write(
            dir.path().join(FILE),
            r#"{"enabled":"yes","port":80,"scope":"readWrite","extra":1}"#,
        )
        .unwrap();
        assert_eq!(
            store.get(),
            HttpApiSettings {
                enabled: false,
                port: DEFAULT_PORT,
                scope: Scope::ReadWrite
            }
        );
        std::fs::write(dir.path().join(FILE), b"{ nope").unwrap();
        assert_eq!(store.get(), HttpApiSettings::default());
    }
}
