//! Sync's settings, kept on this device only (`<app data>/sync-settings.json`): the relay's URL,
//! whether sync is on, and for a vault on iCloud what this device keeps of it. The device token is
//! in the keychain (`DeviceCredentials`), never here.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::client::RelayUrl;
use super::cloudkit::ICloudState;
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
    /// The vault this names syncs through iCloud; any other vault, through the relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icloud: Option<ICloudState>,
    /// The Apple ID's vault this device was asked to join and declined, so it is asked once.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub icloud_declined: String,
    /// The vault this device started moving from its relay to iCloud and has not switched yet:
    /// recorded before the moved marker is left, so a device that quits in between finishes the
    /// move when its engine finds that marker.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub moving: String,
}

impl SyncSettings {
    /// What this device keeps of `vault` on iCloud, when that vault is on iCloud.
    pub(crate) fn icloud_for(&self, vault: &str) -> Option<&ICloudState> {
        self.icloud.as_ref().filter(|state| state.vault == vault)
    }
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

    /// The folder the settings file is in: the app's data folder.
    pub(crate) fn dir(&self) -> PathBuf {
        self.path
            .parent()
            .map_or_else(PathBuf::new, Path::to_path_buf)
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
        store.replace(DEVICE_ACCOUNT, &bytes)
    }

    pub(crate) fn forget(store: &dyn SecretStore) -> Result<(), SyncError> {
        store.remove(DEVICE_ACCOUNT).map(|_| ())
    }

    pub(crate) fn fits(&self, relay: &str, vault: &str) -> bool {
        self.relay == relay && self.vault == vault
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_file_written_before_moves_were_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        std::fs::write(
            &path,
            br#"{"relayUrl":"https://relay.example","enabled":true,"recoveryShown":"v1"}"#,
        )
        .unwrap();
        let settings = SettingsStore::new(&path).get();
        assert_eq!(settings.relay_url, "https://relay.example");
        assert!(settings.enabled);
        assert_eq!(settings.recovery_shown, "v1");
        assert_eq!(settings.moving, "");
    }

    #[test]
    fn writes_a_started_move_only_while_there_is_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        let store = SettingsStore::new(&path);
        let mut settings = SyncSettings {
            moving: "v1".into(),
            ..SyncSettings::default()
        };
        store.set(&settings).unwrap();
        assert_eq!(store.get().moving, "v1");
        settings.moving.clear();
        store.set(&settings).unwrap();
        // A file with no move in progress reads in a build from before moves were recorded.
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written.get("moving"), None);
    }
}
