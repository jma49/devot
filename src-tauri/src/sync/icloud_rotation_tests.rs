//! Rotating an iCloud vault's key against the in-memory CloudKit (docs/adr/0017-sync-key-rotation.md,
//! On iCloud): the devices on the Apple ID follow on their own, a rotation stopped at any step
//! carries on at the next connect, of two rotations at once one wins, and a device offline across
//! the rotation follows when it next connects.

use std::sync::Arc;

use super::cloudkit::current;
use super::cloudkit::fake::Fake;
use super::cloudkit::kit::{CloudKit as _, SavePolicy, Value, ZONE_DEVOT, vault_zone};
use super::cloudkit::rotation;
use super::icloud_service_tests::{
    Device, NOTE, b64, device, device_with, epoch, handed_over, held,
};
use super::relay_tests::Secrets;
use super::settings::{FILE, SettingsStore, SyncSettings};
use super::{Vault, handover};

const ROTATED: &str = "E_SYNC_VAULT_ROTATED";
const QUIT: &str = "E_TEST_QUIT";

fn settings(device: &Device) -> SyncSettings {
    SettingsStore::new(&device._dir.path().join(FILE)).get()
}

fn id(device: &Device) -> String {
    held(device).unwrap().id().to_string()
}

/// A Mac with a vault on iCloud that has synced a note, and a phone on the same Apple ID and iCloud
/// Keychain that joined it with no code and synced too.
fn vault_on_two_devices(kit: &Arc<Fake>, keychain: &Arc<Secrets>) -> (Device, Device) {
    let mac = device_with(kit, keychain);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.recovery_saved().unwrap();
    mac.service.connect(false).unwrap();
    mac.service
        .push(NOTE, 0, &b64(b"first"), "record", "")
        .unwrap();
    let phone = device_with(kit, keychain);
    phone.service.icloud_look(0).unwrap();
    phone.service.connect(true).unwrap();
    assert_eq!(phone.service.pull("").unwrap().records.len(), 1);
    (mac, phone)
}

/// What the end of every rotation from `old` to `new` looks like on iCloud and on `mac`.
fn rotated_to(kit: &Fake, keychain: &Secrets, mac: &Device, old: &str, new: &str) {
    assert_eq!(id(mac), new);
    assert_eq!(current::read(kit), Ok(Some(new.to_string())));
    assert_eq!(handed_over(keychain).unwrap().id().to_string(), new);
    assert!(kit.zone_exists(&vault_zone(new)));
    assert!(!kit.zone_exists(&vault_zone(old)), "the old records go");
    assert!(kit.record(ZONE_DEVOT, &format!("meta-{old}")).is_none());
    assert!(
        kit.record(ZONE_DEVOT, &rotation::successor_name(old, new))
            .is_some(),
        "kept for a device that was offline"
    );
    let kept = settings(mac);
    assert_eq!(kept.rotating, None);
    assert_eq!(kept.icloud.as_ref().map(|s| s.vault.as_str()), Some(new));
    assert_eq!(kept.icloud.as_ref().map(|s| s.retired.as_str()), Some(""));
    assert!(Vault::load_next(mac.secrets.as_ref()).unwrap().is_none());
}

#[test]
fn rotates_an_icloud_vault_and_the_other_devices_on_the_apple_id_follow_on_their_own() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, phone) = vault_on_two_devices(&kit, &keychain);
    let old = id(&mac);
    let old_key = held(&mac).unwrap().recovery_key();
    let rows =
        [&mac, &phone].map(|d| format!("device-{old}-{}", settings(d).icloud.unwrap().device));
    assert!(rows.iter().all(|row| kit.record(ZONE_DEVOT, row).is_some()));
    let before = epoch(mac.service.connect(true).unwrap());

    let created = mac.service.rotate_icloud().unwrap();
    let new = id(&mac);
    assert_ne!(new, old);
    rotated_to(&kit, &keychain, &mac, &old, &new);
    assert!(rows.iter().all(|row| kit.record(ZONE_DEVOT, row).is_none()));
    assert_eq!(created.snapshot.transport, "icloud");
    let shown = created.recovery_key.expect("the new recovery key");
    assert_ne!(*shown, *old_key);
    assert_eq!(
        Vault::from_recovery_key(&shown).unwrap().id().to_string(),
        new
    );

    let after = epoch(mac.service.connect(true).unwrap());
    assert_ne!(after, before, "a new epoch: the whole library goes up");
    assert!(mac.service.pull("").unwrap().records.is_empty());
    mac.service
        .push(NOTE, 0, &b64(b"after"), "record", "")
        .unwrap();

    let followed = epoch(phone.service.connect(true).unwrap());
    assert_eq!(followed, after);
    assert_eq!(id(&phone), new);
    assert!(!phone.service.snapshot().rotated);
    assert!(
        phone.service.recovery_key().unwrap().is_none(),
        "the device that changed the key shows it"
    );
    let page = phone.service.pull("").unwrap();
    assert_eq!(page.records.len(), 1);
    assert_eq!(
        page.records[0].data.as_deref(),
        Some(b64(b"after").as_str())
    );
    assert_eq!(settings(&phone).rotated, None);
}

