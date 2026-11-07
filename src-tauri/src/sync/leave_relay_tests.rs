//! Leaving a relay vault against the Node relay: the device forgets the key and its token, keeps
//! its notes, and can join a vault again, uploading its whole library there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use zeroize::Zeroizing;

use super::relay_tests::{NodeRelay, SECRET, Secrets};
use super::service::{CHANGED_EVENT, SettingsPatch, SyncService};
use super::settings::{DeviceCredentials, FILE, SettingsStore};
use super::{SecretStore, SyncError, Vault};
use crate::licence::Gate;

const ROTATED: &str = "E_SYNC_VAULT_ROTATED";
const ACCOUNTS: [&str; 4] = ["vault", "vault-next", "device", "device-next"];

struct Device {
    service: SyncService,
    secrets: Arc<Secrets>,
    dir: tempfile::TempDir,
}

impl Device {
    fn at(relay: &NodeRelay) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let secrets: Arc<Secrets> = Arc::default();
        let service = SyncService::new(
            SettingsStore::new(&dir.path().join(FILE)),
            secrets.clone(),
            Arc::new(|_, _| ()),
            Gate::open(),
        );
        service
            .set(SettingsPatch {
                relay_url: Some(relay.url.as_str().to_string()),
                enabled: None,
            })
            .unwrap();
        Self {
            service,
            secrets,
            dir,
        }
    }

    fn first(relay: &NodeRelay) -> Self {
        let device = Self::at(relay);
        device.service.create_vault(SECRET).unwrap();
        device.service.recovery_saved().unwrap();
        device
    }

    fn paired(relay: &NodeRelay, with: &Device) -> Self {
        let device = Self::at(relay);
        device.join(with).unwrap();
        device
    }

    fn join(&self, with: &Device) -> Result<(), &'static str> {
        let code = with.service.pairing_open().unwrap().code;
        let joined = self.service.join_with_code(&code).map(|_| ());
        with.service.pairing_cancel();
        joined
    }

    fn vault_id(&self) -> String {
        Vault::load(self.secrets.as_ref())
            .unwrap()
            .unwrap()
            .id()
            .to_string()
    }

    fn device_id(&self) -> String {
        DeviceCredentials::load(self.secrets.as_ref())
            .unwrap()
            .unwrap()
            .device
    }

    fn epoch(&self) -> String {
        let epoch = self.service.connect(false).unwrap().relay().epoch;
        self.service.disconnect();
        epoch
    }

    fn settings_text(&self) -> String {
        std::fs::read_to_string(self.dir.path().join(FILE)).unwrap()
    }

    fn holds(&self, account: &str) -> bool {
        self.secrets.read(account).unwrap().is_some()
    }
}

#[test]
fn a_device_removed_before_a_rotation_leaves_and_joins_the_successor_with_a_code() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let before = phone.epoch();
    mac.service.remove_device(&phone.device_id()).unwrap();
    mac.service.rotate_vault(SECRET).unwrap();
    assert_eq!(
        phone.service.connect(false).err(),
        Some("E_SYNC_UNAUTHORIZED")
    );
    assert_eq!(phone.service.connect(false).err(), Some("E_SYNC_REVOKED"));
    assert_eq!(
        phone.join(&mac).err(),
        Some("E_SYNC_VAULT_EXISTS"),
        "a revoked token cannot learn the successor, so the held vault stays in the way"
    );

    let left = phone.service.leave_vault().unwrap();
    assert!(!left.vault && !left.enrolled && !left.enabled && !left.rotated);
    assert_eq!(left.relay_url, relay.url.as_str(), "the relay stays set");
    for account in ACCOUNTS {
        assert!(!phone.holds(account), "{account} is forgotten");
    }

    phone.join(&mac).unwrap();
    assert_eq!(phone.vault_id(), mac.vault_id());
    assert_ne!(phone.epoch(), before, "the whole library goes up again");
}

#[test]
fn a_device_that_found_its_vault_retired_forgets_the_successor_it_recorded() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let old = phone.vault_id();
    mac.service.rotate_vault(SECRET).unwrap();
    assert_eq!(phone.service.connect(false).err(), Some(ROTATED));
    assert!(phone.settings_text().contains("rotated"));

    let left = phone.service.leave_vault().unwrap();
    assert!(!left.vault && !left.rotated);
    let settings = phone.settings_text();
    assert!(!settings.contains("rotated") && !settings.contains(&old));
    assert_eq!(phone.service.connect(false).err(), Some("E_SYNC_OFF"));
    let unrelated = Device::first(&relay);
    phone.join(&unrelated).unwrap();
    assert_eq!(
        phone.vault_id(),
        unrelated.vault_id(),
        "with no vault held, any vault can be joined"
    );
}

