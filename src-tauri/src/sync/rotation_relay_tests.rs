//! Rotating a relay vault's key against the Node relay (docs/adr/0017-sync-key-rotation.md): the
//! old key opens nothing new, the devices the owner keeps join the successor, and a rotation that
//! stops part way or races another ends with one successor.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;

use super::client::{self, Connection};
use super::relay_tests::{NodeRelay, RECORD, SECRET, Secrets};
use super::service::{PushDto, SettingsPatch, SyncService};
use super::settings::{DeviceCredentials, FILE, SettingsStore};
use super::{SecretStore, Vault};
use crate::licence::Gate;

const ROTATED: &str = "E_SYNC_VAULT_ROTATED";

struct Device {
    service: SyncService,
    secrets: Arc<Secrets>,
    _dir: tempfile::TempDir,
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
            _dir: dir,
        }
    }

    fn first(relay: &NodeRelay) -> Self {
        let device = Self::at(relay);
        device.service.create_vault(SECRET).unwrap();
        device.service.recovery_saved().unwrap();
        device
    }

    /// A device paired with `with`, enrolled in its vault.
    fn paired(relay: &NodeRelay, with: &Device) -> Self {
        let device = Self::at(relay);
        let code = with.service.pairing_open().unwrap().code;
        device.service.join_with_code(&code).unwrap();
        device
    }

    fn vault(&self) -> Vault {
        Vault::load(self.secrets.as_ref()).unwrap().unwrap()
    }

    fn token(&self) -> String {
        DeviceCredentials::load(self.secrets.as_ref())
            .unwrap()
            .unwrap()
            .token
    }

    fn settings_text(&self) -> String {
        std::fs::read_to_string(self._dir.path().join(FILE)).unwrap()
    }

    fn holds(&self, account: &str) -> bool {
        self.secrets.read(account).unwrap().is_some()
    }
}

fn data() -> String {
    STANDARD.encode(b"a note's record")
}

#[test]
fn a_rotation_locks_the_old_key_out_and_the_kept_devices_join_the_successor() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let lost = Device::paired(&relay, &mac);
    let old = mac.vault();
    let old_id = old.id().to_string();
    let old_recovery = old.recovery_key();
    let lost_token = lost.token();

    let rotated = mac.service.rotate_vault(SECRET).unwrap();
    let new = mac.vault();
    let new_id = new.id().to_string();
    assert_ne!(new_id, old_id);
    assert!(rotated.snapshot.vault && rotated.snapshot.enrolled && !rotated.snapshot.rotated);
    let new_recovery = rotated.recovery_key.expect("the new recovery key is shown");
    assert_ne!(new_recovery.as_str(), old_recovery.as_str());
    assert!(!mac.holds("vault-next") && !mac.holds("device-next"));

    // The lost device, which still holds the old key and a token nobody revoked, gets nothing new.
    let (socket, welcome) =
        Connection::open(&relay.url, &old_id, &lost_token, Box::new(|_| ())).unwrap();
    assert_eq!(welcome.retired.as_deref(), Some(new_id.as_str()));
    let push = client::push(&socket, &old, RECORD, 0, b"a note's record", "record");
    assert_eq!(push.err(), Some(ROTATED));
    assert_eq!(client::pull(&socket, &old, 0).err(), Some(ROTATED));
    socket.close();
    assert_eq!(
        client::enroll(&relay.url, &old, "again").err(),
        Some(ROTATED)
    );
    assert_eq!(lost.service.connect(false).err(), Some(ROTATED));
    let stranger = Device::at(&relay);
    assert_eq!(
        stranger.service.join_with_recovery(&old_recovery).err(),
        Some(ROTATED)
    );
    assert!(!stranger.holds("vault"), "a refused join keeps nothing");

    // The successor syncs; the old key's enrollment secret does not open it.
    mac.service.connect(false).unwrap();
    assert!(matches!(
        mac.service.push(RECORD, 0, &data(), "record", ""),
        Ok(PushDto::Pushed { version: 1, .. })
    ));
    let posing = Vault::from_parts(new.id(), zeroize::Zeroizing::new(*old.key()));
    assert_eq!(
        client::enroll(&relay.url, &posing, "thief").err(),
        Some("E_SYNC_ENROLL_DENIED")
    );

    // The phone learns of the rotation, shows no code for the old vault and joins with a code.
    assert_eq!(phone.service.connect(false).err(), Some(ROTATED));
    assert!(phone.service.snapshot().rotated);
    assert_eq!(phone.service.pairing_open().err(), Some(ROTATED));
    let code = mac.service.pairing_open().unwrap().code;
    let joined = phone.service.join_with_code(&code).unwrap();
    assert!(joined.enrolled && !joined.rotated);
    assert_eq!(phone.vault().id().to_string(), new_id);
    let welcome = phone.service.connect(false).unwrap().relay();
    let page = phone
        .service
        .pull(&client::cursor_of(welcome.seq.saturating_sub(1)))
        .unwrap();
    assert_eq!(page.records[0].data.as_deref(), Some(data().as_str()));
    mac.service.disconnect();
    phone.service.disconnect();
}

