use serde::{Deserialize, Serialize};

use super::super::client::Welcome;
use super::super::cloudkit::{self};
use super::super::pairing::Qr;
use super::{MAX_SAFE, STATES};

/// What the engine reports, shown in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StatusView {
    pub state: String,
    pub last_sync: Option<i64>,
    pub code: Option<String>,
    #[serde(default)]
    pub too_large: u32,
    /// Paused by the relay's quota cap until then (its next 00:00 UTC).
    #[serde(default)]
    pub paused_until: Option<i64>,
    /// A large upload under way.
    #[serde(default)]
    pub upload: Option<UploadView>,
    /// The relay predates the quota cap or the attachment share: its owner should update it.
    #[serde(default)]
    pub relay_outdated: bool,
    /// Images kept on this device only, and why (`E_SYNC_ATTACHMENTS_FULL`, `E_SYNC_RELAY_OUTDATED`).
    #[serde(default)]
    pub unsynced_files: Option<UnsyncedView>,
    /// Records this run could not read or apply: a newer Devot may.
    #[serde(default)]
    pub skipped: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadView {
    pub sent: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UnsyncedView {
    pub count: u64,
    pub code: String,
}

impl Default for StatusView {
    fn default() -> Self {
        Self {
            state: "off".into(),
            last_sync: None,
            code: None,
            too_large: 0,
            paused_until: None,
            upload: None,
            relay_outdated: false,
            unsynced_files: None,
            skipped: 0,
        }
    }
}

impl StatusView {
    pub(super) fn checked(self) -> Result<Self, &'static str> {
        let code_ok = self.code.as_deref().is_none_or(crate::logs::is_code);
        let time_ok = [self.last_sync, self.paused_until]
            .iter()
            .all(|t| t.is_none_or(|t| t >= 0));
        let upload_ok = self
            .upload
            .is_none_or(|u| u.sent <= u.total && u.total <= MAX_SAFE);
        let unsynced_ok = self
            .unsynced_files
            .as_ref()
            .is_none_or(|u| u.count <= MAX_SAFE && crate::logs::is_code(&u.code));
        if !STATES.contains(&self.state.as_str())
            || !code_ok
            || !time_ok
            || !upload_ok
            || !unsynced_ok
        {
            return Err("E_SYNC_STATUS_INVALID");
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub relay_url: String,
    pub enabled: bool,
    /// Where this device's vault syncs: `relay` or `icloud`.
    pub transport: &'static str,
    /// The keychain holds a vault key.
    pub vault: bool,
    /// This device has a token for the relay set and that vault.
    pub enrolled: bool,
    pub status: StatusView,
    /// What the last look for the Apple ID's vault found, while this device runs.
    pub icloud_join: Option<ICloudJoinView>,
    /// This device started moving its relay vault to iCloud and has not switched yet.
    pub move_started: bool,
    /// Another device rotated the key of the vault this device holds: it joins the successor with a
    /// pairing code or the new recovery key (docs/adr/0017-sync-key-rotation.md).
    pub rotated: bool,
}

/// What this device found of its Apple ID's vault on iCloud, for Settings > Sync and the notice:
/// `unavailable` (with its `code`), `none` (the Apple ID has no vault yet), `joined`, `ask` (the
/// library holds `notes`), `declined`, or `fallback`, a pairing code or the recovery key, with its
/// `reason`: `missing` (no handover item here), `otherVault` or `unreadable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ICloudJoinView {
    pub state: &'static str,
    pub notes: Option<u64>,
    pub reason: Option<&'static str>,
    pub code: Option<&'static str>,
}

impl ICloudJoinView {
    pub(super) fn is(state: &'static str) -> Self {
        Self {
            state,
            notes: None,
            reason: None,
            code: None,
        }
    }

    pub(super) fn unavailable(code: &'static str) -> Self {
        Self {
            code: Some(code),
            ..Self::is("unavailable")
        }
    }

    pub(super) fn fallback(reason: &'static str, code: Option<&'static str>) -> Self {
        Self {
            reason: Some(reason),
            code,
            ..Self::is("fallback")
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsPatch {
    pub relay_url: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PulledDto {
    pub id: String,
    pub name: String,
    pub version: u64,
    /// The relay's; iCloud has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    /// '' on a relay, which has no change tags.
    pub tag: String,
    pub kind: String,
    pub data: Option<String>,
    pub error: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullDto {
    pub records: Vec<PulledDto>,
    pub next: String,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum PushDto {
    Pushed {
        version: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
        tag: String,
    },
    Rejected {
        version: u64,
        tag: String,
    },
    /// The relay's quota cap when it has no code; on iCloud a busy CloudKit (until a time) or a full
    /// iCloud (no end).
    Paused {
        until: Option<i64>,
        limit: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'static str>,
    },
    /// The relay's share for attachments is used up.
    Full,
    /// From a batch only: this item failed with `code`.
    Failed {
        code: &'static str,
    },
}

/// One record of a batched push, as the engine sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PushItemDto {
    pub id: String,
    pub base: u64,
    pub data: String,
    pub kind: String,
    #[serde(default)]
    pub tag: String,
}

/// What Settings needs to offer iCloud: whether this build may use it, and the account's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ICloudView {
    pub available: bool,
    /// `available`, `noAccount`, `restricted` or `temporarilyUnavailable`; null without the container.
    pub account: Option<&'static str>,
}

/// The welcome of either transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub(crate) enum Connected {
    Relay(Welcome),
    ICloud(cloudkit::Welcome),
}

#[cfg(test)]
impl Connected {
    pub(crate) fn relay(self) -> Welcome {
        match self {
            Self::Relay(welcome) => welcome,
            Self::ICloud(_) => panic!("connected through iCloud"),
        }
    }
}

/// Turning sync on: the snapshot, and the recovery key the first time this device's vault is
/// ready on a relay, to show once.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Created {
    pub snapshot: Snapshot,
    pub recovery_key: Option<String>,
}

impl std::fmt::Debug for Created {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Created")
            .field("snapshot", &self.snapshot)
            .finish_non_exhaustive()
    }
}

/// A pairing code to show: as text, as the link the QR code holds, and when it expires.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingView {
    pub code: String,
    pub link: String,
    pub qr: Qr,
    pub expires: i64,
}

impl std::fmt::Debug for PairingView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingView")
            .field("expires", &self.expires)
            .finish_non_exhaustive()
    }
}

/// How the pairing on show is going: `waiting`, `taken` (a device is joining), `paired` with the
/// new device's ID, `expired`, or `unconfirmed` (a device took the code and never confirmed: it may
/// hold the vault key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingCheck {
    pub state: &'static str,
    pub device: Option<String>,
}

impl PairingCheck {
    pub(super) fn is(state: &'static str) -> Self {
        Self {
            state,
            device: None,
        }
    }
}
