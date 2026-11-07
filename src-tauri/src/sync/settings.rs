//! Sync's settings, kept on this device only (`<app data>/sync-settings.json`): the relay's URL,
//! whether sync is on, and for a vault on iCloud what this device keeps of it. The device token is
//! in the keychain (`DeviceCredentials`), never here.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use super::client::RelayUrl;
use super::cloudkit::ICloudState;
use super::names;
use super::{SecretStore, SyncError};
use crate::settings_file::{Codes, SettingsFile};

pub(crate) const FILE: &str = "sync-settings.json";
const DEVICE_ACCOUNT: &str = "device";
/// The successor's token of a rotation that has not switched yet.
const NEXT_DEVICE_ACCOUNT: &str = "device-next";
/// The rotating device's tokens for the vaults it retired, which still list those vaults' devices.
const RETIRED_DEVICE_ACCOUNT: &str = "device-retired";

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
    /// The relay's other devices when this device moved its vault to iCloud, until each is seen
    /// there: Settings names them, so the owner knows which still have to follow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unseen: Option<Unseen>,
    /// A rotation this device started and has not switched yet (docs/adr/0017-sync-key-rotation.md).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotating: Option<Rotation>,
    /// A vault this device found retired, with its successor: the one vault a join may put in its
    /// place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotated: Option<Rotation>,
    /// How many times this device left a relay vault. It marks the epoch the engine sees, so a
    /// join after a leave uploads the whole library, even into the vault left.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub leaves: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Unseen {
    pub vault: String,
    pub devices: Vec<RelayDevice>,
}

/// A device as the relay listed it: its relay device ID, its name and the time it was added.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelayDevice {
    pub id: String,
    pub label: String,
    pub created: i64,
}

/// A vault and the one that succeeds it, by ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Rotation {
    pub from: String,
    pub to: String,
}

impl SyncSettings {
    /// Forgets a move to iCloud this device started and the relay devices kept for it.
    pub(crate) fn call_off_move(&mut self) {
        if !self.moving.is_empty() {
            self.moving.clear();
            self.unseen = None;
        }
    }

    /// What this device keeps of `vault` on iCloud, when that vault is on iCloud.
    pub(crate) fn icloud_for(&self, vault: &str) -> Option<&ICloudState> {
        self.icloud.as_ref().filter(|state| state.vault == vault)
    }

    /// The epoch the engine sees for the store's `epoch`: marked for store names, and for each leave.
    pub(crate) fn engine_epoch(&self, epoch: &str) -> String {
        let epoch = names::epoch(epoch);
        match self.leaves {
            0 => epoch,
            leaves => format!("{epoch}+left{leaves}"),
        }
    }

    /// The successor this device knows of for `vault`, when it found that vault retired.
    pub(crate) fn successor_of(&self, vault: &str) -> Option<&str> {
        self.rotated
            .as_ref()
            .filter(|rotated| rotated.from == vault)
            .map(|rotated| rotated.to.as_str())
    }
}

const CODES: Codes = Codes {
    unreadable: "W_SYNC_SETTINGS_UNREADABLE",
    copy_failed: "W_SYNC_SETTINGS_COPY_FAILED",
    read_failed: "W_SYNC_SETTINGS_READ_FAILED",
    write_failed: "E_SYNC_SETTINGS_WRITE_FAILED",
};

pub(crate) struct SettingsStore {
    file: SettingsFile,
    write: Mutex<()>,
}

impl SettingsStore {
    pub(crate) fn new(path: &Path) -> Self {
        Self {
            file: SettingsFile::new(path, &CODES),
            write: Mutex::new(()),
        }
    }

    /// The folder the settings file is in: the app's data folder.
    pub(crate) fn dir(&self) -> PathBuf {
        self.file
            .path()
            .parent()
            .map_or_else(PathBuf::new, Path::to_path_buf)
    }

    fn read(&self) -> Option<SyncSettings> {
        self.file.read_as(|map| {
            let settings = serde_json::from_value::<SyncSettings>(Value::Object(map)).ok()?;
            Some(SyncSettings {
                relay_url: RelayUrl::parse(&settings.relay_url)
                    .map(|url| url.as_str().to_string())
                    .unwrap_or_default(),
                ..settings
            })
        })
    }