#[test]
fn a_rotation_interrupted_at_any_step_carries_on_at_the_next_connect() {
    for step in [
        "key",
        "zone",
        "successor",
        "current",
        "handover",
        "switch",
        "settings",
    ] {
        let kit = Arc::new(Fake::new());
        let keychain = Arc::new(Secrets::default());
        let (mac, phone) = vault_on_two_devices(&kit, &keychain);
        let old = id(&mac);
        mac.service.quit_icloud_rotation_at(step);
        assert_eq!(mac.service.rotate_icloud().err(), Some(QUIT), "{step}");
        let new = settings(&mac).rotating.expect("recorded").to;
        let switched = matches!(step, "settings");
        assert_eq!(id(&mac) == new, switched, "{step}");
        let moved = !matches!(step, "key" | "zone" | "successor" | "current");
        assert_eq!(
            current::read(kit.as_ref()),
            Ok(Some(if moved { &new } else { &old }.clone())),
            "{step}"
        );
        if !moved {
            assert!(kit.zone_exists(&vault_zone(&old)), "{step}: untouched");
            phone.service.connect(true).unwrap();
            assert_eq!(id(&phone), old, "{step}: the others sync on");
        }

        mac.service.connect(true).unwrap();
        rotated_to(&kit, &keychain, &mac, &old, &new);
        assert!(
            mac.service.recovery_key().unwrap().is_some(),
            "{step}: the new recovery key is on offer"
        );
        phone.service.connect(true).unwrap();
        assert_eq!(id(&phone), new, "{step}");
    }
}

#[test]
fn a_rotation_started_again_takes_the_waiting_key() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, _phone) = vault_on_two_devices(&kit, &keychain);
    let old = id(&mac);
    mac.service.quit_icloud_rotation_at("current");
    assert_eq!(mac.service.rotate_icloud().err(), Some(QUIT));
    let new = settings(&mac).rotating.unwrap().to;
    mac.service.rotate_icloud().unwrap();
    rotated_to(&kit, &keychain, &mac, &old, &new);
}

#[test]
fn what_is_left_of_the_old_vault_is_deleted_at_a_later_connect() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, phone) = vault_on_two_devices(&kit, &keychain);
    let old = id(&mac);
    kit.fail_zone_delete(
        &vault_zone(&old),
        super::cloudkit::kit::CkError::of(super::cloudkit::error::code::NETWORK_UNAVAILABLE),
    );
    mac.service.rotate_icloud().unwrap();
    let new = id(&mac);
    assert!(kit.zone_exists(&vault_zone(&old)));
    assert_eq!(settings(&mac).icloud.unwrap().retired, old);
    phone.service.connect(true).unwrap();
    assert_eq!(
        id(&phone),
        new,
        "the old zone still there does not hold it back"
    );
    mac.service.connect(true).unwrap();
    rotated_to(&kit, &keychain, &mac, &old, &new);
}

