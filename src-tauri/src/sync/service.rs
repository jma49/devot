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

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::client::{Connection, RelayUrl};
use super::cloudkit::{self, CloudKit, ICloud, Staging};
use super::handover;
use super::keychain::SyncedKeychain;
use super::settings::{DeviceCredentials, SettingsStore};
use super::{SecretStore, Vault};
use crate::licence::Gate;
use pairing_code::Hosting;
use rotation::VAULT_ROTATED;

mod connection;
mod devices;
mod enrollment;
mod icloud_join;
mod icloud_move;
mod icloud_rotation;
mod leave;
mod pairing_code;
mod records;
mod rotation;
mod views;

pub(crate) use views::{
    Connected, Created, ICloudJoinView, ICloudView, PairingCheck, PairingView, PullDto, PulledDto,
    PushDto, PushItemDto, SettingsPatch, Snapshot, StatusView,
};

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

pub(crate) type Emit = Arc<dyn Fn(&'static str, Value) + Send + Sync>;
pub(crate) type Secrets = Arc<dyn SecretStore + Send + Sync>;

enum Live {
    Relay {
        connection: Arc<Connection>,
        vault: Arc<Vault>,
    },
    ICloud(Arc<ICloud>),
}

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
    /// Held through a connect and a leave, so a connect under way keeps nothing of a vault left.
    /// Taken before `switching`.
    membership: Mutex<()>,
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
    /// Fails the next retire of a rotation as if the app quit just before it.
    #[cfg(test)]
    quits_before_retire: std::sync::atomic::AtomicBool,
    /// Fails the next device list of a retired vault as if the relay could not be reached.
    #[cfg(test)]
    fails_retired_list: std::sync::atomic::AtomicBool,
    /// Holds the next connect once it has the vault and the token, until the test lets it go.
    #[cfg(test)]
    pauses_connect: Mutex<Option<ConnectPause>>,
    /// Fails an iCloud rotation at this step as if the app quit just before it.
    #[cfg(test)]
    quits_at: Mutex<Option<&'static str>>,
}

#[cfg(test)]
type ConnectPause = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);

const MAX_SAFE: u64 = 9_007_199_254_740_991;

enum LiveRef {
    Relay(Arc<Connection>, Arc<Vault>),
    ICloud(Arc<ICloud>),
}

/// The relay's secret as entered, trimmed; it only ever goes into the request that creates a vault.
fn checked_relay_secret(relay_secret: &str) -> Result<Zeroizing<String>, &'static str> {
    let relay_secret = Zeroizing::new(relay_secret.trim().to_string());
    if relay_secret.is_empty()
        || relay_secret.len() > MAX_RELAY_SECRET
        || relay_secret.chars().any(char::is_control)
    {
        return Err("E_SYNC_RELAY_SECRET_INVALID");
    }
    Ok(relay_secret)
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
            membership: Mutex::new(()),
            shifted: AtomicI64::new(0),
            #[cfg(test)]
            quits_before_switch: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fails_device_list: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fails_marker: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            quits_before_retire: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fails_retired_list: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            pauses_connect: Mutex::new(None),
            #[cfg(test)]
            quits_at: Mutex::new(None),
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

    #[cfg(test)]
    pub(crate) fn quit_before_next_retire(&self) {
        self.quits_before_retire.store(true, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_retired_list(&self) {
        self.fails_retired_list.store(true, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn quit_icloud_rotation_at(&self, step: &'static str) {
        *self.quits_at.lock().unwrap() = Some(step);
    }

    /// Returns where the next connect says it paused, and where the test lets it go on.
    #[cfg(test)]
    pub(crate) fn pause_next_connect(
        &self,
    ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (paused, on_pause) = std::sync::mpsc::channel();
        let (go, on_go) = std::sync::mpsc::channel();
        *self.pauses_connect.lock().unwrap() = Some((paused, on_go));
        (on_pause, go)
    }

    #[cfg(test)]
    fn wait_if_paused(&self) {
        let pause = self.pauses_connect.lock().unwrap().take();
        if let Some((paused, go)) = pause {
            paused.send(()).unwrap();
            go.recv().unwrap();
        }
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
        let rotated = vault
            .as_ref()
            .is_some_and(|vault| settings.successor_of(&vault.id().to_string()).is_some());
        Snapshot {
            relay_url: settings.relay_url,
            enabled: settings.enabled,
            transport,
            vault: vault.is_some(),
            enrolled,
            status: self.status.lock().map(|s| s.clone()).unwrap_or_default(),
            icloud_join: self.look.lock().ok().and_then(|look| look.clone()),
            move_started,
            rotated,
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

    /// Whether this device's vault syncs through iCloud.
    fn on_icloud(&self) -> bool {
        let settings = self.settings.get();
        Vault::load(self.secrets.as_ref())
            .ok()
            .flatten()
            .is_some_and(|vault| settings.icloud_for(&vault.id().to_string()).is_some())
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
    use super::super::client;
    use super::views::{UnsyncedView, UploadView};
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
