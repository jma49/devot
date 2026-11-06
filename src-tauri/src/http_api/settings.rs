//! Kept on this device only (`<app data>/http-api.json`): never synced, never in backups. The token
//! is in the keychain (`token`); the file says what it may do.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::token::Scope;
use crate::settings_file::{Codes, SettingsFile};

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

const CODES: Codes = Codes {
    unreadable: "W_HTTP_API_SETTINGS_UNREADABLE",
    copy_failed: "W_HTTP_API_SETTINGS_COPY_FAILED",
    read_failed: "W_HTTP_API_SETTINGS_READ_FAILED",
    write_failed: "E_HTTP_API_SETTINGS_WRITE_FAILED",
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

    fn read(&self) -> Option<HttpApiSettings> {
        self.file
            .read_as(|map| Some(HttpApiSettings::lenient(&Value::Object(map))))
    }

    /// The defaults (off) while the file cannot be read.
    pub fn get(&self) -> HttpApiSettings {
        self.read().unwrap_or_default()
    }

    /// Refused while the file cannot be read, so a change made from the defaults shown meanwhile
    /// never replaces what it holds.
    pub fn set(&self, settings: HttpApiSettings) -> Result<HttpApiSettings, &'static str> {
        check_port(settings.port)?;
        let _writing = self
            .write
            .lock()
            .map_err(|_| "E_HTTP_API_SETTINGS_WRITE_FAILED")?;
        if self.read().is_none() {
            return Err("E_HTTP_API_SETTINGS_READ_FAILED");
        }
        self.file.write(&settings)?;
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

    #[test]
    fn a_file_that_cannot_be_read_reads_as_off_and_is_never_written_over() {
        let (dir, store) = store();
        std::fs::create_dir(dir.path().join(FILE)).unwrap();
        assert_eq!(store.get(), HttpApiSettings::default());
        let on = HttpApiSettings {
            enabled: true,
            ..HttpApiSettings::default()
        };
        assert_eq!(store.set(on), Err("E_HTTP_API_SETTINGS_READ_FAILED"));
        assert!(dir.path().join(FILE).is_dir());
    }

    #[test]
    fn a_file_that_is_not_an_object_reads_as_off() {
        let (dir, store) = store();
        std::fs::write(dir.path().join(FILE), b"true").unwrap();
        assert_eq!(store.get(), HttpApiSettings::default());
        assert_eq!(
            store.set(HttpApiSettings::default()),
            Ok(HttpApiSettings::default())
        );
    }
}
