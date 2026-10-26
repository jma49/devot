//! Sync as the windows see it: Settings > Sync (the relay's URL, on or off, creating the vault on
//! the first device, pairing and joining, the devices, the status) and the main window's core
//! worker, whose engine (src/core/sync) connects, pulls and pushes through these commands. Keys,
//! the device token and the socket stay here; plaintext records cross as base64.
//!
//! Joining (a pairing code or the recovery key) enrolls the device and then keeps the vault in the
//! keychain; a device that holds the vault key and no token for the relay also enrolls on its own
//! when it connects, unless it was removed from that vault.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::client::{self, Connection, DeviceInfo, Event, PairingState, RelayUrl, Welcome};
use super::pairing::{self, Pairing, Qr};
use super::settings::{DeviceCredentials, SettingsStore};
use super::{MAX_RECORD_BYTES, SecretStore, Vault};
use crate::licence::Gate;

pub(crate) const CHANGED_EVENT: &str = "devot://sync-changed";
pub(crate) const SOCKET_EVENT: &str = "devot://sync-event";
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
}

impl Default for StatusView {
    fn default() -> Self {
        Self {
            state: "off".into(),
            last_sync: None,
            code: None,
            too_large: 0,
        }
    }
}

impl StatusView {
    fn checked(self) -> Result<Self, &'static str> {
        let code_ok = self.code.as_deref().is_none_or(crate::logs::is_code);
        let time_ok = self.last_sync.is_none_or(|t| t >= 0);
        if !STATES.contains(&self.state.as_str()) || !code_ok || !time_ok {
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
    /// The keychain holds a vault key.
    pub vault: bool,
    /// This device has a token for the relay set and that vault.
    pub enrolled: bool,
    pub status: StatusView,
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
    pub seq: u64,
    pub kind: String,
    pub data: Option<String>,
    pub error: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullDto {
    pub records: Vec<PulledDto>,
    pub next: u64,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum PushDto {
    Pushed { version: u64, seq: u64 },
    Rejected { version: u64 },
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
    relay: RelayUrl,
    vault: String,
    token: Zeroizing<String>,
    expires: i64,
    taken: AtomicBool,
}

pub(crate) type Emit = Arc<dyn Fn(&'static str, Value) + Send + Sync>;
pub(crate) type Secrets = Arc<dyn SecretStore + Send + Sync>;

struct Live {
    connection: Arc<Connection>,
    vault: Arc<Vault>,
}

pub(crate) struct SyncService {
    settings: SettingsStore,
    secrets: Secrets,
    live: Mutex<Option<Live>>,
    status: Mutex<StatusView>,
    emit: Emit,
    licence: Gate,
    hosting: Mutex<Option<Arc<Hosting>>>,
    /// Moves this service's clock in tests of expiry.
    shifted: AtomicI64,
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;

impl SyncService {
    pub(crate) fn new(
        settings: SettingsStore,
        secrets: Secrets,
        emit: Emit,
        licence: Gate,
    ) -> Self {
        Self {
            settings,
            secrets,
            live: Mutex::new(None),
            status: Mutex::new(StatusView::default()),
            emit,
            licence,
            hosting: Mutex::new(None),
            shifted: AtomicI64::new(0),
        }
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
        Snapshot {
            relay_url: settings.relay_url,
            enabled: settings.enabled,
            vault: vault.is_some(),
            enrolled,
            status: self.status.lock().map(|s| s.clone()).unwrap_or_default(),
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
            }
            settings.relay_url = url;
        }
        if let Some(enabled) = patch.enabled {
            if !enabled {
                self.disconnect();
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
        Ok((!shown && self.snapshot().enrolled).then(|| vault.recovery_key()))
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
    /// (docs/adr/0008-sync-device-pairing.md). A code shown before is closed.
    pub(crate) fn pairing_open(&self) -> Result<PairingView, &'static str> {
        self.licence.require()?;
        let relay = self.relay()?;
        let vault = self.held_vault()?;
        let credentials = self.credentials(&relay, &vault)?;
        self.pairing_cancel();
        let pairing = Pairing::generate().map_err(|e| e.code())?;
        let expires = self.now().saturating_add(pairing::TTL_MS);
        let offer = pairing.seal_offer(&vault, expires).map_err(|e| e.code())?;
        let vault_id = vault.id().to_string();
        let token = Zeroizing::new(credentials.token);
        client::pairing_open(&relay, &vault_id, &token, pairing.id(), &offer)?;
        let link = pairing.link(&relay);
        let view = PairingView {
            code: pairing.code().to_string(),
            link: link.to_string(),
            qr: pairing::qr(&link)?,
            expires,
        };
        log::info!(
            "I_SYNC_PAIRING_OPEN vault={vault_id} pairing={}",
            pairing.id()
        );
        *self.hosting.lock().map_err(|_| "E_SYNC_INTERNAL")? = Some(Arc::new(Hosting {
            pairing,
            relay,
            vault: vault_id,
            token,
            expires,
            taken: AtomicBool::new(false),
        }));
        Ok(view)
    }

    /// Asks the relay how the pairing on show is going. A confirmation counts only when it opens
    /// under the code's key; then the pairing is closed.
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
        let state = client::pairing_status(
            &hosting.relay,
            &hosting.vault,
            &hosting.token,
            hosting.pairing.id(),
        );
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

    /// Closes the pairing on show, on the relay too when it answers.
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
        let closed = client::pairing_close(
            &hosting.relay,
            &hosting.vault,
            &hosting.token,
            hosting.pairing.id(),
        );
        if let Err(code) = closed
            && code != "E_SYNC_PAIRING_GONE"
        {
            log::warn!("W_SYNC_PAIRING_CLOSE {code}");
        }
    }

    /// Joins the vault a pairing code (or the link its QR code holds) hands over: takes the offer,
    /// enrolls this device, keeps the vault and confirms to the device that shows the code. A link
    /// must name the relay set in Settings: the page asks before it sets a relay from a link.
    pub(crate) fn join_with_code(&self, text: &str) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        let entered = pairing::read(text).map_err(|e| e.code())?;
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
        let offer = client::pairing_take(&relay, pairing.id())?;
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
            .and_then(|proof| client::pairing_confirm(&relay, pairing.id(), &proof));
        if let Err(code) = confirmed {
            log::warn!("W_SYNC_PAIRING_CONFIRM {code} pairing={}", pairing.id());
        }
        log::info!("I_SYNC_JOINED vault={} device={device}", vault.id());
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
        if let Ok((connection, _)) = self.live() {
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

    /// The vault's devices. Not gated by the licence: seeing and removing access never is.
    pub(crate) fn devices(&self) -> Result<Vec<DeviceInfo>, &'static str> {
        self.with_connection(client::devices)
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

    pub(crate) fn connect(&self) -> Result<Welcome, &'static str> {
        let settings = self.settings.get();
        if !settings.enabled {
            return Err("E_SYNC_OFF");
        }
        // A device that already syncs stops here, at its next connect.
        self.licence.require()?;
        let relay = self.relay()?;
        let vault = Vault::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .ok_or("E_SYNC_NO_VAULT_KEY")?;
        let vault_id = vault.id().to_string();
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
        *self.live.lock().map_err(|_| "E_SYNC_INTERNAL")? = Some(Live {
            connection: Arc::new(connection),
            vault: Arc::new(vault),
        });
        Ok(welcome)
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
                Event::Changed(seq) => emit(SOCKET_EVENT, json!({ "type": "changed", "seq": seq })),
                Event::Closed(code) => {
                    Self::refused(secrets.as_ref(), code);
                    log::info!("I_SYNC_CLOSED {code}");
                    emit(SOCKET_EVENT, json!({ "type": "closed", "code": code }));
                }
            }),
        )
    }

    fn live(&self) -> Result<(Arc<Connection>, Arc<Vault>), &'static str> {
        let live = self.live.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        let live = live.as_ref().ok_or("E_SYNC_OFFLINE")?;
        Ok((Arc::clone(&live.connection), Arc::clone(&live.vault)))
    }

    pub(crate) fn pull(&self, since: u64) -> Result<PullDto, &'static str> {
        let (connection, vault) = self.live()?;
        let page = client::pull(&connection, &vault, since)?;
        Ok(PullDto {
            records: page
                .records
                .into_iter()
                .map(|record| {
                    let (data, error) = match record.plaintext {
                        Ok(bytes) => (Some(STANDARD.encode(bytes.as_slice())), None),
                        Err(code) => {
                            if record.kind == "record" {
                                log::warn!("W_SYNC_RECORD_UNREADABLE {code} id={}", record.id);
                            }
                            (None, Some(code))
                        }
                    };
                    PulledDto {
                        id: record.id,
                        version: record.version,
                        seq: record.seq,
                        kind: record.kind,
                        data,
                        error,
                    }
                })
                .collect(),
            next: page.next,
            more: page.more,
        })
    }