#[test]
fn of_two_rotations_at_once_one_wins_and_the_other_device_follows_it() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, phone) = vault_on_two_devices(&kit, &keychain);
    let old = id(&mac);
    mac.service.quit_icloud_rotation_at("current");
    assert_eq!(mac.service.rotate_icloud().err(), Some(QUIT));
    let lost = settings(&mac).rotating.unwrap().to;
    assert!(kit.zone_exists(&vault_zone(&lost)));

    phone.service.rotate_icloud().unwrap();
    let won = id(&phone);
    rotated_to(&kit, &keychain, &phone, &old, &won);

    assert_eq!(
        mac.service.rotate_icloud().err(),
        Some(ROTATED),
        "the other rotation won"
    );
    assert_eq!(id(&mac), won, "and this device follows it");
    assert!(
        !kit.zone_exists(&vault_zone(&lost)),
        "what the loser made goes"
    );
    assert!(kit.record(ZONE_DEVOT, &format!("meta-{lost}")).is_none());
    assert!(
        kit.record(ZONE_DEVOT, &rotation::successor_name(&old, &lost))
            .is_none()
    );
    assert_eq!(settings(&mac).rotating, None);
    assert!(Vault::load_next(mac.secrets.as_ref()).unwrap().is_none());
    assert!(mac.service.recovery_key().unwrap().is_none());
    mac.service.connect(true).unwrap();
    assert_eq!(current::read(kit.as_ref()), Ok(Some(won)));
}

#[test]
fn a_rotation_interrupted_before_current_that_lost_meanwhile_follows_at_its_next_connect() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, phone) = vault_on_two_devices(&kit, &keychain);
    let old = id(&mac);
    mac.service.quit_icloud_rotation_at("current");
    assert_eq!(mac.service.rotate_icloud().err(), Some(QUIT));
    let lost = settings(&mac).rotating.unwrap().to;
    phone.service.rotate_icloud().unwrap();
    let won = id(&phone);

    mac.service.connect(true).unwrap();
    assert_eq!(id(&mac), won);
    assert!(!kit.zone_exists(&vault_zone(&lost)));
    assert!(!kit.zone_exists(&vault_zone(&old)));
}

#[test]
fn a_device_offline_across_the_rotation_follows_when_it_next_connects() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, phone) = vault_on_two_devices(&kit, &keychain);
    let old = id(&mac);
    let before = epoch(phone.service.connect(true).unwrap());
    phone.service.disconnect();

    mac.service.rotate_icloud().unwrap();
    let new = id(&mac);
    mac.service.connect(true).unwrap();
    assert!(!kit.zone_exists(&vault_zone(&old)));

    kit.fail_next(
        super::cloudkit::fake::Op::Account,
        super::cloudkit::kit::CkError::of(super::cloudkit::error::code::NETWORK_UNAVAILABLE),
    );
    assert_eq!(phone.service.connect(true).err(), Some("E_SYNC_OFFLINE"));
    assert_eq!(id(&phone), old, "still offline");

    let after = epoch(phone.service.connect(true).unwrap());
    assert_eq!(id(&phone), new);
    assert_ne!(after, before, "a new epoch: its whole library goes up");
    phone
        .service
        .push(NOTE, 0, &b64(b"written offline"), "record", "")
        .unwrap();
    let page = mac.service.pull("").unwrap();
    assert_eq!(
        page.records[0].data.as_deref(),
        Some(b64(b"written offline").as_str())
    );
}

#[test]
fn a_device_the_new_handover_item_has_not_reached_joins_with_the_new_recovery_key() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, _phone) = vault_on_two_devices(&kit, &keychain);
    let old_key = held(&mac).unwrap().recovery_key();
    let ipad = device(&kit);
    ipad.service.use_icloud(Some(&old_key), 0).unwrap();
    ipad.service.connect(true).unwrap();
    let old = id(&ipad);

    let new_key = mac.service.rotate_icloud().unwrap().recovery_key.unwrap();
    assert_eq!(ipad.service.connect(true).err(), Some(ROTATED));
    assert_eq!(id(&ipad), old, "it takes nothing on its own");
    let snapshot = ipad.service.snapshot();
    assert!(snapshot.rotated);
    assert_eq!(snapshot.transport, "icloud");
    assert_eq!(
        ipad.service.connect(true).err(),
        Some(ROTATED),
        "it stays stopped"
    );

    let stranger = Vault::generate().unwrap().recovery_key();
    assert_eq!(
        ipad.service.use_icloud(Some(&stranger), 0).err(),
        Some("E_SYNC_VAULT_EXISTS"),
        "only the successor may take the vault's place"
    );
    let snapshot = ipad.service.use_icloud(Some(&new_key), 0).unwrap();
    assert!(!snapshot.rotated);
    assert_eq!(snapshot.transport, "icloud");
    assert_eq!(id(&ipad), id(&mac));
    assert!(ipad.service.recovery_key().unwrap().is_none());
    ipad.service.connect(true).unwrap();
}

