//! MCP access (ADR 0012): whether the `devot --cli mcp` bridge may reach this Devot, what it may do,
//! and whether it may start Devot in the background. Kept on this device (`<app data>/mcp-access.json`),
//! apart from the local HTTP API's settings: the bridge has a token of its own, so turning MCP on
//! never turns on the HTTP API or lets its token in.
//! The bridge reads this file itself before it starts anything; it holds nothing secret.
//! Background starts are kept under `backgroundStartAllowed`, which only the owner's own switch writes:
//! the `backgroundStart` key of earlier versions held a default that was on, so it is ignored.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::token::Scope;

pub const FILE: &str = "mcp-access.json";
const BACKGROUND_START_KEY: &str = "backgroundStartAllowed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAccess {
    pub enabled: bool,
    pub scope: Scope,
    pub background_start: bool,
}

impl Default for McpAccess {
    /// Off until the user connects a client or turns it on. Notebooks stay closed to AI on their own
    /// switch, and what a connected client may do there is what MCP has always let it do. Devot never
    /// starts in the background until the owner turns that on.
    fn default() -> Self {
        Self {
            enabled: false,
            scope: Scope::ReadWrite,
            background_start: false,
        }
    }
}

impl McpAccess {
    /// On only when the file says exactly so, background starts too.
    fn lenient(value: &Value) -> Self {
        let defaults = Self::default();
        Self {
            enabled: value.get("enabled").and_then(Value::as_bool) == Some(true),
            scope: value
                .get("scope")
                .and_then(|scope| serde_json::from_value(scope.clone()).ok())
                .unwrap_or(defaults.scope),
            background_start: value.get(BACKGROUND_START_KEY).and_then(Value::as_bool)
                == Some(true),
        }
    }

    /// As the file holds it now; anything unreadable leaves MCP off.
    pub fn read(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .map_or_else(Self::default, |value| Self::lenient(&value))
    }
}

pub struct McpAccessStore {
    path: PathBuf,
    write: Mutex<()>,
}

impl McpAccessStore {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
            write: Mutex::new(()),
        }
    }

    pub fn get(&self) -> McpAccess {
        McpAccess::read(&self.path)
    }

    pub fn set(&self, access: McpAccess) -> Result<McpAccess, &'static str> {
        let _writing = self.write.lock().map_err(|_| "E_MCP_ACCESS_WRITE_FAILED")?;
        let stored = serde_json::json!({
            "enabled": access.enabled,
            "scope": access.scope,
            BACKGROUND_START_KEY: access.background_start,
        });
        let json = serde_json::to_vec_pretty(&stored).map_err(|_| "E_MCP_ACCESS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_MCP_ACCESS_WRITE_FAILED")?;
        Ok(access)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, McpAccessStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = McpAccessStore::new(&dir.path().join(FILE));
        (dir, store)
    }

    #[test]
    fn starts_off_with_background_starts_off() {
        let (_dir, store) = store();
        assert_eq!(store.get(), McpAccess::default());
        assert!(!store.get().enabled);
        assert!(!store.get().background_start);
    }

    #[test]
    fn an_earlier_versions_background_start_is_not_taken_as_the_owners_choice() {
        let (dir, store) = store();
        std::fs::write(
            dir.path().join(FILE),
            r#"{"enabled":true,"scope":"readWrite","backgroundStart":true}"#,
        )
        .unwrap();
        assert!(store.get().enabled);
        assert!(!store.get().background_start);
    }

    #[test]
    fn a_background_start_the_owner_turned_on_is_kept() {
        let (dir, store) = store();
        let wanted = McpAccess {
            enabled: true,
            scope: Scope::ReadWrite,
            background_start: true,
        };
        store.set(wanted).unwrap();
        let file: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(file["backgroundStartAllowed"], Value::Bool(true));
        assert_eq!(file.get("backgroundStart"), None);
        assert_eq!(store.get(), wanted);
    }

    #[test]
    fn a_change_is_stored_and_read_back() {
        let (_dir, store) = store();
        let wanted = McpAccess {
            enabled: true,
            scope: Scope::Read,
            background_start: false,
        };
        assert_eq!(store.set(wanted), Ok(wanted));
        assert_eq!(store.get(), wanted);
    }

    #[test]
    fn reading_stays_off_unless_the_file_says_exactly_otherwise() {
        let (dir, store) = store();
        std::fs::write(
            dir.path().join(FILE),
            r#"{"enabled":"yes","scope":"admin","backgroundStartAllowed":1,"extra":1}"#,
        )
        .unwrap();
        assert_eq!(store.get(), McpAccess::default());
        std::fs::write(dir.path().join(FILE), b"{ nope").unwrap();
        assert_eq!(store.get(), McpAccess::default());
        std::fs::write(
            dir.path().join(FILE),
            r#"{"enabled":true,"scope":"read","backgroundStartAllowed":true}"#,
        )
        .unwrap();
        assert_eq!(
            store.get(),
            McpAccess {
                enabled: true,
                scope: Scope::Read,
                background_start: true
            }
        );
    }

    #[test]
    fn holds_no_token() {
        let (dir, store) = store();
        store
            .set(McpAccess {
                enabled: true,
                ..McpAccess::default()
            })
            .unwrap();
        let text = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(!text.contains("dvt_") && !text.to_lowercase().contains("token"));
    }
}
