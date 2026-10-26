//! Sync's settings, kept on this device only (`<app data>/sync-settings.json`): the relay's URL and
//! whether sync is on. The device token is in the keychain (`DeviceCredentials`), never here.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::client::RelayUrl;
use super::{SecretStore, SyncError};

pub(crate) const FILE: &str = "sync-settings.json";
const DEVICE_ACCOUNT: &str = "device";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncSettings {
    /// '' until one is set.
    #[serde(default)]
    pub relay_url: String,
    #[serde(default)]
    pub enabled: bool,
    /// The vault whose recovery key this device has shown (or never makes, having joined it), so
    /// the key is shown once. A vault ID, which is no secret.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub recovery_shown: String,
}

pub(crate) struct SettingsStore {
    path: PathBuf,
    write: Mutex<()>,
}

impl SettingsStore {
    pub(crate) fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
            write: Mutex::new(()),
        }
    }

    pub(crate) fn get(&self) -> SyncSettings {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<SyncSettings>(&bytes)
                .ok()
                .map(|settings| SyncSettings {
                    relay_url: RelayUrl::parse(&settings.relay_url)
                        .map(|url| url.as_str().to_string())
                        .unwrap_or_default(),
                    ..settings
                })
                .unwrap_or_else(|| {
                    log::warn!("W_SYNC_SETTINGS_UNREADABLE");
                    if crate::atomic_file::keep_damaged(&self.path, &bytes).is_err() {
                        log::warn!("W_SYNC_SETTINGS_COPY_FAILED");
                    }
                    SyncSettings::default()
                }),
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("W_SYNC_SETTINGS_READ_FAILED");
                }
                SyncSettings::default()
            }
        }
    }

    pub(crate) fn set(&self, settings: &SyncSettings) -> Result<(), &'static str> {
        let _writing = self
            .write
            .lock()
            .map_err(|_| "E_SYNC_SETTINGS_WRITE_FAILED")?;
        let json =
            serde_json::to_vec_pretty(settings).map_err(|_| "E_SYNC_SETTINGS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_SYNC_SETTINGS_WRITE_FAILED")
    }
}

/// What the relay gave this device when it enrolled: its device ID and token, for one relay and
/// one vault. Kept in the keychain beside the vault; `Debug` shows the device ID only.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeviceCredentials {
    pub relay: String,
    pub vault: String,
    pub device: String,
    pub token: String,
}

impl std::fmt::Debug for DeviceCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceCredentials")
            .field("device", &self.device)
            .finish_non_exhaustive()
    }
}

impl DeviceCredentials {
    pub(crate) fn load(store: &dyn SecretStore) -> Result<Option<Self>, SyncError> {
        Ok(store
            .read(DEVICE_ACCOUNT)?
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
    }

    pub(crate) fn save(&self, store: &dyn SecretStore) -> Result<(), SyncError> {
        let bytes = Zeroizing::new(serde_json::to_vec(self).map_err(|_| SyncError::VaultCorrupt)?);
        store.remove(DEVICE_ACCOUNT)?;
        if store.add(DEVICE_ACCOUNT, &bytes)? {
            Ok(())
        } else {
            Err(SyncError::VaultExists)
        }
    }

    pub(crate) fn forget(store: &dyn SecretStore) -> Result<(), SyncError> {
        store.remove(DEVICE_ACCOUNT).map(|_| ())
    }

    pub(crate) fn fits(&self, relay: &str, vault: &str) -> bool {
        self.relay == relay && self.vault == vault
    }
}