#[test]
fn a_device_of_the_retired_vault_joins_with_the_new_recovery_key_and_no_other() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let unrelated = Vault::generate().unwrap();
    let recovery = mac
        .service
        .rotate_vault(SECRET)
        .unwrap()
        .recovery_key
        .unwrap();

    assert_eq!(
        phone
            .service
            .join_with_recovery(&unrelated.recovery_key())
            .err(),
        Some("E_SYNC_VAULT_EXISTS"),
        "only the successor may take the retired vault's place"
    );
    assert!(phone.service.snapshot().rotated);
    let joined = phone.service.join_with_recovery(&recovery).unwrap();
    assert!(joined.enrolled && !joined.rotated);
    assert_eq!(phone.vault().id(), mac.vault().id());
    phone.service.connect(false).unwrap();
    phone.service.disconnect();
}

#[test]
fn a_rotation_stopped_before_the_retire_finishes_at_the_next_connect() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let old_id = mac.vault().id().to_string();

    mac.service.quit_before_next_retire();
    assert_eq!(
        mac.service.rotate_vault(SECRET).err(),
        Some("E_SYNC_OFFLINE")
    );
    assert_eq!(mac.vault().id().to_string(), old_id);
    assert!(mac.holds("vault-next") && mac.holds("device-next"));
    let settings = mac.settings_text();
    let next = Vault::load_next(mac.secrets.as_ref()).unwrap().unwrap();
    assert!(settings.contains(&next.id().to_string()));
    for secret in [
        SECRET.to_string(),
        next.recovery_key().to_string(),
        mac.vault().recovery_key().to_string(),
    ] {
        assert!(
            !settings.contains(&secret),
            "the settings hold no key or secret"
        );
    }
    phone.service.connect(false).unwrap();
    phone.service.disconnect();

    mac.service.connect(false).unwrap();
    assert_ne!(mac.vault().id().to_string(), old_id);
    assert!(!mac.holds("vault-next") && !mac.holds("device-next"));
    assert!(mac.service.recovery_key().unwrap().is_some());
    assert_eq!(phone.service.connect(false).err(), Some(ROTATED));
    mac.service.disconnect();
}

#[test]
fn a_rotation_that_never_reached_the_relay_is_dropped_and_the_vault_syncs_on() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let old_id = mac.vault().id().to_string();
    assert_eq!(
        mac.service.rotate_vault("not-the-relay-secret").err(),
        Some("E_SYNC_RELAY_SECRET")
    );
    assert_eq!(
        mac.service.rotate_vault(" ").err(),
        Some("E_SYNC_RELAY_SECRET_INVALID")
    );
    assert!(mac.holds("vault-next"));
    mac.service.connect(false).unwrap();
    assert_eq!(mac.vault().id().to_string(), old_id);
    assert!(!mac.holds("vault-next"));
    assert!(matches!(
        mac.service.push(RECORD, 0, &data(), "record", ""),
        Ok(PushDto::Pushed { .. })
    ));
    mac.service.disconnect();
}

#[test]
fn two_rotations_at_once_end_with_one_successor() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let old_id = mac.vault().id().to_string();

    // The phone made its successor and stopped before retiring; the Mac then rotated.
    phone.service.quit_before_next_retire();
    assert_eq!(
        phone.service.rotate_vault(SECRET).err(),
        Some("E_SYNC_OFFLINE")
    );
    mac.service.rotate_vault(SECRET).unwrap();
    let winner = mac.vault().id().to_string();

    assert_eq!(phone.service.connect(false).err(), Some(ROTATED));
    assert_eq!(phone.vault().id().to_string(), old_id);
    assert!(!phone.holds("vault-next") && !phone.holds("device-next"));
    assert!(phone.service.snapshot().rotated);
    assert_eq!(
        phone.service.rotate_vault(SECRET).err(),
        Some(ROTATED),
        "a retired vault is not rotated again"
    );
    let code = mac.service.pairing_open().unwrap().code;
    phone.service.join_with_code(&code).unwrap();
    assert_eq!(phone.vault().id().to_string(), winner);
}

#[test]
fn a_connected_device_is_told_at_once_and_a_retire_is_kept_for_the_first_successor() {
    let relay = NodeRelay::start();
    let mac = Device::first(&relay);
    let phone = Device::paired(&relay, &mac);
    let vault = phone.vault();
    let id = vault.id().to_string();
    let (on_event, events) = super::relay_tests::events();
    let (socket, _) = Connection::open(&relay.url, &id, &phone.token(), on_event).unwrap();

    mac.service.rotate_vault(SECRET).unwrap();
    let successor = mac.vault().id().to_string();
    assert!(matches!(
        events.recv_timeout(std::time::Duration::from_secs(10)),
        Ok(client::Event::Changed(_))
    ));
    assert_eq!(client::pull(&socket, &vault, 0).err(), Some(ROTATED));
    let other = Vault::generate().unwrap().id().to_string();
    assert_eq!(
        client::retire(&socket, &other),
        Ok(client::Retire::Taken(successor.clone()))
    );
    assert_eq!(
        client::retire(&socket, &successor),
        Ok(client::Retire::Done)
    );
    let answer = client::send_raw(&socket, json!({ "type": "devices" })).unwrap();
    assert_eq!(answer.message["type"], "devices");
    socket.close();
}