#[test]
fn a_device_the_new_handover_item_has_not_reached_joins_with_a_pairing_code() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, _phone) = vault_on_two_devices(&kit, &keychain);
    let ipad = device(&kit);
    let old_key = held(&mac).unwrap().recovery_key();
    ipad.service.use_icloud(Some(&old_key), 0).unwrap();
    ipad.service.connect(true).unwrap();
    assert_eq!(
        ipad.service
            .join_with_code_via(&mac.service.pairing_open().unwrap().code, true)
            .err(),
        Some("E_SYNC_VAULT_EXISTS"),
        "a device in a vault that was not rotated joins no other"
    );

    mac.service.rotate_icloud().unwrap();
    assert_eq!(ipad.service.connect(true).err(), Some(ROTATED));
    let code = mac.service.pairing_open().unwrap().code;
    ipad.service.join_with_code_via(&code, true).unwrap();
    assert_eq!(id(&ipad), id(&mac));
    assert!(!ipad.service.snapshot().rotated);
    ipad.service.connect(true).unwrap();
}

#[test]
fn a_successor_record_that_does_not_hold_is_never_followed() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (_mac, phone) = vault_on_two_devices(&kit, &keychain);
    let held_vault = held(&phone).unwrap();
    let old = id(&phone);
    let other = Vault::generate().unwrap();
    let other_id = other.id().to_string();
    let named = |vault: &str| {
        super::cloudkit::kit::CkRecord::new(super::cloudkit::kit::TYPE_VAULT, "current")
            .with("vault", Value::Text(vault.into()))
    };

    // `current` names another vault and no successor record opens: ADR 0015 still holds.
    kit.save(ZONE_DEVOT, &[named(&other_id)], SavePolicy::Overwrite)
        .unwrap();
    handover::write(keychain.as_ref(), &other).unwrap();
    phone.service.connect(true).unwrap();
    assert_eq!(id(&phone), old);
    assert!(!phone.service.snapshot().rotated);

    // Sealed under a key the device does not hold.
    let stranger = Vault::generate().unwrap();
    rotation::save_successor(kit.as_ref(), &stranger, &other).unwrap();
    phone.service.connect(true).unwrap();
    assert_eq!(
        id(&phone),
        old,
        "a record of another vault names nothing here"
    );

    // Sealed under the held key, but its MAC is not under the handover item's key.
    rotation::save_successor(kit.as_ref(), &held_vault, &other).unwrap();
    let name = rotation::successor_name(&old, &other_id);
    let mut record = kit.record(ZONE_DEVOT, &name).unwrap();
    record.set("mac", Value::Bytes(vec![0; 32]));
    kit.save(ZONE_DEVOT, &[record], SavePolicy::Overwrite)
        .unwrap();
    assert_eq!(phone.service.connect(true).err(), Some(ROTATED));
    assert_eq!(id(&phone), old, "a MAC that does not hold switches nothing");
    assert!(phone.service.snapshot().rotated);
}

#[test]
fn change_vault_key_on_icloud_needs_the_vault_there_and_its_apple_id() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    assert_eq!(
        mac.service.rotate_icloud().err(),
        Some("E_SYNC_NO_VAULT_KEY")
    );
    mac.service.use_icloud(None, 0).unwrap();
    assert_eq!(
        mac.service.rotate_vault("relay-secret").err(),
        Some("E_SYNC_ROTATION_ICLOUD"),
        "the relay's way needs a relay"
    );
    mac.service.connect(false).unwrap();
    kit.switch_user("_user-two");
    assert_eq!(
        mac.service.rotate_icloud().err(),
        Some(super::cloudkit::error::ACCOUNT_CHANGED)
    );
    assert!(settings(&mac).rotating.is_none(), "nothing is made");
}

#[test]
fn leaving_the_vault_part_way_through_a_rotation_forgets_it() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let key = held(&mac).unwrap().recovery_key();
    mac.service.quit_icloud_rotation_at("current");
    assert_eq!(mac.service.rotate_icloud().err(), Some(QUIT));
    mac.service.icloud_leave(&key).unwrap();
    let kept = settings(&mac);
    assert_eq!(kept.rotating, None);
    assert!(Vault::load_next(mac.secrets.as_ref()).unwrap().is_none());
    assert!(held(&mac).is_none());
}