    /// The defaults (off) while the file cannot be read.
    pub(crate) fn get(&self) -> SyncSettings {
        self.read().unwrap_or_default()
    }

    /// Refused while the file cannot be read, so a change made from the defaults shown meanwhile
    /// never replaces what it holds.
    pub(crate) fn set(&self, settings: &SyncSettings) -> Result<(), &'static str> {
        let _writing = self
            .write
            .lock()
            .map_err(|_| "E_SYNC_SETTINGS_WRITE_FAILED")?;
        self.read().ok_or("E_SYNC_SETTINGS_READ_FAILED")?;
        self.file.write(settings)
    }

    /// Reads, changes and writes the settings under the write lock, so a change made from another
    /// thread between the read and the write is not lost to another `update`.
    pub(crate) fn update(
        &self,
        change: impl FnOnce(&mut SyncSettings),
    ) -> Result<(), &'static str> {
        let _writing = self
            .write
            .lock()
            .map_err(|_| "E_SYNC_SETTINGS_WRITE_FAILED")?;
        let mut settings = self.read().ok_or("E_SYNC_SETTINGS_READ_FAILED")?;
        change(&mut settings);
        self.file.write(&settings)
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

/// This device's tokens for the relay vaults its key changes retired, kept while devices of them
/// have not joined `successor`, the vault the last of those changes made.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RetiredTokens {
    pub successor: String,
    pub tokens: Vec<DeviceCredentials>,
}

impl RetiredTokens {
    pub(crate) fn load(store: &dyn SecretStore) -> Result<Option<Self>, SyncError> {
        Ok(store
            .read(RETIRED_DEVICE_ACCOUNT)?
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
    }

    /// Saves the tokens, or forgets the item once none is left.
    pub(crate) fn save(&self, store: &dyn SecretStore) -> Result<(), SyncError> {
        if self.tokens.is_empty() {
            return Self::forget(store);
        }
        let bytes = Zeroizing::new(serde_json::to_vec(self).map_err(|_| SyncError::VaultCorrupt)?);
        store.replace(RETIRED_DEVICE_ACCOUNT, &bytes)
    }

    pub(crate) fn forget(store: &dyn SecretStore) -> Result<(), SyncError> {
        store.remove(RETIRED_DEVICE_ACCOUNT).map(|_| ())
    }
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

    /// The successor's token a rotation keeps until it switches.
    pub(crate) fn load_next(store: &dyn SecretStore) -> Result<Option<Self>, SyncError> {
        Ok(store
            .read(NEXT_DEVICE_ACCOUNT)?
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
    }

    pub(crate) fn save_next(&self, store: &dyn SecretStore) -> Result<(), SyncError> {
        let bytes = Zeroizing::new(serde_json::to_vec(self).map_err(|_| SyncError::VaultCorrupt)?);
        store.replace(NEXT_DEVICE_ACCOUNT, &bytes)
    }

    pub(crate) fn forget_next(store: &dyn SecretStore) -> Result<(), SyncError> {
        store.remove(NEXT_DEVICE_ACCOUNT).map(|_| ())
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

    #[test]
    fn a_file_that_cannot_be_read_is_never_written_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        std::fs::create_dir(&path).unwrap();
        let store = SettingsStore::new(&path);
        assert_eq!(store.get(), SyncSettings::default());
        assert_eq!(
            store.update(|settings| settings.enabled = true),
            Err("E_SYNC_SETTINGS_READ_FAILED")
        );
        assert_eq!(
            store.set(&SyncSettings::default()),
            Err("E_SYNC_SETTINGS_READ_FAILED")
        );
        assert!(path.is_dir());
    }

    #[test]
    fn a_damaged_file_is_kept_aside_and_the_next_change_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        std::fs::write(&path, br#"{"enabled":"yes"}"#).unwrap();
        let store = SettingsStore::new(&path);
        assert_eq!(store.get(), SyncSettings::default());
        store.update(|settings| settings.enabled = true).unwrap();
        assert!(store.get().enabled);
        let kept = dir
            .path()
            .join(format!("{FILE}{}", crate::atomic_file::DAMAGED_SUFFIX));
        assert_eq!(std::fs::read(kept).unwrap(), br#"{"enabled":"yes"}"#);
    }
}