#[test]
fn leaving_drops_a_rotation_part_way_and_leaves_the_relay_and_the_other_devices_alone() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let vault = mac.vault_id();
    let own = mac.device_id();
    mac.service.quit_before_next_retire();
    assert_eq!(
        mac.service.rotate_vault(SECRET).err(),
        Some("E_SYNC_OFFLINE")
    );
    assert!(mac.holds("vault-next") && mac.holds("device-next"));

    let left = mac.service.leave_vault().unwrap();
    assert!(!left.vault && !left.enabled);
    for account in ACCOUNTS {
        assert!(!mac.holds(account), "{account} is forgotten");
    }
    let settings = mac.settings_text();
    assert!(!settings.contains("rotating"));
    assert!(
        !settings.contains(&vault),
        "the record that the recovery key was saved goes with the vault"
    );
    assert_eq!(mac.service.leave_vault().err(), Some("E_SYNC_NO_VAULT_KEY"));

    // Nothing changed on the relay: the phone syncs on, and the Mac is still among its devices.
    phone.service.connect(false).unwrap();
    phone.service.disconnect();
    assert!(phone.service.devices().unwrap().iter().any(|d| d.id == own));
    assert_eq!(phone.vault_id(), vault);

    mac.join(&phone).unwrap();
    assert!(
        mac.service.recovery_key().unwrap().is_none(),
        "a device that joins again knows the key it joined with, so it is not offered again"
    );
}

#[test]
fn a_connect_under_way_when_the_device_leaves_keeps_nothing_of_the_vault() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let (paused, go) = phone.service.pause_next_connect();
    std::thread::scope(|threads| {
        let connect = threads.spawn(|| phone.service.connect(false).map(drop));
        paused.recv().unwrap();
        let leave = threads.spawn(|| phone.service.leave_vault().map(drop));
        std::thread::sleep(Duration::from_millis(200));
        let waited = !leave.is_finished();
        go.send(()).unwrap();
        assert_eq!(connect.join().unwrap(), Ok(()));
        assert_eq!(leave.join().unwrap(), Ok(()));
        assert!(waited, "the leave waits for the connect");
    });
    for account in ACCOUNTS {
        assert!(!phone.holds(account), "{account} is forgotten");
    }
    assert_eq!(
        phone.service.pull("").err(),
        Some("E_SYNC_OFFLINE"),
        "the connection that connect opened is closed"
    );
    assert_eq!(phone.service.connect(false).err(), Some("E_SYNC_OFF"));
}

#[test]
fn a_device_that_leaves_and_joins_the_same_vault_uploads_its_whole_library_again() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let before = phone.epoch();
    phone.service.leave_vault().unwrap();
    phone.join(&mac).unwrap();
    let after = phone.epoch();
    assert_ne!(after, before);
    assert_eq!(
        phone.epoch(),
        after,
        "the new epoch holds until the next leave"
    );
}

/// A keychain whose first removal of the vault item fails.
#[derive(Default)]
struct KeepsTheVaultOnce {
    items: Secrets,
    failed: AtomicBool,
}

impl SecretStore for KeepsTheVaultOnce {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
        self.items.read(account)
    }

    fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError> {
        self.items.add(account, secret)
    }

    fn replace(&self, account: &str, secret: &[u8]) -> Result<(), SyncError> {
        self.items.replace(account, secret)
    }

    fn remove(&self, account: &str) -> Result<bool, SyncError> {
        if account == "vault" && !self.failed.swap(true, Ordering::SeqCst) {
            return Err(SyncError::Keychain(-25308));
        }
        self.items.remove(account)
    }
}

#[test]
fn a_leave_that_failed_part_way_keeps_the_key_and_is_retried_to_the_same_end() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let dir = tempfile::tempdir().unwrap();
    let store: Arc<KeepsTheVaultOnce> = Arc::default();
    let sent: Arc<Mutex<Vec<Value>>> = Arc::default();
    let emitted = Arc::clone(&sent);
    let phone = SyncService::new(
        SettingsStore::new(&dir.path().join(FILE)),
        store.clone(),
        Arc::new(move |event, payload| {
            if event == CHANGED_EVENT {
                emitted.lock().unwrap().push(payload);
            }
        }),
        Gate::open(),
    );
    phone
        .set(SettingsPatch {
            relay_url: Some(relay.url.as_str().to_string()),
            enabled: None,
        })
        .unwrap();
    let code = mac.service.pairing_open().unwrap().code;
    phone.join_with_code(&code).unwrap();

    assert_eq!(phone.leave_vault().err(), Some("E_SYNC_KEYCHAIN"));
    let stopped = phone.snapshot();
    assert!(
        stopped.vault && !stopped.enabled,
        "sync is off and the key stays"
    );
    assert_eq!(phone.connect(false).err(), Some("E_SYNC_OFF"));
    let last = sent.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        last["enabled"],
        Value::Bool(false),
        "the windows hear that sync is off"
    );
    assert_eq!(last["vault"], Value::Bool(true));

    let left = phone.leave_vault().unwrap();
    assert!(!left.vault && !left.enabled);
    for account in ACCOUNTS {
        assert!(
            store.read(account).unwrap().is_none(),
            "{account} is forgotten"
        );
    }
}
