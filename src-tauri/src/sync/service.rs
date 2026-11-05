//! Sync as the windows see it: Settings > Sync (the relay's URL, on or off, creating the vault on
//! the first device, pairing and joining, the devices, the status) and the main window's core
//! worker, whose engine (src/core/sync) connects, pulls and pushes through these commands. Keys,
//! the device token and the socket stay here; plaintext records cross as base64.
//!
//! Joining (a pairing code or the recovery key) enrolls the device and then keeps the vault in the
//! keychain; a device that holds the vault key and no token for the relay also enrolls on its own
//! when it connects, unless it was removed from that vault.
//!
//! A vault on iCloud (`sync::cloudkit`) connects, pulls and pushes through the same commands, with
//! no relay, token or socket: the Apple ID is the access check. A device with no vault looks for its
//! Apple ID's vault (`icloud_look`) and joins it through the iCloud Keychain's handover item.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::client::{
    self, Connection, DeviceInfo, Event, PairingState, RelayUrl, RelayUsage, Welcome,
};
use super::cloudkit::current::{self, Claim};
use super::cloudkit::kit::vault_zone;
use super::cloudkit::pairing::ICloudPairing;
use super::cloudkit::{self, CloudKit, ICloud, ICloudState, Staging};
use super::file_record;
use super::handover;
use super::keychain::SyncedKeychain;
use super::moved;
use super::pairing::{self, Pairing, PairingChannel, Qr, RelayPairing};
use super::settings::{DeviceCredentials, RelayDevice, SettingsStore, SyncSettings, Unseen};
use super::{MAX_RECORD_BYTES, SecretStore, Vault};
use crate::licence::Gate;

pub(crate) const CHANGED_EVENT: &str = "devot://sync-changed";
pub(crate) const SOCKET_EVENT: &str = "devot://sync-event";
/// A pairing on show through iCloud may have moved on: check it now, as the subscription stands in
/// for polling there.
pub(crate) const PAIRING_EVENT: &str = "devot://sync-pairing";
const OTHER_VAULT: &str = "E_SYNC_ICLOUD_OTHER_VAULT";
const OTHER_ACCOUNT: &str = "E_SYNC_ICLOUD_OTHER_ACCOUNT";
const NO_VAULT: &str = "E_SYNC_ICLOUD_NO_VAULT";
const VAULT_MOVED: &str = "E_SYNC_VAULT_MOVED";
const RECOVERY_OTHER_VAULT: &str = "E_SYNC_RECOVERY_OTHER_VAULT";
const MAX_RELAY_SECRET: usize = 1024;
const MAX_RECOVERY_KEY: usize = 512;
const STATES: [&str; 7] = [
    "off",
    "connecting",
    "syncing",
    "idle",
    "offline",
    "paused",
    "stopped",
];
/// A token marked so stays unused: the device was revoked, and joins again only when the user
/// creates or pairs the vault again.
const REVOKED: &str = "";

#[cfg(target_os = "ios")]
const DEVICE_LABEL: &str = "Devot for iOS";
#[cfg(not(target_os = "ios"))]
const DEVICE_LABEL: &str = "Devot for macOS";

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
    fn checked(self) -> Result<Self, &'static str> {
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
    fn is(state: &'static str) -> Self {
        Self {
            state,
            notes: None,
            reason: None,
            code: None,
        }
    }

    fn unavailable(code: &'static str) -> Self {
        Self {
            code: Some(code),
            ..Self::is("unavailable")
        }
    }

    fn fallback(reason: &'static str, code: Option<&'static str>) -> Self {
        Self {
            reason: Some(reason),
            code,
            ..Self::is("fallback")
        }
    }
}

/// What a look for the Apple ID's vault found.
enum Found {
    /// This device holds a vault, and never joins another.
    Held,
    View(ICloudJoinView),
    /// The handover item names the vault `current` names.
    Vault(Box<Vault>),
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
    fn is(state: &'static str) -> Self {
        Self {
            state,
            device: None,
        }
    }
}

/// The pairing this device shows. Only one at a time: a new code closes the last.
struct Hosting {
    pairing: Pairing,
    channel: Box<dyn PairingChannel>,
    vault: String,
    expires: i64,
    taken: AtomicBool,
    icloud: bool,
}