    pub(crate) fn push(&self, id: &str, base: u64, data: &str) -> Result<PushDto, &'static str> {
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
        let (connection, vault) = self.live()?;
        match client::push(&connection, &vault, id, base, &plaintext) {
            Ok(client::Pushed::Pushed { version, seq }) => Ok(PushDto::Pushed { version, seq }),
            Ok(client::Pushed::Rejected { version }) => Ok(PushDto::Rejected { version }),
            Err("E_SYNC_TOO_LARGE") => {
                log::warn!("W_SYNC_TOO_LARGE id={id}");
                Err("E_SYNC_TOO_LARGE")
            }
            Err(code) => Err(code),
        }
    }

    pub(crate) fn disconnect(&self) {
        let live = self.live.lock().ok().and_then(|mut live| live.take());
        if let Some(live) = live {
            live.connection.close();
        }
    }

    pub(crate) fn report(&self, status: StatusView) -> Result<(), &'static str> {
        let status = status.checked()?;
        let mut current = self.status.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        if *current == status {
            return Ok(());
        }
        *current = status;
        drop(current);
        self.changed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_status_only_with_a_known_state_and_a_code() {
        let ok = StatusView {
            state: "stopped".into(),
            last_sync: Some(5),
            code: Some("E_SYNC_REVOKED".into()),
            too_large: 1,
        };
        assert!(ok.clone().checked().is_ok());
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
        ] {
            assert_eq!(bad.checked(), Err("E_SYNC_STATUS_INVALID"));
        }
    }
}