pub(crate) type Emit = Arc<dyn Fn(&'static str, Value) + Send + Sync>;
pub(crate) type Secrets = Arc<dyn SecretStore + Send + Sync>;

enum Live {
    Relay {
        connection: Arc<Connection>,
        vault: Arc<Vault>,
    },
    ICloud(Arc<ICloud>),
}

/// Most records one batched push takes: the engine sends at most 100.
const MAX_BATCH: usize = 200;

pub(crate) struct SyncService {
    settings: SettingsStore,
    secrets: Secrets,
    live: Mutex<Option<Live>>,
    status: Mutex<StatusView>,
    emit: Emit,
    licence: Gate,
    hosting: Mutex<Option<Arc<Hosting>>>,
    kit: Arc<dyn CloudKit>,
    staging: Arc<Staging>,
    /// The iCloud Keychain's handover item (`sync::handover`).
    handover: Secrets,
    look: Mutex<Option<ICloudJoinView>>,
    /// Held while a vault switches to iCloud, so a move the owner asked for and one finished at a
    /// pass never make two device IDs.
    switching: Mutex<()>,
    /// Moves this service's clock in tests of expiry.
    shifted: AtomicI64,
    /// Fails the next switch to iCloud as if the app quit just before it.
    #[cfg(test)]
    quits_before_switch: std::sync::atomic::AtomicBool,
    /// Fails the relay's next device list taken at a move to iCloud.
    #[cfg(test)]
    fails_device_list: std::sync::atomic::AtomicBool,
    /// Fails the next moved marker as if the relay refused it.
    #[cfg(test)]
    fails_marker: std::sync::atomic::AtomicBool,
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;

enum LiveRef {
    Relay(Arc<Connection>, Arc<Vault>),
    ICloud(Arc<ICloud>),
}

/// A record to push, checked as the command's arguments: its plaintext.
fn checked_item(
    id: &str,
    base: u64,
    data: &str,
    kind: &str,
) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    if !matches!(kind, "record" | "file") {
        return Err("E_SYNC_KIND_INVALID");
    }
    if !crate::commands::notes::valid_note_id(id) {
        return Err("E_SYNC_ID_INVALID");
    }
    if base >= MAX_SAFE {
        return Err("E_SYNC_VERSION_INVALID");
    }
    if data.len() > MAX_RECORD_BYTES.div_ceil(3) * 4 {
        return Err("E_SYNC_TOO_LARGE");
    }
    let plaintext = Zeroizing::new(
        STANDARD
            .decode(data.as_bytes())
            .map_err(|_| "E_SYNC_RECORD_INVALID")?,
    );
    if plaintext.is_empty() {
        return Err("E_SYNC_RECORD_INVALID");
    }
    if kind == "file" {
        file_record::check(id, &plaintext).inspect_err(|code| {
            log::warn!("W_SYNC_FILE_REFUSED {code} id={id}");
        })?;
    }
    Ok(plaintext)
}

/// A pulled record for the engine. An attachment is checked as a paste is, before the web view sees it.
fn pulled(
    id: String,
    version: u64,
    seq: Option<u64>,
    tag: String,
    kind: String,
    plaintext: Result<Zeroizing<Vec<u8>>, &'static str>,
) -> PulledDto {
    let opened = plaintext.and_then(|bytes| {
        if kind == "file" {
            file_record::check(&id, &bytes)?;
        }
        Ok(bytes)
    });
    let (data, error) = match opened {
        Ok(bytes) => (Some(STANDARD.encode(bytes.as_slice())), None),
        Err(code) => {
            if kind == "record" {
                log::warn!("W_SYNC_RECORD_UNREADABLE {code} id={id}");
            } else if kind == "file" {
                log::warn!("W_SYNC_FILE_REFUSED {code} id={id}");
            }
            (None, Some(code))
        }
    };
    PulledDto {
        id,
        version,
        seq,
        tag,
        kind,
        data,
        error,
    }
}

fn push_dto(answer: cloudkit::PushAnswer) -> PushDto {
    match answer {
        cloudkit::PushAnswer::Pushed { version, tag } => PushDto::Pushed {
            version,
            seq: None,
            tag,
        },
        cloudkit::PushAnswer::Rejected { version, tag } => PushDto::Rejected { version, tag },
        cloudkit::PushAnswer::Paused { until, code } => {
            log::info!("I_SYNC_ICLOUD_PAUSED {code} until={}", until.unwrap_or(0));
            PushDto::Paused {
                until,
                limit: None,
                code: Some(code),
            }
        }
        cloudkit::PushAnswer::Failed(code) => PushDto::Failed { code },
    }
}

impl SyncService {
    pub(crate) fn new(
        settings: SettingsStore,
        secrets: Secrets,
        emit: Emit,
        licence: Gate,
    ) -> Self {
        let settings_dir = settings.dir();
        Self {
            settings,
            secrets,
            live: Mutex::new(None),
            status: Mutex::new(StatusView::default()),
            emit,
            licence,
            hosting: Mutex::new(None),
            staging: Arc::new(Staging::new(&settings_dir.join(cloudkit::staging::DIR))),
            kit: Arc::new(cloudkit::kit::Unavailable),
            handover: Arc::new(SyncedKeychain::new(handover::SERVICE, false)),
            look: Mutex::new(None),
            switching: Mutex::new(()),
            shifted: AtomicI64::new(0),
            #[cfg(test)]
            quits_before_switch: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fails_device_list: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fails_marker: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(crate) fn with_handover(mut self, store: Secrets) -> Self {
        self.handover = store;
        self
    }

    /// iCloud through `kit`; its asset staging folder is swept here, before any upload.
    pub(crate) fn with_icloud(mut self, kit: Arc<dyn CloudKit>) -> Self {
        self.kit = kit;
        self.staging.sweep();
        self
    }

    fn now(&self) -> i64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        now.saturating_add(self.shifted.load(Ordering::Relaxed))
    }

    #[cfg(test)]
    pub(crate) fn shift_clock(&self, ms: i64) {
        self.shifted.fetch_add(ms, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn quit_before_next_switch(&self) {
        self.quits_before_switch.store(true, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_device_list(&self) {
        self.fails_device_list.store(true, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_marker(&self) {
        self.fails_marker.store(true, Ordering::Relaxed);
    }

    /// From the settings alone, without the keychain `snapshot` reads.
    pub(crate) fn enabled(&self) -> bool {
        self.settings.get().enabled
    }

    fn relay(&self) -> Result<RelayUrl, &'static str> {
        RelayUrl::parse(&self.settings.get().relay_url).map_err(|_| "E_SYNC_NO_RELAY")
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let settings = self.settings.get();
        let vault = Vault::load(self.secrets.as_ref()).ok().flatten();
        let enrolled = vault.as_ref().is_some_and(|vault| {
            DeviceCredentials::load(self.secrets.as_ref())
                .ok()
                .flatten()
                .is_some_and(|c| {
                    c.token != REVOKED && c.fits(&settings.relay_url, &vault.id().to_string())
                })
        });
        let transport = match &vault {
            Some(vault) if settings.icloud_for(&vault.id().to_string()).is_some() => "icloud",
            _ => "relay",
        };
        let move_started = transport == "relay"
            && vault
                .as_ref()
                .is_some_and(|vault| settings.moving == vault.id().to_string());
        Snapshot {
            relay_url: settings.relay_url,
            enabled: settings.enabled,
            transport,
            vault: vault.is_some(),
            enrolled,
            status: self.status.lock().map(|s| s.clone()).unwrap_or_default(),
            icloud_join: self.look.lock().ok().and_then(|look| look.clone()),
            move_started,
        }
    }

    fn changed(&self) -> Snapshot {
        let snapshot = self.snapshot();
        (self.emit)(CHANGED_EVENT, json!(snapshot));
        snapshot
    }

    pub(crate) fn set(&self, patch: SettingsPatch) -> Result<Snapshot, &'static str> {
        let mut settings = self.settings.get();
        if let Some(url) = patch.relay_url {
            let url = if url.trim().is_empty() {
                String::new()
            } else {
                RelayUrl::parse(&url)?.as_str().to_string()
            };
            if url != settings.relay_url {
                self.disconnect();
                settings.call_off_move();
            }
            settings.relay_url = url;
        }
        if let Some(enabled) = patch.enabled {
            if !enabled {
                self.disconnect();
                settings.call_off_move();
            }
            settings.enabled = enabled;
        }
        self.settings.set(&settings)?;
        Ok(self.changed())
    }

    /// On the first device: makes the vault key (or takes the one the keychain holds) and creates
    /// the vault on the relay, which asks for its own secret. The secret goes into that one request
    /// and is dropped. A relay that already holds this vault enrolls the device instead. The
    /// recovery key comes back once for each vault: the first time it is ready on a relay, which
    /// may be a later call than the one that made the key when the relay refused that one.
    pub(crate) fn create_vault(&self, relay_secret: &str) -> Result<Created, &'static str> {
        self.licence.require()?;
        let relay_secret = Zeroizing::new(relay_secret.trim().to_string());
        if relay_secret.is_empty()
            || relay_secret.len() > MAX_RELAY_SECRET
            || relay_secret.chars().any(char::is_control)
        {
            return Err("E_SYNC_RELAY_SECRET_INVALID");
        }
        let relay = self.relay()?;
        let vault = match Vault::load(self.secrets.as_ref()).map_err(|e| e.code())? {
            Some(vault) => vault,
            None => Vault::create(self.secrets.as_ref()).map_err(|e| e.code())?,
        };
        let enrolled = match client::create_vault(&relay, &relay_secret, &vault, DEVICE_LABEL) {
            Err("E_SYNC_VAULT_EXISTS") => client::enroll(&relay, &vault, DEVICE_LABEL)?,
            other => other?,
        };
        self.keep(&relay, &vault, &enrolled.device, &enrolled.token)?;
        let mut settings = self.settings.get();
        settings.enabled = true;
        self.settings.set(&settings)?;
        log::info!("I_SYNC_VAULT_READY vault={}", vault.id());
        Ok(Created {
            snapshot: self.changed(),
            recovery_key: self.recovery_key()?.map(|key| key.to_string()),
        })
    }

    /// The recovery key while this device has not said it was saved, once the vault is ready on a
    /// relay. Kept on offer so a closed window or a lost answer does not lose it.
    pub(crate) fn recovery_key(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
        let Some(vault) = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())? else {
            return Ok(None);
        };
        let shown = self.settings.get().recovery_shown == vault.id().to_string();
        let snapshot = self.snapshot();
        let ready = snapshot.enrolled || snapshot.transport == "icloud";
        Ok((!shown && ready).then(|| vault.recovery_key()))
    }

    pub(crate) fn recovery_saved(&self) -> Result<(), &'static str> {
        let vault = self.held_vault()?;
        let mut settings = self.settings.get();
        settings.recovery_shown = vault.id().to_string();
        self.settings.set(&settings)
    }

    /// This device's token for `relay` and `vault`, when it is enrolled and not removed.
    fn credentials(
        &self,
        relay: &RelayUrl,
        vault: &Vault,
    ) -> Result<DeviceCredentials, &'static str> {
        match DeviceCredentials::load(self.secrets.as_ref()).map_err(|e| e.code())? {
            Some(c) if c.fits(relay.as_str(), &vault.id().to_string()) => {
                if c.token == REVOKED {
                    Err("E_SYNC_REVOKED")
                } else {
                    Ok(c)
                }
            }
            _ => Err("E_SYNC_NOT_ENROLLED"),
        }
    }

    fn held_vault(&self) -> Result<Vault, &'static str> {
        Vault::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .ok_or("E_SYNC_NO_VAULT_KEY")
    }

    /// Shows a new pairing code: seals the vault under it and leaves the offer on the relay
    /// (docs/adr/0008-sync-device-pairing.md), or for a vault on iCloud in zone `devot`. A code
    /// shown before is closed.
    pub(crate) fn pairing_open(&self) -> Result<PairingView, &'static str> {
        self.licence.require()?;
        if self.on_icloud() {
            return self.pairing_open_icloud();
        }
        let relay = self.relay()?;
        let vault = self.held_vault()?;
        let credentials = self.credentials(&relay, &vault)?;
        self.pairing_cancel();
        let pairing = Pairing::generate().map_err(|e| e.code())?;
        let expires = self.now().saturating_add(pairing::TTL_MS);
        let offer = pairing.seal_offer(&vault, expires).map_err(|e| e.code())?;
        let vault_id = vault.id().to_string();
        let token = Zeroizing::new(credentials.token);
        let channel = RelayPairing::host(relay.clone(), vault_id.clone(), token);
        channel.open(pairing.id(), &offer)?;
        let link = pairing.link(&relay);
        self.show(pairing, Box::new(channel), vault_id, expires, &link, false)
    }

    /// The offer waits in zone `devot`, where only this Apple ID's devices see it.
    fn pairing_open_icloud(&self) -> Result<PairingView, &'static str> {
        let vault = self.held_vault()?;
        current::ready(self.kit.as_ref())?;
        self.pairing_cancel();
        let pairing = Pairing::generate().map_err(|e| e.code())?;
        let now = self.now();
        let expires = now.saturating_add(pairing::TTL_MS);
        let offer = pairing
            .seal_icloud_offer(&vault, expires)
            .map_err(|e| e.code())?;
        let channel = ICloudPairing::host(Arc::clone(&self.kit), expires, now);
        channel.open(pairing.id(), &offer)?;
        let link = pairing.icloud_link();
        let vault_id = vault.id().to_string();
        self.show(pairing, Box::new(channel), vault_id, expires, &link, true)
    }

    fn show(
        &self,
        pairing: Pairing,
        channel: Box<dyn PairingChannel>,
        vault_id: String,
        expires: i64,
        link: &str,
        icloud: bool,
    ) -> Result<PairingView, &'static str> {
        let view = PairingView {
            code: pairing.code().to_string(),
            link: link.to_string(),
            qr: pairing::qr(link)?,
            expires,
        };
        log::info!(
            "I_SYNC_PAIRING_OPEN vault={vault_id} pairing={}",
            pairing.id()
        );
        *self.hosting.lock().map_err(|_| "E_SYNC_INTERNAL")? = Some(Arc::new(Hosting {
            pairing,
            channel,
            vault: vault_id,
            expires,
            taken: AtomicBool::new(false),
            icloud,
        }));
        Ok(view)
    }

    /// Whether this device's vault syncs through iCloud.
    fn on_icloud(&self) -> bool {
        let settings = self.settings.get();
        Vault::load(self.secrets.as_ref())
            .ok()
            .flatten()
            .is_some_and(|vault| settings.icloud_for(&vault.id().to_string()).is_some())
    }

    /// Asks the relay (or zone `devot`) how the pairing on show is going. A confirmation counts only
    /// when it opens under the code's key; then the pairing is closed.
    pub(crate) fn pairing_check(&self) -> Result<PairingCheck, &'static str> {
        let hosting = self
            .hosting
            .lock()
            .map_err(|_| "E_SYNC_INTERNAL")?
            .clone()
            .ok_or("E_SYNC_PAIRING_NONE")?;
        let now = self.now();
        // A device that took the code just before expiry may confirm while the relay keeps it.
        if now > hosting.expires.saturating_add(pairing::GRACE_MS) {
            self.end_pairing(&hosting);
            return Ok(Self::ended(&hosting));
        }
        let state = hosting.channel.poll(hosting.pairing.id());
        match state {
            Ok(PairingState::Open) if now > hosting.expires => {
                self.end_pairing(&hosting);
                Ok(Self::ended(&hosting))
            }
            Ok(PairingState::Open) => Ok(PairingCheck::is("waiting")),
            Ok(PairingState::Taken) => {
                hosting.taken.store(true, Ordering::Relaxed);
                Ok(PairingCheck::is("taken"))
            }
            Ok(PairingState::Confirmed(proof)) => {
                let opened = hosting.pairing.open_confirmation(&proof);
                self.end_pairing(&hosting);
                let device = opened.map_err(|e| {
                    log::warn!("W_SYNC_PAIRING_PROOF pairing={}", hosting.pairing.id());
                    e.code()
                })?;
                log::info!("I_SYNC_PAIRED vault={} device={device}", hosting.vault);
                Ok(PairingCheck {
                    state: "paired",
                    device: Some(device),
                })
            }
            Err("E_SYNC_PAIRING_GONE") => {
                self.forget_pairing(&hosting);
                Ok(Self::ended(&hosting))
            }
            Err(code) => Err(code),
        }
    }

    fn ended(hosting: &Hosting) -> PairingCheck {
        if hosting.taken.load(Ordering::Relaxed) {
            log::warn!(
                "W_SYNC_PAIRING_UNCONFIRMED pairing={}",
                hosting.pairing.id()
            );
            PairingCheck::is("unconfirmed")
        } else {
            PairingCheck::is("expired")
        }
    }

    /// Closes the pairing on show, where its offer waits too when that answers.
    pub(crate) fn pairing_cancel(&self) {
        let hosting = self.hosting.lock().ok().and_then(|mut h| h.take());
        if let Some(hosting) = hosting {
            Self::close_on_relay(&hosting);
        }
    }

    fn end_pairing(&self, hosting: &Arc<Hosting>) {
        self.forget_pairing(hosting);
        Self::close_on_relay(hosting);
    }

    fn forget_pairing(&self, hosting: &Arc<Hosting>) {
        if let Ok(mut held) = self.hosting.lock()
            && held.as_ref().is_some_and(|h| Arc::ptr_eq(h, hosting))
        {
            *held = None;
        }
    }

    fn close_on_relay(hosting: &Hosting) {
        let closed = hosting.channel.close(hosting.pairing.id());
        if let Err(code) = closed
            && code != "E_SYNC_PAIRING_GONE"
        {
            log::warn!("W_SYNC_PAIRING_CLOSE {code}");
        }
    }

    /// Joins the vault a pairing code (or the link its QR code holds) hands over: takes the offer,
    /// enrolls this device, keeps the vault and confirms to the device that shows the code. A link
    /// must name the relay set in Settings: the page asks before it sets a relay from a link. A code
    /// alone goes through iCloud when `icloud`, the page's choice; a link names its own way.
    pub(crate) fn join_with_code_via(
        &self,
        text: &str,
        icloud: bool,
    ) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        let entered = pairing::read(text).map_err(|e| e.code())?;
        if entered.icloud || (icloud && entered.relay.is_none()) {
            return self.join_icloud_with_code(&entered.pairing);
        }
        let relay = self.relay()?;
        if entered
            .relay
            .is_some_and(|named| named.as_str() != relay.as_str())
        {
            return Err("E_SYNC_PAIRING_RELAY");
        }
        // Refused before the offer is taken, so the code still works on another device. A device
        // removed from its vault may hold it and be let back in.
        let held = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())?;
        if let Some(held) = &held
            && !self.revoked_from(held)?
        {
            return Err("E_SYNC_VAULT_EXISTS");
        }
        let pairing = entered.pairing;
        let channel = RelayPairing::join(relay.clone());
        let offer = channel.take(pairing.id())?;
        let vault = pairing.open_offer(&offer, self.now()).map_err(|e| {
            log::warn!("W_SYNC_PAIRING_OFFER {} pairing={}", e.code(), pairing.id());
            e.code()
        })?;
        if held.is_some_and(|held| !held.same(&vault)) {
            return Err("E_SYNC_VAULT_EXISTS");
        }
        let (vault, device) = self.join(&relay, vault)?;
        let confirmed = pairing
            .seal_confirmation(&device)
            .map_err(|e| e.code())
            .and_then(|proof| channel.confirm(pairing.id(), &proof));
        if let Err(code) = confirmed {
            log::warn!("W_SYNC_PAIRING_CONFIRM {code} pairing={}", pairing.id());
        }
        log::info!("I_SYNC_JOINED vault={} device={device}", vault.id());
        Ok(self.changed())
    }

    #[cfg(test)]
    pub(crate) fn join_with_code(&self, text: &str) -> Result<Snapshot, &'static str> {
        self.join_with_code_via(text, false)
    }

    /// Takes the offer from zone `devot`, keeps the vault it seals and confirms with this device's
    /// ID in the vault. An offer this Apple ID cannot see, when it has no vault either, was shown on
    /// another Apple ID.
    fn join_icloud_with_code(&self, pairing: &Pairing) -> Result<Snapshot, &'static str> {
        let kit = self.kit.as_ref();
        // Refused before the offer is taken, so the code still works on another device.
        if Vault::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .is_some()
        {
            return Err("E_SYNC_VAULT_EXISTS");
        }
        current::ready(kit)?;
        let channel = ICloudPairing::join(Arc::clone(&self.kit));
        let offer =
            channel
                .take(pairing.id())
                .map_err(|code| match (code, current::read(kit)) {
                    ("E_SYNC_PAIRING_GONE", Ok(None)) => OTHER_ACCOUNT,
                    _ => code,
                })?;
        let vault = pairing.open_icloud_offer(&offer, self.now()).map_err(|e| {
            log::warn!("W_SYNC_PAIRING_OFFER {} pairing={}", e.code(), pairing.id());
            e.code()
        })?;
        self.belongs(&vault)?;
        let vault = self.keep_icloud(vault, true)?;
        let vault_id = vault.id().to_string();
        let device = self
            .settings
            .get()
            .icloud_for(&vault_id)
            .map(|state| state.device.clone())
            .ok_or("E_SYNC_INTERNAL")?;
        let confirmed = pairing
            .seal_confirmation(&device)
            .map_err(|e| e.code())
            .and_then(|proof| channel.confirm(pairing.id(), &proof));
        if let Err(code) = confirmed {
            log::warn!("W_SYNC_PAIRING_CONFIRM {code} pairing={}", pairing.id());
        }
        log::info!("I_SYNC_JOINED vault={vault_id} device={device} via=icloud");
        Ok(self.changed())
    }

    /// Joins with the recovery key and the relay set in Settings: restores the vault and enrolls
    /// this device. Works with a relay from before pairing, which has enrollment.
    pub(crate) fn join_with_recovery(&self, text: &str) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        if text.len() > MAX_RECOVERY_KEY {
            return Err("E_SYNC_RECOVERY_FORMAT");
        }
        let relay = self.relay()?;
        let vault = Vault::from_recovery_key(text).map_err(|e| e.code())?;
        if let Some(held) = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())? {
            if !held.same(&vault) {
                return Err("E_SYNC_VAULT_EXISTS");
            }
            if self.credentials(&relay, &held).is_ok() {
                return Ok(self.changed());
            }
        }
        let (vault, device) = self.join(&relay, vault)?;
        log::info!("I_SYNC_RECOVERED vault={} device={device}", vault.id());
        Ok(self.changed())
    }

    /// Whether this device holds a token for `vault` that the relay revoked, on any relay address.
    fn revoked_from(&self, vault: &Vault) -> Result<bool, &'static str> {
        Ok(DeviceCredentials::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .is_some_and(|c| c.vault == vault.id().to_string() && c.token == REVOKED))
    }

    /// Enrolls this device in `vault` on `relay`, then keeps the token, the vault and sync on, in
    /// that order: a refused enrollment keeps nothing, and the engine, which needs the vault, never
    /// enrolls a second time meanwhile.
    fn join(&self, relay: &RelayUrl, vault: Vault) -> Result<(Vault, String), &'static str> {
        let enrolled = client::enroll(relay, &vault, DEVICE_LABEL)?;
        self.keep(relay, &vault, &enrolled.device, &enrolled.token)?;
        let vault = Vault::join(self.secrets.as_ref(), vault).map_err(|e| {
            if DeviceCredentials::forget(self.secrets.as_ref()).is_err() {
                log::warn!("W_SYNC_TOKEN_FORGET_FAILED");
            }
            e.code()
        })?;
        let mut settings = self.settings.get();
        settings.enabled = true;
        settings.recovery_shown = vault.id().to_string();
        self.settings.set(&settings)?;
        Ok((vault, enrolled.device))
    }

    /// Runs `work` on the engine's socket, or on one opened for it when sync is not connected.
    fn with_connection<T>(
        &self,
        work: impl FnOnce(&Connection) -> Result<T, &'static str>,
    ) -> Result<T, &'static str> {
        let relay = self.relay()?;
        let vault = self.held_vault()?;
        let credentials = self.credentials(&relay, &vault)?;
        if let Ok((connection, _)) = self.live_relay() {
            return work(&connection);
        }
        let (connection, _) = Connection::open(
            &relay,
            &vault.id().to_string(),
            &credentials.token,
            Box::new(|_| {}),
        )
        .inspect_err(|code| Self::refused(self.secrets.as_ref(), code))?;
        let result = work(&connection);
        connection.close();
        result
    }

    /// The vault's devices. Not gated by the licence: seeing and removing access never is. On
    /// iCloud they are its device rows, each with the day it was last seen in `created`, then the
    /// relay's devices not seen there since this device moved the vault, which leave once seen.
    pub(crate) fn devices(&self) -> Result<Vec<DeviceInfo>, &'static str> {
        let vault = self.held_vault()?;
        let id = vault.id().to_string();
        let settings = self.settings.get();
        let Some(state) = settings.icloud_for(&id) else {
            return self.with_connection(client::devices);
        };
        current::ready(self.kit.as_ref())?;
        let rows = cloudkit::devices(self.kit.as_ref(), &vault, &state.device)?;
        let unseen = self.still_unseen(&id, &rows);
        let mut devices: Vec<DeviceInfo> = rows.into_iter().map(|row| row.info).collect();
        devices.extend(unseen.into_iter().map(|device| DeviceInfo {
            id: device.id,
            label: device.label,
            created: device.created,
            current: false,
            unseen: true,
        }));
        Ok(devices)
    }

    /// The relay devices kept for `vault` that no row of `rows` names, kept again without the rest.
    fn still_unseen(&self, vault: &str, rows: &[cloudkit::DeviceRow]) -> Vec<RelayDevice> {
        let not_seen = |device: &RelayDevice| !rows.iter().any(|row| row.relay == device.id);
        let kept = self.settings.get().unseen.filter(|u| u.vault == vault);
        let Some(kept) = kept else {
            return Vec::new();
        };
        let count = kept.devices.len();
        let left: Vec<RelayDevice> = kept.devices.into_iter().filter(not_seen).collect();
        if left.len() != count {
            let saved = self.settings.update(|settings| {
                if let Some(unseen) = settings.unseen.as_mut().filter(|u| u.vault == vault) {
                    unseen.devices.retain(not_seen);
                    if unseen.devices.is_empty() {
                        settings.unseen = None;
                    }
                }
            });
            if let Err(code) = saved {
                log::warn!("W_SYNC_UNSEEN_SAVE {code} vault={vault}");
            }
        }
        left
    }

    /// Keeps the relay's other devices as `connection` lists them, before the moved marker stops
    /// them, so Settings can name those not seen on iCloud yet. A list the relay does not give
    /// keeps none and does not stop the move.
    fn keep_unseen(&self, connection: &Connection, vault: &str) {
        let listed = client::devices(connection);
        #[cfg(test)]
        let listed = if self.fails_device_list.swap(false, Ordering::Relaxed) {
            Err("E_TEST_DEVICES")
        } else {
            listed
        };
        let devices = match listed {
            Ok(devices) => devices
                .into_iter()
                .filter(|device| !device.current)
                .map(|device| RelayDevice {
                    id: device.id,
                    label: device.label,
                    created: device.created,
                })
                .collect::<Vec<_>>(),
            Err(code) => {
                log::warn!("W_SYNC_MOVE_DEVICES {code} vault={vault}");
                Vec::new()
            }
        };
        let saved = self.settings.update(|settings| {
            settings.unseen = (!devices.is_empty()).then(|| Unseen {
                vault: vault.to_string(),
                devices,
            });
        });
        if let Err(code) = saved {
            log::warn!("W_SYNC_UNSEEN_SAVE {code} vault={vault}");
        }
    }

    /// What the relay holds and may hold. Read-only and not gated by the licence, like the devices.
    pub(crate) fn usage(&self) -> Result<RelayUsage, &'static str> {
        self.with_connection(client::usage)
    }

    /// Removes a device from the vault: the relay revokes its token and closes its sockets. This
    /// device cannot remove itself.
    pub(crate) fn remove_device(&self, device: &str) -> Result<Vec<DeviceInfo>, &'static str> {
        let own = DeviceCredentials::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .map(|c| c.device);
        if own.as_deref() == Some(device) {
            return Err("E_SYNC_DEVICE_SELF");
        }
        self.with_connection(|connection| {
            client::revoke(connection, device)?;
            log::info!("I_SYNC_DEVICE_REMOVED device={device}");
            client::devices(connection)
        })
    }

    fn keep(
        &self,
        relay: &RelayUrl,
        vault: &Vault,
        device: &str,
        token: &str,
    ) -> Result<(), &'static str> {
        DeviceCredentials {
            relay: relay.as_str().to_string(),
            vault: vault.id().to_string(),
            device: device.to_string(),
            token: token.to_string(),
        }
        .save(self.secrets.as_ref())
        .map_err(|e| e.code())
    }

    fn enroll_here(
        &self,
        relay: &RelayUrl,
        vault: &Vault,
    ) -> Result<DeviceCredentials, &'static str> {
        let enrolled = client::enroll(relay, vault, DEVICE_LABEL)?;
        self.keep(relay, vault, &enrolled.device, &enrolled.token)?;
        log::info!(
            "I_SYNC_ENROLLED vault={} device={}",
            vault.id(),
            enrolled.device
        );
        DeviceCredentials::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .ok_or("E_SYNC_NOT_ENROLLED")
    }

    /// What the relay's refusal means for the kept token. A revoked device keeps a marked token and
    /// never enrolls on its own; a relay without the vault (it lost its data) makes the token
    /// useless, so it goes and Settings asks for the relay's secret to create the vault again.
    fn refused(secrets: &dyn SecretStore, code: &str) {
        match code {
            "E_SYNC_REVOKED" | "E_SYNC_UNAUTHORIZED" => {
                if let Ok(Some(mut credentials)) = DeviceCredentials::load(secrets) {
                    credentials.token = REVOKED.to_string();
                    if credentials.save(secrets).is_err() {
                        log::warn!("W_SYNC_REVOKE_KEEP_FAILED");
                    }
                }
            }
            "E_SYNC_NO_VAULT" if DeviceCredentials::forget(secrets).is_err() => {
                log::warn!("W_SYNC_TOKEN_FORGET_FAILED");
            }
            _ => {}
        }
    }

    /// `has_synced` is the library's own "has synced" state (`sync_state`), which decides on
    /// iCloud whether a vault zone found gone is a deletion to ask about.
    pub(crate) fn connect(&self, has_synced: bool) -> Result<Connected, &'static str> {
        let settings = self.settings.get();
        if !settings.enabled {
            return Err("E_SYNC_OFF");
        }
        // A device that already syncs stops here, at its next connect.
        self.licence.require()?;
        let vault = Vault::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .ok_or("E_SYNC_NO_VAULT_KEY")?;
        let vault_id = vault.id().to_string();
        if let Some(state) = settings.icloud_for(&vault_id) {
            return self
                .connect_icloud(vault, state, has_synced)
                .map(Connected::ICloud);
        }
        let relay = self.relay()?;
        // A removed device stays out under any address of the relay: only a join lets it back in.
        let credentials =
            match DeviceCredentials::load(self.secrets.as_ref()).map_err(|e| e.code())? {
                Some(c) if c.vault == vault_id && c.token == REVOKED => {
                    return Err("E_SYNC_REVOKED");
                }
                Some(c) if c.fits(relay.as_str(), &vault_id) => c,
                _ => self.enroll_here(&relay, &vault)?,
            };
        self.disconnect();
        let opened = match self.open(&relay, &vault_id, &credentials.token) {
            // The relay's own secret changed, which makes every token invalid: enroll again.
            Err("E_SYNC_TOKEN_REFUSED") => self
                .enroll_here(&relay, &vault)
                .and_then(|again| self.open(&relay, &vault_id, &again.token)),
            other => other,
        };
        let (connection, welcome) = opened.inspect_err(|code| {
            Self::refused(self.secrets.as_ref(), code);
        })?;
        log::info!(
            "I_SYNC_CONNECTED vault={vault_id} device={}",
            welcome.device
        );
        *self.live.lock().map_err(|_| "E_SYNC_INTERNAL")? = Some(Live::Relay {
            connection: Arc::new(connection),
            vault: Arc::new(vault),
        });
        Ok(Connected::Relay(welcome))
    }

    fn connect_icloud(
        &self,
        vault: Vault,
        state: &ICloudState,
        has_synced: bool,
    ) -> Result<cloudkit::Welcome, &'static str> {
        self.disconnect();
        let vault = Arc::new(vault);
        let icloud = ICloud::new(
            Arc::clone(&self.kit),
            Arc::clone(&vault),
            Arc::clone(&self.staging),
        );
        let (welcome, kept) = icloud
            .connect(state, has_synced, DEVICE_LABEL, self.now())
            .inspect_err(|code| {
                log::info!("I_SYNC_ICLOUD_REFUSED {code}");
                if *code == cloudkit::error::ACCOUNT_CHANGED {
                    self.forget_handover(&vault);
                }
            })?;
        if kept != *state {
            self.settings.update(|settings| {
                if settings
                    .icloud
                    .as_ref()
                    .is_some_and(|s| s.vault == kept.vault)
                {
                    settings.icloud = Some(kept);
                }
            })?;
        }
        log::info!(
            "I_SYNC_ICLOUD_CONNECTED vault={} device={}",
            state.vault,
            welcome.device
        );
        self.hand_over_at_connect(&vault);
        *self.live.lock().map_err(|_| "E_SYNC_INTERNAL")? = Some(Live::ICloud(Arc::new(icloud)));
        Ok(welcome)
    }

    /// Whether this build may use iCloud, and the account's state, for Settings. Touches CloudKit
    /// only in a build with the container.
    pub(crate) fn icloud_status(&self) -> ICloudView {
        use cloudkit::kit::Account;
        if !self.kit.available() {
            return ICloudView {
                available: false,
                account: None,
            };
        }
        let account = match self.kit.account() {
            Ok(Account::Available) => "available",
            Ok(Account::Missing) => "noAccount",
            Ok(Account::Restricted) => "restricted",
            Ok(Account::TemporarilyUnavailable | Account::CouldNotDetermine) | Err(_) => {
                "temporarilyUnavailable"
            }
        };
        ICloudView {
            available: true,
            account: Some(account),
        }
    }

    /// Syncs this device's vault through iCloud from its next connect, and turns sync on, once
    /// `current` names it. With no vault here it makes one, or restores it from `recovery_key`; a
    /// key for another vault than the one held is refused. A new vault is kept before its `current`
    /// is saved; one that lost to another device's is removed again, and this device looks for the
    /// winner as at launch, with `notes` in its library. A vault this device syncs through a relay
    /// claims `current`, records the move, then leaves the moved marker there unless it is following
    /// one, so the relay's other devices stop rather than drift apart; a device that quits before it
    /// switches finishes the move when its engine finds that marker while `current` names the vault.
    /// A refused marker keeps this device on the relay with `current` still claimed, which a retry
    /// reuses; iCloud's own epoch makes the first connect upload all.
    pub(crate) fn use_icloud(
        &self,
        recovery_key: Option<&str>,
        notes: u64,
    ) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        if !self.kit.available() {
            return Err(cloudkit::error::UNAVAILABLE);
        }
        if recovery_key.is_some_and(|key| key.len() > MAX_RECOVERY_KEY) {
            return Err("E_SYNC_RECOVERY_FORMAT");
        }
        let named = recovery_key
            .map(Vault::from_recovery_key)
            .transpose()
            .map_err(|e| e.code())?;
        let held = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())?;
        if let (Some(held), Some(named)) = (&held, &named)
            && !held.same(named)
        {
            return Err("E_SYNC_VAULT_EXISTS");
        }
        current::ready(self.kit.as_ref())?;
        let _switching = self.switching.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        let vault = match (held, named) {
            (Some(held), _) => {
                self.claim(&held)?;
                self.leave_relay(&held)?;
                held
            }
            (None, Some(named)) => {
                self.belongs(&named)?;
                named
            }
            (None, None) => match self.claim_new(Vault::generate().map_err(|e| e.code())?)? {
                Some(vault) => vault,
                None => return self.icloud_look(notes),
            },
        };
        let vault = self.keep_icloud(vault, recovery_key.is_some())?;
        log::info!("I_SYNC_ICLOUD_USED vault={}", vault.id());
        Ok(self.changed())
    }

    /// Leaves the moved marker on the relay this device is enrolled on for `vault`. Nothing to leave
    /// when the vault is on iCloud already, the device is not enrolled, or it follows a marker.
    fn leave_relay(&self, vault: &Vault) -> Result<(), &'static str> {
        let following = self
            .status
            .lock()
            .is_ok_and(|s| s.code.as_deref() == Some(VAULT_MOVED));
        if self.on_icloud() || following {
            return Ok(());
        }
        let Ok(relay) = self.relay() else {
            return Ok(());
        };
        match self.credentials(&relay, vault) {
            Err("E_SYNC_NOT_ENROLLED") => return Ok(()),
            other => other?,
        };
        let id = vault.id().to_string();
        self.record_move(&id)?;
        self.with_connection(|connection| {
            self.keep_unseen(connection, &id);
            #[cfg(test)]
            if self.fails_marker.swap(false, Ordering::Relaxed) {
                return Err("E_TEST_MARKER");
            }
            moved::leave_relay(connection, vault)
        })
        .inspect_err(|code| {
            log::warn!("W_SYNC_MOVED_MARKER {code} vault={}", vault.id());
            if self.settings.update(SyncSettings::call_off_move).is_err() {
                log::warn!("W_SYNC_MOVE_RECORD vault={}", vault.id());
            }
        })?;
        log::info!("I_SYNC_MOVED_MARKER vault={} to=icloud", vault.id());
        Ok(())
    }

    /// Records that this device started moving `vault` to iCloud; '' records none.
    fn record_move(&self, vault: &str) -> Result<(), &'static str> {
        let mut settings = self.settings.get();
        if settings.moving == vault {
            return Ok(());
        }
        settings.moving = vault.to_string();
        self.settings.set(&settings)
    }

    /// The engine stopped on a moved marker. When this device started the move and quit before it
    /// switched, it switches now, as `use_icloud` would have, if `current` still names the vault.
    /// Otherwise (iCloud signed out, another Apple ID, a restored backup) it stays stopped, and
    /// Settings says the move started here so the owner finishes it.
    fn finish_started_move(&self) {
        let Ok(_switching) = self.switching.lock() else {
            log::warn!("W_SYNC_MOVE_UNFINISHED E_SYNC_INTERNAL");
            return;
        };
        let settings = self.settings.get();
        let Ok(vault) = self.held_vault() else {
            return;
        };
        let id = vault.id().to_string();
        if settings.moving != id || settings.icloud_for(&id).is_some() {
            return;
        }
        let finished = current::ready(self.kit.as_ref())
            .and_then(|()| self.named(&id))
            .and_then(|()| self.keep_icloud(vault, false));
        match finished {
            Ok(_) => {
                log::info!("I_SYNC_MOVE_FINISHED vault={id}");
                if let Ok(mut status) = self.status.lock() {
                    *status = StatusView {
                        state: "connecting".into(),
                        ..StatusView::default()
                    };
                }
            }
            Err(code) => log::warn!("W_SYNC_MOVE_UNFINISHED {code} vault={id}"),
        }
    }

    /// Whether `current` names `vault`; never saves it, so no vault goes to an Apple ID unasked.
    fn named(&self, vault: &str) -> Result<(), &'static str> {
        match current::read(self.kit.as_ref())? {
            Some(current) if current == vault => Ok(()),
            Some(_) => Err(OTHER_VAULT),
            None => Err(NO_VAULT),
        }
    }

    /// Saves `current` naming `vault` unless it names another, which this device never replaces.
    fn claim(&self, vault: &Vault) -> Result<(), &'static str> {
        match current::claim(self.kit.as_ref(), &vault.id().to_string())? {
            Claim::Won => Ok(()),
            Claim::Lost(_) => Err(OTHER_VAULT),
        }
    }

    /// Keeps a new `vault` in this device's own item, then saves `current` naming it, so `current`
    /// never names a vault no device holds. `None` when another vault won; the key is removed again.
    fn claim_new(&self, vault: Vault) -> Result<Option<Vault>, &'static str> {
        let kit = self.kit.as_ref();
        let vault = Vault::join(self.secrets.as_ref(), vault).map_err(|e| e.code())?;
        let id = vault.id().to_string();
        let failed = match current::claim(kit, &id) {
            Ok(Claim::Won) => return Ok(Some(vault)),
            Ok(Claim::Lost(_)) => None,
            // A save reported as failed may have been applied: the key goes only once `current`
            // is known to name another vault or none.
            Err(code) => match current::read(kit) {
                Ok(Some(current)) if current == id => return Ok(Some(vault)),
                Ok(_) => Some(code),
                Err(_) => return Err(code),
            },
        };
        Vault::delete(self.secrets.as_ref()).map_err(|e| {
            log::warn!("W_SYNC_VAULT_REMOVE {e} vault={id}");
            e.code()
        })?;
        failed.map_or(Ok(None), Err)
    }

    /// Whether this Apple ID syncs `vault`: `current` names it, or its zone is there from before
    /// `current` and it claims it now. Any other vault would start a second copy that never meets
    /// the first; with no `current` and no zone it is not on this Apple ID's iCloud.
    fn belongs(&self, vault: &Vault) -> Result<(), &'static str> {
        let kit = self.kit.as_ref();
        let id = vault.id().to_string();
        match current::read(kit)? {
            Some(current) if current == id => Ok(()),
            Some(_) => Err(OTHER_VAULT),
            None if current::zone_exists(kit, &vault_zone(&id))? => self.claim(vault),
            None => Err(NO_VAULT),
        }
    }

    /// Keeps `vault` in this device's own item (never replacing another), syncs it through iCloud,
    /// turns sync on and leaves it in the handover item. A vault `joined`, not made here, never
    /// shows its recovery key.
    fn keep_icloud(&self, vault: Vault, joined: bool) -> Result<Vault, &'static str> {
        #[cfg(test)]
        if self.quits_before_switch.swap(false, Ordering::Relaxed) {
            return Err("E_TEST_QUIT");
        }
        let vault = Vault::join(self.secrets.as_ref(), vault).map_err(|e| e.code())?;
        let vault_id = vault.id().to_string();
        self.disconnect();
        let mut settings = self.settings.get();
        if settings.icloud_for(&vault_id).is_none() {
            let mut state = ICloudState::new(&vault_id);
            state.relay_device = DeviceCredentials::load(self.secrets.as_ref())
                .ok()
                .flatten()
                .filter(|c| c.vault == vault_id)
                .map(|c| c.device)
                .unwrap_or_default();
            settings.icloud = Some(state);
        }
        settings.enabled = true;
        settings.icloud_declined.clear();
        settings.moving.clear();
        if joined {
            settings.recovery_shown = vault_id;
        }
        self.settings.set(&settings)?;
        self.hand_over(&vault);
        Ok(vault)
    }

    /// Leaves `vault`, which `current` names, in the handover item for this Apple ID's other
    /// devices. The device-only item is this device's copy, so a failure here is only logged.
    fn hand_over(&self, vault: &Vault) {
        let there = handover::read(self.handover.as_ref())
            .ok()
            .flatten()
            .is_some_and(|item| item.same(vault));
        if !there {
            self.write_handover(vault);
        }
    }

    /// At each connect, writes the item a first write left missing, and one naming another vault
    /// (or damaged) while `current` names this one. A later build's item is left as it is.
    fn hand_over_at_connect(&self, vault: &Vault) {
        let named = match handover::read(self.handover.as_ref()) {
            Ok(None) => return self.write_handover(vault),
            Ok(Some(item)) if item.same(vault) => return,
            Ok(Some(item)) => Some(item.id()),
            Err(super::SyncError::HandoverCorrupt) => None,
            Err(_) => return,
        };
        let id = vault.id().to_string();
        if current::read(self.kit.as_ref()).is_ok_and(|current| current.as_deref() == Some(&id)) {
            match named {
                Some(other) => log::info!("I_SYNC_HANDOVER_REWRITTEN item={other} vault={id}"),
                None => log::info!("I_SYNC_HANDOVER_REWRITTEN vault={id}"),
            }
            self.write_handover(vault);
        }
    }

    /// The device now signed in to another Apple ID takes the vault's item off this device, so its
    /// copy does not stay in that Apple ID's iCloud Keychain. An Apple ID whose `current` names the
    /// vault (or that cannot be read) keeps it: the item is its own. The device-only item stays.
    fn forget_handover(&self, vault: &Vault) {
        let id = vault.id().to_string();
        let elsewhere = current::read(self.kit.as_ref())
            .is_ok_and(|current| current.as_deref() != Some(id.as_str()));
        if !elsewhere {
            return;
        }
        match handover::remove(self.handover.as_ref(), vault) {
            Ok(true) => log::info!("I_SYNC_HANDOVER_REMOVED vault={id}"),
            Ok(false) => {}
            Err(e) => log::warn!("W_SYNC_HANDOVER_REMOVE {e} vault={id}"),
        }
    }

    fn write_handover(&self, vault: &Vault) {
        if let Err(e) = handover::write(self.handover.as_ref(), vault) {
            log::warn!("W_SYNC_HANDOVER_WRITE {e} vault={}", vault.id());
        }
    }

    /// Looks for the Apple ID's vault, as at launch and when the account changes. A device that
    /// holds no vault joins it on its own when the handover item names it and the library holds no
    /// `notes`; with notes it asks, once. Declined, or with no item, Settings offers the fallback.
    pub(crate) fn icloud_look(&self, notes: u64) -> Result<Snapshot, &'static str> {
        let view = match self.find() {
            Found::Held => return Ok(self.snapshot()),
            Found::View(view) => view,
            Found::Vault(vault) => {
                if self.settings.get().icloud_declined == vault.id().to_string() {
                    ICloudJoinView::is("declined")
                } else if notes > 0 {
                    ICloudJoinView {
                        notes: Some(notes),
                        ..ICloudJoinView::is("ask")
                    }
                } else {
                    let vault = self.keep_icloud(*vault, true)?;
                    log::info!("I_SYNC_JOINED vault={} via=keychain", vault.id());
                    ICloudJoinView::is("joined")
                }
            }
        };
        self.set_look(view);
        Ok(self.changed())
    }

    /// The owner's answer to the question `icloud_look` asked: join, or leave sync off and the offer
    /// in Settings. The item and `current` are read again, so the answer applies to the vault they
    /// name now.
    pub(crate) fn icloud_join(&self, accept: bool) -> Result<Snapshot, &'static str> {
        let vault = match self.find() {
            Found::Held => return Err("E_SYNC_VAULT_EXISTS"),
            Found::View(view) => {
                self.set_look(view);
                return Ok(self.changed());
            }
            Found::Vault(vault) => *vault,
        };
        let view = if accept {
            let vault = self.keep_icloud(vault, true)?;
            log::info!("I_SYNC_JOINED vault={} via=keychain", vault.id());
            ICloudJoinView::is("joined")
        } else {
            let mut settings = self.settings.get();
            settings.icloud_declined = vault.id().to_string();
            self.settings.set(&settings)?;
            log::info!("I_SYNC_ICLOUD_DECLINED vault={}", vault.id());
            ICloudJoinView::is("declined")
        };
        self.set_look(view);
        Ok(self.changed())
    }

    fn find(&self) -> Found {
        match Vault::load(self.secrets.as_ref()) {
            Ok(Some(_)) => return Found::Held,
            Ok(None) => {}
            Err(e) => return Found::View(ICloudJoinView::unavailable(e.code())),
        }
        if let Err(code) = self.licence.require() {
            return Found::View(ICloudJoinView::unavailable(code));
        }
        let kit = self.kit.as_ref();
        let current = match current::ready(kit).and_then(|()| current::read(kit)) {
            Ok(Some(current)) => current,
            Ok(None) => return Found::View(ICloudJoinView::is("none")),
            Err(code) => return Found::View(ICloudJoinView::unavailable(code)),
        };
        Found::View(match handover::read(self.handover.as_ref()) {
            Ok(Some(vault)) if vault.id().to_string() == current => {
                return Found::Vault(Box::new(vault));
            }
            Ok(Some(vault)) => {
                log::info!(
                    "I_SYNC_HANDOVER_OTHER item={} current={current}",
                    vault.id()
                );
                ICloudJoinView::fallback("otherVault", None)
            }
            Ok(None) => ICloudJoinView::fallback("missing", None),
            Err(e) => {
                log::warn!("W_SYNC_HANDOVER_UNREADABLE {e}");
                ICloudJoinView::fallback("unreadable", Some(e.code()))
            }
        })
    }

    fn set_look(&self, view: ICloudJoinView) {
        if let Ok(mut look) = self.look.lock() {
            *look = Some(view);
        }
    }

    /// When the owner chose to upload again after `E_SYNC_ICLOUD_DELETED`, or to move the vault
    /// into the Apple ID now signed in after `E_SYNC_ICLOUD_ACCOUNT_CHANGED`: `current` there names
    /// the vault (never replacing another), and the next connect makes its zone under a new epoch,
    /// so this device uploads everything.
    pub(crate) fn icloud_upload_again(&self) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        let vault = self.held_vault()?;
        let mut settings = self.settings.get();
        let state = settings
            .icloud
            .as_mut()
            .filter(|state| state.vault == vault.id().to_string())
            .ok_or("E_SYNC_ICLOUD_NOT_USED")?;
        current::ready(self.kit.as_ref())?;
        let account = cloudkit::account_of(self.kit.as_ref())?;
        let moved = !state.account.is_empty() && state.account != account;
        self.claim(&vault)?;
        state.account = account;
        state.zone_seen = false;
        state.subscribed = false;
        state.device_day = 0;
        self.settings.set(&settings)?;
        self.hand_over(&vault);
        self.disconnect();
        if moved {
            log::info!("I_SYNC_ICLOUD_MOVED_ACCOUNT vault={}", vault.id());
        } else {
            log::info!("I_SYNC_ICLOUD_UPLOAD_AGAIN vault={}", vault.id());
        }
        Ok(self.changed())
    }

    /// Leave This Vault (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md, Leaving
    /// the vault): removes the vault from this Apple ID, which is its membership. The vault's own
    /// recovery key confirms it; any other key, or the Apple ID not the one the vault syncs with,
    /// deletes nothing. Sync turns off, then the zones go, then the handover item, then this
    /// device's own item, so a failure part way keeps the key here and a retry ends the same. Notes
    /// stay on every device; the others find the zone gone and ask before uploading again.
    pub(crate) fn icloud_leave(&self, recovery_key: &str) -> Result<Snapshot, &'static str> {
        if recovery_key.len() > MAX_RECOVERY_KEY {
            return Err("E_SYNC_RECOVERY_FORMAT");
        }
        let vault = self.held_vault()?;
        let id = vault.id().to_string();
        let mut settings = self.settings.get();
        let account = settings
            .icloud_for(&id)
            .ok_or("E_SYNC_ICLOUD_NOT_USED")?
            .account
            .clone();
        let named = Vault::from_recovery_key(recovery_key).map_err(|e| e.code())?;
        if !named.same(&vault) {
            return Err(RECOVERY_OTHER_VAULT);
        }
        let kit = self.kit.as_ref();
        current::ready(kit)?;
        let signed_in = cloudkit::account_of(kit)?;
        if account.is_empty() {
            // Never connected, so no Apple ID is kept: `current` here must name the vault. This
            // Apple ID is kept now, so a retry after a failure part way is checked as any other.
            if current::read(kit)?.as_deref() != Some(id.as_str()) {
                return Err(NO_VAULT);
            }
            if let Some(state) = settings.icloud.as_mut().filter(|s| s.vault == id) {
                state.account = signed_in;
                self.settings.set(&settings)?;
            }
        } else if account != signed_in {
            return Err(cloudkit::error::ACCOUNT_CHANGED);
        }
        self.pairing_cancel();
        self.disconnect();
        if settings.enabled {
            settings.enabled = false;
            self.settings.set(&settings)?;
        }
        current::leave(kit, &id)?;
        handover::remove(self.handover.as_ref(), &vault).map_err(|e| {
            log::warn!("W_SYNC_HANDOVER_REMOVE {e} vault={id}");
            e.code()
        })?;
        Vault::delete(self.secrets.as_ref()).map_err(|e| {
            log::warn!("W_SYNC_VAULT_REMOVE {e} vault={id}");
            e.code()
        })?;
        let mut settings = self.settings.get();
        settings.icloud = None;
        settings.icloud_declined.clear();
        settings.unseen = None;
        self.settings.set(&settings)?;
        if let Ok(mut look) = self.look.lock() {
            *look = None;
        }
        log::info!("I_SYNC_ICLOUD_LEFT vault={id}");
        Ok(self.changed())
    }

    fn open(
        &self,
        relay: &RelayUrl,
        vault: &str,
        token: &str,
    ) -> Result<(Connection, Welcome), &'static str> {
        let emit = Arc::clone(&self.emit);
        let secrets = Arc::clone(&self.secrets);
        Connection::open(
            relay,
            vault,
            token,
            Box::new(move |event| match event {
                Event::Changed(seq) => emit(
                    SOCKET_EVENT,
                    json!({ "type": "changed", "cursor": client::cursor_of(seq) }),
                ),
                Event::Closed(code) => {
                    Self::refused(secrets.as_ref(), code);
                    log::info!("I_SYNC_CLOSED {code}");
                    emit(SOCKET_EVENT, json!({ "type": "closed", "code": code }));
                }
            }),
        )
    }

    fn live(&self) -> Result<LiveRef, &'static str> {
        let live = self.live.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        Ok(match live.as_ref().ok_or("E_SYNC_OFFLINE")? {
            Live::Relay { connection, vault } => {
                LiveRef::Relay(Arc::clone(connection), Arc::clone(vault))
            }
            Live::ICloud(icloud) => LiveRef::ICloud(Arc::clone(icloud)),
        })
    }

    fn live_relay(&self) -> Result<(Arc<Connection>, Arc<Vault>), &'static str> {
        match self.live()? {
            LiveRef::Relay(connection, vault) => Ok((connection, vault)),
            LiveRef::ICloud(_) => Err("E_SYNC_OFFLINE"),
        }
    }

    pub(crate) fn pull(&self, since: &str) -> Result<PullDto, &'static str> {
        match self.live()? {
            LiveRef::Relay(connection, vault) => {
                let page = client::pull(&connection, &vault, client::seq_of(since)?)?;
                Ok(PullDto {
                    records: page
                        .records
                        .into_iter()
                        .map(|r| {
                            pulled(
                                r.id,
                                r.version,
                                Some(r.seq),
                                String::new(),
                                r.kind,
                                r.plaintext,
                            )
                        })
                        .collect(),
                    next: client::cursor_of(page.next),
                    more: page.more,
                })
            }
            LiveRef::ICloud(icloud) => {
                let page = icloud.pull(since)?;
                Ok(PullDto {
                    records: page
                        .records
                        .into_iter()
                        .map(|r| pulled(r.id, r.version, None, r.tag, r.kind, r.plaintext))
                        .collect(),
                    next: page.next,
                    more: page.more,
                })
            }
        }
    }

    pub(crate) fn push(
        &self,
        id: &str,
        base: u64,
        data: &str,
        kind: &str,
        tag: &str,
    ) -> Result<PushDto, &'static str> {
        let plaintext = checked_item(id, base, data, kind)?;
        let (connection, vault) = match self.live()? {
            LiveRef::Relay(connection, vault) => (connection, vault),
            LiveRef::ICloud(icloud) => {
                let item = cloudkit::Item {
                    id,
                    base,
                    tag,
                    plaintext: &plaintext,
                    kind,
                };
                return match icloud.push_many(&[item], self.now()).pop() {
                    Some(cloudkit::PushAnswer::Failed(code)) => Err(code),
                    Some(answer) => Ok(push_dto(answer)),
                    None => Err("E_SYNC_INTERNAL"),
                };
            }
        };
        match client::push(&connection, &vault, id, base, &plaintext, kind) {
            Ok(client::PushReply::Pushed { version, seq }) => Ok(PushDto::Pushed {
                version,
                seq: Some(seq),
                tag: String::new(),
            }),
            Ok(client::PushReply::Rejected { version }) => Ok(PushDto::Rejected {
                version,
                tag: String::new(),
            }),
            Ok(client::PushReply::Full) => {
                log::info!("I_SYNC_ATTACHMENTS_FULL id={id}");
                Ok(PushDto::Full)
            }
            Ok(client::PushReply::Paused { until, limit }) => {
                log::info!(
                    "I_SYNC_QUOTA_PAUSED until={} limit={}",
                    until.unwrap_or(0),
                    limit.unwrap_or("unknown")
                );
                Ok(PushDto::Paused {
                    until,
                    limit,
                    code: None,
                })
            }
            Err("E_SYNC_TOO_LARGE") => {
                log::warn!("W_SYNC_TOO_LARGE id={id}");
                Err("E_SYNC_TOO_LARGE")
            }
            Err(code) => Err(code),
        }
    }

    /// A batch on iCloud, in modify operations within its caps; one answer per item, in order. The
    /// relay takes one push at a time, which the engine runs itself (`pushOneByOne`).
    pub(crate) fn push_many(&self, items: &[PushItemDto]) -> Result<Vec<PushDto>, &'static str> {
        if items.len() > MAX_BATCH {
            return Err("E_SYNC_BATCH_TOO_LARGE");
        }
        let total: usize = items.iter().map(|i| i.data.len()).sum();
        if total > MAX_RECORD_BYTES.div_ceil(3) * 4 {
            return Err("E_SYNC_BATCH_TOO_LARGE");
        }
        let LiveRef::ICloud(icloud) = self.live()? else {
            return Err("E_SYNC_BATCH_UNSUPPORTED");
        };
        // A tag that is not one (one kept from before a switch, say) fails its item alone.
        let checked: Vec<Result<Zeroizing<Vec<u8>>, &'static str>> = items
            .iter()
            .map(|i| {
                if crate::commands::sync::valid_tag(&i.tag) {
                    checked_item(&i.id, i.base, &i.data, &i.kind)
                } else {
                    Err(cloudkit::error::TAG_INVALID)
                }
            })
            .collect();
        let ready: Vec<cloudkit::Item<'_>> = items
            .iter()
            .zip(&checked)
            .filter_map(|(item, plaintext)| {
                Some(cloudkit::Item {
                    id: &item.id,
                    base: item.base,
                    tag: &item.tag,
                    plaintext: plaintext.as_ref().ok()?,
                    kind: &item.kind,
                })
            })
            .collect();
        let mut answers = icloud.push_many(&ready, self.now()).into_iter();
        Ok(checked
            .iter()
            .map(|plaintext| match plaintext {
                Err(code) => PushDto::Failed { code },
                Ok(_) => answers.next().map_or(
                    PushDto::Failed {
                        code: "E_SYNC_INTERNAL",
                    },
                    push_dto,
                ),
            })
            .collect())
    }

    pub(crate) fn disconnect(&self) {
        let live = self.live.lock().ok().and_then(|mut live| live.take());
        if let Some(Live::Relay { connection, .. }) = live {
            connection.close();
        }
    }

    /// A silent push said a watched zone changed: the engine pulls, as for a relay's `changed`.
    #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
    pub(crate) fn icloud_changed(&self) {
        if matches!(self.live(), Ok(LiveRef::ICloud(_))) {
            (self.emit)(SOCKET_EVENT, json!({ "type": "changed", "cursor": "" }));
        }
        let hosting = self
            .hosting
            .lock()
            .ok()
            .is_some_and(|hosting| hosting.as_ref().is_some_and(|h| h.icloud));
        if hosting {
            (self.emit)(PAIRING_EVENT, Value::Null);
        }
    }

    /// `CKAccountChanged`: the engine of a vault on iCloud looks at the account again.
    #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
    pub(crate) fn icloud_account_changed(&self) {
        let settings = self.settings.get();
        let on_icloud = Vault::load(self.secrets.as_ref())
            .ok()
            .flatten()
            .is_some_and(|vault| settings.icloud_for(&vault.id().to_string()).is_some());
        if settings.enabled && on_icloud {
            log::info!("I_SYNC_ICLOUD_ACCOUNT_CHANGED");
            self.disconnect();
            (self.emit)(SOCKET_EVENT, json!({ "type": "account" }));
        }
    }

    pub(crate) fn report(&self, status: StatusView) -> Result<(), &'static str> {
        let status = status.checked()?;
        let mut current = self.status.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        if *current == status {
            return Ok(());
        }
        let on_marker = status.state == "stopped" && status.code.as_deref() == Some(VAULT_MOVED);
        *current = status;
        drop(current);
        if on_marker {
            self.finish_started_move();
        }
        self.changed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_a_quota_pause_to_the_engine_with_its_reset_and_limit() {
        let paused = PushDto::Paused {
            until: Some(1_793_145_600_000),
            limit: Some("storedBytes"),
            code: None,
        };
        assert_eq!(
            serde_json::to_value(paused).unwrap(),
            json!({ "type": "paused", "until": 1_793_145_600_000_i64, "limit": "storedBytes" })
        );
    }

    #[test]
    fn hands_the_relay_s_seq_to_the_engine_as_an_opaque_cursor_and_takes_it_back() {
        let page = PullDto {
            records: vec![],
            next: client::cursor_of(42),
            more: false,
        };
        assert_eq!(
            serde_json::to_value(page).unwrap(),
            json!({ "records": [], "next": "42", "more": false })
        );
        let start = PullDto {
            records: vec![],
            next: client::cursor_of(0),
            more: false,
        };
        assert_eq!(serde_json::to_value(start).unwrap()["next"], json!(""));
        assert_eq!(client::seq_of(""), Ok(0));
        assert_eq!(client::seq_of("0"), Ok(0));
        assert_eq!(client::seq_of("42"), Ok(42));
        for bad in ["-1", "4 2", "tok_1", "1e3", "99999999999999999"] {
            assert_eq!(client::seq_of(bad), Err("E_SYNC_CURSOR_INVALID"), "{bad}");
        }
        let rejected = PushDto::Rejected {
            version: 3,
            tag: String::new(),
        };
        assert_eq!(
            serde_json::to_value(rejected).unwrap(),
            json!({ "type": "rejected", "version": 3, "tag": "" })
        );
    }

    #[test]
    fn takes_a_status_only_with_a_known_state_and_a_code() {
        let ok = StatusView {
            state: "paused".into(),
            last_sync: Some(5),
            code: Some("E_SYNC_QUOTA".into()),
            too_large: 1,
            paused_until: Some(1_793_145_600_000),
            upload: Some(UploadView { sent: 3, total: 9 }),
            relay_outdated: true,
            unsynced_files: Some(UnsyncedView {
                count: 2,
                code: "E_SYNC_ATTACHMENTS_FULL".into(),
            }),
            skipped: 3,
        };
        assert!(ok.clone().checked().is_ok());
        let older: StatusView = serde_json::from_value(json!({
            "state": "idle", "lastSync": null, "code": null, "tooLarge": 0
        }))
        .unwrap();
        assert_eq!(older.upload, None);
        for bad in [
            StatusView {
                state: "weird".into(),
                ..ok.clone()
            },
            StatusView {
                code: Some("a note title".into()),
                ..ok.clone()
            },
            StatusView {
                last_sync: Some(-1),
                ..ok.clone()
            },
            StatusView {
                paused_until: Some(-1),
                ..ok.clone()
            },
            StatusView {
                upload: Some(UploadView { sent: 10, total: 9 }),
                ..ok.clone()
            },
            StatusView {
                unsynced_files: Some(UnsyncedView {
                    count: 1,
                    code: "a note title".into(),
                }),
                ..ok.clone()
            },
        ] {
            assert_eq!(bad.checked(), Err("E_SYNC_STATUS_INVALID"));
        }
    }
}
