//! The service with a vault on iCloud, against the in-memory CloudKit (`cloudkit::fake`).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value as Json, json};

use super::cloudkit::error;
use super::cloudkit::fake::{Fake, Op};
use super::cloudkit::kit::{ZONE_DEVOT, vault_zone};
use super::relay_tests::Secrets;
use super::service::{self, Connected, PushDto, PushItemDto, SyncService};
use super::settings::{FILE, SettingsStore};
use super::tests::FailingStore;
use super::{SecretStore, SyncError, Vault};
use crate::licence::Gate;

const NOTE: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789a1";
const OTHER: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789a2";

type Events = Arc<Mutex<Vec<(String, Json)>>>;

struct Device {
    service: SyncService,
    secrets: service::Secrets,
    events: Events,
    _dir: tempfile::TempDir,
}

fn device(kit: &Arc<Fake>) -> Device {
    device_with(kit, &Arc::new(Secrets::default()))
}

/// A device on the Apple ID `kit` stands for, whose iCloud Keychain is `keychain`.
fn device_with(kit: &Arc<Fake>, keychain: &Arc<Secrets>) -> Device {
    device_of(
        kit,
        Arc::clone(keychain) as _,
        Arc::new(Secrets::default()),
        Gate::open(),
    )
}

/// `device_with` with its own keychain `own` and the licence `gate`.
fn device_of(
    kit: &Arc<Fake>,
    keychain: service::Secrets,
    own: service::Secrets,
    gate: Gate,
) -> Device {
    let dir = tempfile::tempdir().unwrap();
    let secrets = own;
    let events: Events = Arc::default();
    let sent = Arc::clone(&events);
    let service = SyncService::new(
        SettingsStore::new(&dir.path().join(FILE)),
        Arc::clone(&secrets),
        Arc::new(move |event: &str, payload: Json| {
            sent.lock().unwrap().push((event.to_string(), payload));
        }),
        gate,
    )
    .with_icloud(Arc::clone(kit) as _)
    .with_handover(keychain);
    Device {
        service,
        secrets,
        events,
        _dir: dir,
    }
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn item(id: &str, base: u64, data: &[u8], tag: &str) -> PushItemDto {
    PushItemDto {
        id: id.into(),
        base,
        data: b64(data),
        kind: "record".into(),
        tag: tag.into(),
    }
}

fn socket_events(events: &Events) -> Vec<Json> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == super::service::SOCKET_EVENT)
        .map(|(_, payload)| payload.clone())
        .collect()
}

#[test]
fn a_build_without_the_container_never_touches_cloudkit() {
    let kit = Arc::new(Fake::new().without_entitlement());
    let mac = device(&kit);
    let status = mac.service.icloud_status();
    assert!(!status.available);
    assert_eq!(status.account, None);
    assert_eq!(
        mac.service.use_icloud(None, 0).err(),
        Some(error::UNAVAILABLE)
    );
    assert!(!mac.service.snapshot().vault, "no vault is made for it");
}

#[test]
fn a_vault_moved_to_a_build_without_the_container_reports_unavailable() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let state = std::fs::read(mac._dir.path().join(FILE)).unwrap();
    let unsigned = Arc::new(Fake::new().without_entitlement());
    let again = device(&unsigned);
    crate::atomic_file::write_replacing(&again._dir.path().join(FILE), &state).unwrap();
    let vault = Vault::load(mac.secrets.as_ref()).unwrap().unwrap();
    Vault::join(again.secrets.as_ref(), vault).unwrap();
    assert_eq!(again.service.connect(false).err(), Some(error::UNAVAILABLE));
}

#[test]
fn uses_icloud_with_a_new_vault_and_shows_its_recovery_key_once() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    let snapshot = mac.service.use_icloud(None, 0).unwrap();
    assert!(snapshot.enabled && snapshot.vault);
    assert_eq!(snapshot.transport, "icloud");
    assert!(!snapshot.enrolled, "no relay is involved");
    assert!(mac.service.recovery_key().unwrap().is_some());
    mac.service.recovery_saved().unwrap();
    assert!(mac.service.recovery_key().unwrap().is_none());
    assert_eq!(mac.service.icloud_status().account, Some("available"));
}

#[test]
fn a_second_device_restores_the_vault_from_its_recovery_key_and_syncs() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let key = mac.service.recovery_key().unwrap().unwrap();
    let Connected::ICloud(_) = mac.service.connect(false).unwrap() else {
        panic!("not on iCloud");
    };
    let Ok(PushDto::Pushed {
        version: 1,
        tag,
        seq: None,
    }) = mac.service.push(NOTE, 0, &b64(b"first"), "record", "")
    else {
        panic!("not pushed");
    };
    assert!(!tag.is_empty());

    let phone = device(&kit);
    let snapshot = phone.service.use_icloud(Some(&key), 0).unwrap();
    assert_eq!(snapshot.transport, "icloud");
    assert!(
        phone.service.recovery_key().unwrap().is_none(),
        "a device that typed the key is not shown it"
    );
    phone.service.connect(true).unwrap();
    let page = phone.service.pull("").unwrap();
    assert_eq!(page.records.len(), 1);
    assert_eq!(page.records[0].id, NOTE);
    assert_eq!(page.records[0].name, held(&mac).unwrap().store_name(NOTE));
    assert_eq!(
        page.records[0].data.as_deref(),
        Some(b64(b"first").as_str())
    );
    assert_eq!(page.records[0].tag, tag);
    assert_eq!(page.records[0].seq, None);
    assert!(!page.next.is_empty());
    assert!(phone.service.pull(&page.next).unwrap().records.is_empty());
}

#[test]
fn a_key_for_another_vault_is_refused_when_one_is_held() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let other = Vault::create(&Secrets::default()).unwrap();
    assert_eq!(
        mac.service.use_icloud(Some(&other.recovery_key()), 0).err(),
        Some("E_SYNC_VAULT_EXISTS")
    );
    assert_eq!(
        mac.service.use_icloud(Some(&"A".repeat(513)), 0).err(),
        Some("E_SYNC_RECOVERY_FORMAT")
    );
}

#[test]
fn pushes_a_batch_and_answers_each_item_in_order() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    let saves = kit.calls(Op::Save);
    let answers = mac
        .service
        .push_many(&[
            item(NOTE, 0, b"one", ""),
            item("not an id", 0, b"two", ""),
            item(OTHER, 0, b"three", ""),
        ])
        .unwrap();
    assert!(matches!(answers[0], PushDto::Pushed { version: 1, .. }));
    assert_eq!(
        answers[1],
        PushDto::Failed {
            code: "E_SYNC_ID_INVALID"
        }
    );
    assert!(matches!(answers[2], PushDto::Pushed { version: 1, .. }));
    assert_eq!(kit.calls(Op::Save), saves + 1, "one modify operation");

    let PushDto::Pushed { tag, .. } = &answers[0] else {
        unreachable!()
    };
    let stale = mac
        .service
        .push_many(&[item(NOTE, 0, b"again", "")])
        .unwrap();
    let PushDto::Rejected {
        version: 1,
        tag: server,
    } = &stale[0]
    else {
        panic!("not rejected: {stale:?}");
    };
    assert_eq!(server, tag);
    let retried = mac
        .service
        .push_many(&[item(NOTE, 1, b"again", server)])
        .unwrap();
    assert!(matches!(retried[0], PushDto::Pushed { version: 2, .. }));
}

#[test]
fn refuses_a_batch_too_large_before_any_upload() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    let saves = kit.calls(Op::Save);
    let many: Vec<_> = (0..201).map(|_| item(NOTE, 0, b"x", "")).collect();
    assert_eq!(
        mac.service.push_many(&many).err(),
        Some("E_SYNC_BATCH_TOO_LARGE")
    );
    assert_eq!(kit.calls(Op::Save), saves);
}

#[test]
fn a_tag_that_is_not_one_fails_its_item_alone() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    let answers = mac
        .service
        .push_many(&[item(NOTE, 0, b"x", "not base64!"), item(OTHER, 0, b"y", "")])
        .unwrap();
    assert_eq!(
        answers[0],
        PushDto::Failed {
            code: error::TAG_INVALID
        }
    );
    assert!(matches!(answers[1], PushDto::Pushed { version: 1, .. }));
    assert!(
        kit.record(
            &vault_zone(&held(&mac).unwrap().id().to_string()),
            &held(&mac).unwrap().store_name(NOTE)
        )
        .is_none()
    );
}

/// The same Mac signed in to the Apple ID `kit` stands for: its settings and its own keychain.
fn signed_in_to(kit: &Arc<Fake>, mac: &Device) -> SyncService {
    SyncService::new(
        SettingsStore::new(&mac._dir.path().join(FILE)),
        Arc::clone(&mac.secrets),
        Arc::new(|_, _| ()),
        Gate::open(),
    )
    .with_icloud(Arc::clone(kit) as _)
    .with_handover(Arc::new(Secrets::default()))
}

fn epoch(connected: Connected) -> String {
    match connected {
        Connected::ICloud(welcome) => welcome.epoch,
        Connected::Relay(_) => panic!("connected through a relay"),
    }
}

#[test]
fn the_engine_sees_the_vaults_epoch_marked_for_store_names() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let seen = epoch(mac.service.connect(true).unwrap());
    let vault = held(&mac).unwrap().id().to_string();
    let meta = kit.record(ZONE_DEVOT, &format!("meta-{vault}")).unwrap();
    assert_eq!(seen, super::names::epoch(meta.text("epoch").unwrap()));
}

#[test]
fn moves_the_vault_into_the_apple_id_now_signed_in_under_a_new_epoch() {
    let first = Arc::new(Fake::new());
    let mac = device(&first);
    mac.service.use_icloud(None, 0).unwrap();
    let before = epoch(mac.service.connect(true).unwrap());
    mac.service.disconnect();
    let vault = held(&mac).unwrap().id().to_string();

    let second = Arc::new(Fake::new());
    second.switch_user("_user-two");
    let after_switch = signed_in_to(&second, &mac);
    assert_eq!(
        after_switch.connect(true).err(),
        Some(error::ACCOUNT_CHANGED)
    );
    assert!(
        !second.zone_exists(&vault_zone(&vault)),
        "nothing goes there unasked"
    );

    after_switch.icloud_upload_again().unwrap();
    let after = epoch(after_switch.connect(true).unwrap());
    assert_ne!(after, before, "a new epoch, so everything is uploaded");
    assert!(second.zone_exists(&vault_zone(&vault)));
    assert_eq!(
        super::cloudkit::current::read(second.as_ref()).unwrap(),
        Some(vault)
    );
}

#[test]
fn never_moves_the_vault_into_an_apple_id_that_syncs_another() {
    let first = Arc::new(Fake::new());
    let mac = device(&first);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(true).unwrap();
    mac.service.disconnect();

    let second = Arc::new(Fake::new());
    second.switch_user("_user-two");
    device(&second).service.use_icloud(None, 0).unwrap();
    let after_switch = signed_in_to(&second, &mac);
    assert_eq!(
        after_switch.icloud_upload_again().err(),
        Some("E_SYNC_ICLOUD_OTHER_VAULT")
    );
    assert_eq!(
        after_switch.connect(true).err(),
        Some(error::ACCOUNT_CHANGED),
        "it still uploads nothing"
    );
}

#[test]
fn lists_the_vault_s_devices_on_icloud_by_their_rows() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    let shown = mac.service.pairing_open().unwrap();
    let phone = device(&kit);
    phone
        .service
        .join_with_code_via(&shown.link, false)
        .unwrap();
    phone.service.connect(false).unwrap();

    let listed = mac.service.devices().unwrap();
    assert_eq!(listed.len(), 2, "{listed:?}");
    assert!(listed.iter().all(|d| d.label == "Devot for macOS"));
    assert_eq!(listed.iter().filter(|d| d.current).count(), 1);
    let today = kit.record(
        ZONE_DEVOT,
        &format!("device-{}-{}", held(&mac).unwrap().id(), listed[0].id),
    );
    assert!(today.is_some());
    assert!(
        listed
            .iter()
            .all(|d| d.created > 0 && d.created % 86_400_000 == 0)
    );
    let theirs = phone.service.devices().unwrap();
    assert_ne!(
        listed.iter().find(|d| d.current).unwrap().id,
        theirs.iter().find(|d| d.current).unwrap().id
    );
}

#[test]
fn a_full_icloud_pauses_with_its_code_and_no_end() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    kit.fail_record(
        &held(&mac).unwrap().store_name(NOTE),
        super::cloudkit::kit::CkError::of(error::code::QUOTA_EXCEEDED),
    );
    let answers = mac
        .service
        .push_many(&[item(NOTE, 0, b"one", ""), item(OTHER, 0, b"two", "")])
        .unwrap();
    assert_eq!(
        answers[0],
        PushDto::Paused {
            until: None,
            limit: None,
            code: Some(error::FULL)
        }
    );
    assert!(matches!(answers[1], PushDto::Pushed { .. }));
    assert_eq!(
        serde_json::to_value(&answers[0]).unwrap(),
        json!({ "type": "paused", "until": null, "limit": null, "code": error::FULL })
    );
}

#[test]
fn a_batch_needs_icloud() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    assert_eq!(
        mac.service.push_many(&[item(NOTE, 0, b"x", "")]).err(),
        Some("E_SYNC_OFFLINE")
    );
}

#[test]
fn uploads_again_after_the_zone_was_deleted() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    let vault = Vault::load(mac.secrets.as_ref()).unwrap().unwrap();
    let zone = vault_zone(&vault.id().to_string());
    mac.service.disconnect();
    kit.delete_zone(&zone);
    assert_eq!(mac.service.connect(true).err(), Some(error::DELETED));
    assert!(!kit.zone_exists(&zone), "nothing is remade without asking");

    mac.service.icloud_upload_again().unwrap();
    mac.service.connect(true).unwrap();
    assert!(kit.zone_exists(&zone));
}

#[test]
fn upload_again_needs_a_vault_on_icloud() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    Vault::create(mac.secrets.as_ref()).unwrap();
    assert_eq!(
        mac.service.icloud_upload_again().err(),
        Some("E_SYNC_ICLOUD_NOT_USED")
    );
}

#[test]
fn hands_change_notices_to_the_engine_only_while_on_icloud() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.icloud_changed();
    mac.service.icloud_account_changed();
    assert!(socket_events(&mac.events).is_empty(), "sync is off");

    mac.service.use_icloud(None, 0).unwrap();
    mac.service.icloud_account_changed();
    mac.service.connect(false).unwrap();
    mac.service.icloud_changed();
    assert_eq!(
        socket_events(&mac.events),
        vec![
            json!({ "type": "account" }),
            json!({ "type": "changed", "cursor": "" })
        ]
    );
    assert!(kit.zone_exists(ZONE_DEVOT));
}

#[test]
fn an_account_change_drops_the_connection_until_it_connects_again() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    assert!(mac.service.pull("").is_ok());

    mac.service.icloud_account_changed();
    assert_eq!(mac.service.pull("").err(), Some("E_SYNC_OFFLINE"));

    mac.service.connect(true).unwrap();
    assert!(mac.service.pull("").is_ok());
}

fn held(device: &Device) -> Option<Vault> {
    Vault::load(device.secrets.as_ref()).unwrap()
}

fn handed_over(keychain: &dyn SecretStore) -> Option<Vault> {
    super::handover::read(keychain).unwrap()
}

fn join_state(snapshot: &super::service::Snapshot) -> Option<&'static str> {
    snapshot.icloud_join.as_ref().map(|view| view.state)
}

#[test]
fn a_device_with_an_empty_library_joins_the_apple_id_s_vault_with_no_code() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&kit, &keychain);
    mac.service.use_icloud(None, 0).unwrap();
    let vault = held(&mac).unwrap();
    assert!(
        handed_over(keychain.as_ref()).unwrap().same(&vault),
        "made: handed over"
    );
    mac.service.connect(false).unwrap();
    mac.service
        .push(NOTE, 0, &b64(b"first"), "record", "")
        .unwrap();

    let phone = device_with(&kit, &keychain);
    let snapshot = phone.service.icloud_look(0).unwrap();
    assert_eq!(join_state(&snapshot), Some("joined"));
    assert!(snapshot.enabled && snapshot.vault);
    assert_eq!(snapshot.transport, "icloud");
    assert!(held(&phone).unwrap().same(&vault));
    assert!(phone.service.recovery_key().unwrap().is_none());
    let told = phone.events.lock().unwrap().iter().any(|(name, payload)| {
        name == super::service::CHANGED_EVENT && payload["icloudJoin"]["state"] == "joined"
    });
    assert!(told, "the windows hear of it");
    phone.service.connect(true).unwrap();
    assert_eq!(phone.service.pull("").unwrap().records[0].id, NOTE);

    let again = phone.service.icloud_look(0).unwrap();
    assert_eq!(
        join_state(&again),
        Some("joined"),
        "a device in the vault looks no further"
    );
}

#[test]
fn a_library_with_notes_is_asked_once_and_joins_nothing_when_declined() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&kit, &keychain);
    mac.service.use_icloud(None, 0).unwrap();

    let phone = device_with(&kit, &keychain);
    let asked = phone.service.icloud_look(3).unwrap();
    let view = asked.icloud_join.clone().unwrap();
    assert_eq!((view.state, view.notes), ("ask", Some(3)));
    assert!(!asked.vault && !asked.enabled);
    assert!(held(&phone).is_none(), "nothing is kept before the answer");

    let declined = phone.service.icloud_join(false).unwrap();
    assert_eq!(join_state(&declined), Some("declined"));
    assert!(!declined.vault && !declined.enabled);
    assert!(held(&phone).is_none());
    let later = phone.service.icloud_look(3).unwrap();
    assert_eq!(join_state(&later), Some("declined"), "asked once");
    assert!(held(&phone).is_none());

    let accepted = phone.service.icloud_join(true).unwrap();
    assert_eq!(
        join_state(&accepted),
        Some("joined"),
        "the offer stays in Settings"
    );
    assert!(held(&phone).unwrap().same(&held(&mac).unwrap()));
}

#[test]
fn with_no_handover_item_or_one_for_another_vault_settings_offers_the_fallback() {
    let kit = Arc::new(Fake::new());
    let fresh = device_with(&Arc::new(Fake::new()), &Arc::new(Secrets::default()));
    assert_eq!(
        join_state(&fresh.service.icloud_look(0).unwrap()),
        Some("none")
    );

    let mac = device_with(&kit, &Arc::new(Secrets::default()));
    mac.service.use_icloud(None, 0).unwrap();
    let keychain = Arc::new(Secrets::default());
    let phone = device_with(&kit, &keychain);
    let fallback = |phone: &Device| {
        let snapshot = phone.service.icloud_look(0).unwrap();
        assert!(!snapshot.vault && !snapshot.enabled);
        assert!(held(phone).is_none());
        let view = snapshot.icloud_join.unwrap();
        assert_eq!(view.state, "fallback");
        (view.reason, view.code)
    };
    assert_eq!(fallback(&phone), (Some("missing"), None));

    super::handover::write(keychain.as_ref(), &Vault::generate().unwrap()).unwrap();
    assert_eq!(fallback(&phone), (Some("otherVault"), None));
    assert!(
        phone
            .service
            .icloud_join(true)
            .unwrap()
            .icloud_join
            .unwrap()
            .state
            == "fallback"
    );
    assert!(
        held(&phone).is_none(),
        "an answer never joins a vault the item does not name"
    );
    assert_eq!(
        current_vault(&kit),
        Some(held(&mac).unwrap().id().to_string()),
        "nor writes current"
    );

    use super::SecretStore as _;
    keychain
        .replace(super::handover::ACCOUNT, &[2, 0, 0])
        .unwrap();
    assert_eq!(
        fallback(&phone),
        (Some("unreadable"), Some("E_SYNC_HANDOVER_VERSION"))
    );
}

#[test]
fn a_device_never_replaces_the_vault_it_holds() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&kit, &keychain);
    mac.service.use_icloud(None, 0).unwrap();
    let code = mac.service.pairing_open().unwrap().code;

    let phone = device_with(&kit, &keychain);
    let own = Vault::create(phone.secrets.as_ref()).unwrap();
    let snapshot = phone.service.icloud_look(0).unwrap();
    assert_eq!(snapshot.icloud_join, None);
    assert_eq!(
        phone.service.icloud_join(true).err(),
        Some("E_SYNC_VAULT_EXISTS")
    );
    assert_eq!(
        phone.service.join_with_code_via(&code, true).err(),
        Some("E_SYNC_VAULT_EXISTS")
    );
    assert_eq!(
        phone.service.use_icloud(None, 0).err(),
        Some("E_SYNC_ICLOUD_OTHER_VAULT"),
        "the Apple ID has its vault"
    );
    assert!(held(&phone).unwrap().same(&own));
    assert!(
        handed_over(keychain.as_ref())
            .unwrap()
            .same(&held(&mac).unwrap())
    );

    let tablet = device_with(&kit, &Arc::new(Secrets::default()));
    tablet.service.join_with_code_via(&code, true).unwrap();
    assert!(
        held(&tablet).unwrap().same(&held(&mac).unwrap()),
        "the code was still there"
    );
}

#[test]
fn a_device_that_loses_the_race_for_current_keeps_nothing_and_joins_the_winner() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&kit, &keychain);
    mac.service.use_icloud(None, 0).unwrap();
    let winner = held(&mac).unwrap();

    let late = device_with(&kit, &Arc::new(Secrets::default()));
    let lost = late.service.use_icloud(None, 0).unwrap();
    assert!(held(&late).is_none(), "the losing vault key is not kept");
    assert!(!lost.enabled && !lost.vault);
    assert_eq!(join_state(&lost), Some("fallback"));
    let current = kit.record(ZONE_DEVOT, "current").unwrap();
    assert_eq!(
        current.text("vault"),
        Some(winner.id().to_string().as_str())
    );

    let phone = device_with(&kit, &keychain);
    let joined = phone.service.use_icloud(None, 0).unwrap();
    assert_eq!(join_state(&joined), Some("joined"));
    assert!(held(&phone).unwrap().same(&winner));
}

#[test]
fn a_device_on_another_apple_id_is_refused() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let key = mac.service.recovery_key().unwrap().unwrap();
    let shown = mac.service.pairing_open().unwrap();

    let elsewhere = Arc::new(Fake::new());
    elsewhere.switch_user("_user-two");
    let phone = device(&elsewhere);
    assert_eq!(
        phone.service.join_with_code_via(&shown.link, false).err(),
        Some("E_SYNC_ICLOUD_OTHER_ACCOUNT")
    );
    assert_eq!(
        phone.service.use_icloud(Some(&key), 0).err(),
        Some("E_SYNC_ICLOUD_NO_VAULT"),
        "the key would start a second copy that never meets the first"
    );
    assert!(held(&phone).is_none());
    assert!(!elsewhere.zone_exists(&vault_zone(&held(&mac).unwrap().id().to_string())));
}

#[test]
fn a_pairing_code_joins_an_icloud_vault_through_zone_devot() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let shown = mac.service.pairing_open().unwrap();
    assert!(
        shown.link.starts_with("devot://pair?via=icloud&code="),
        "{}",
        shown.link
    );
    assert_eq!(mac.service.pairing_check().unwrap().state, "waiting");

    let keychain = Arc::new(Secrets::default());
    let phone = device_with(&kit, &keychain);
    let snapshot = phone
        .service
        .join_with_code_via(&shown.link, false)
        .unwrap();
    assert_eq!(snapshot.transport, "icloud");
    let vault = held(&mac).unwrap();
    assert!(held(&phone).unwrap().same(&vault));
    assert!(
        handed_over(keychain.as_ref()).unwrap().same(&vault),
        "joined: handed over"
    );

    mac.service.icloud_changed();
    let woken = mac
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|(name, _)| name == super::service::PAIRING_EVENT);
    assert!(woken, "the subscription stands in for polling");
    let check = mac.service.pairing_check().unwrap();
    assert_eq!(check.state, "paired");
    let settings: Json =
        serde_json::from_slice(&std::fs::read(phone._dir.path().join(FILE)).unwrap()).unwrap();
    assert_eq!(
        check.device.as_deref(),
        settings["icloud"]["device"].as_str()
    );

    let tablet = device(&kit);
    assert_eq!(
        tablet.service.join_with_code_via(&shown.code, true).err(),
        Some("E_SYNC_PAIRING_GONE"),
        "a second take fails"
    );
    let typed = mac.service.pairing_open().unwrap();
    tablet
        .service
        .join_with_code_via(&typed.code, true)
        .unwrap();
    assert!(held(&tablet).unwrap().same(&vault));
}

/// The record a shown code's offer waits in, as zone `devot` holds it.
fn offer_record(
    kit: &Fake,
    code: &str,
) -> (super::pairing::Pairing, super::cloudkit::kit::CkRecord) {
    let pairing = super::pairing::read(code).unwrap().pairing;
    let record = kit.record(ZONE_DEVOT, pairing.id()).unwrap();
    (pairing, record)
}

#[test]
fn a_forged_or_swapped_offer_and_a_forged_confirmation_are_refused() {
    use super::cloudkit::kit::{CloudKit as _, SavePolicy, Value};
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let vault = held(&mac).unwrap();

    let other = super::pairing::Pairing::generate().unwrap();
    for offer in [
        other
            .seal_icloud_offer(&Vault::generate().unwrap(), i64::MAX / 2)
            .unwrap(),
        other.seal_icloud_offer(&vault, i64::MAX / 2).unwrap(),
    ] {
        let shown = mac.service.pairing_open().unwrap();
        let (_, record) = offer_record(&kit, &shown.code);
        kit.save(
            ZONE_DEVOT,
            &[record.with("offer", Value::Bytes(offer))],
            SavePolicy::Overwrite,
        )
        .unwrap();
        let phone = device(&kit);
        assert_eq!(
            phone.service.join_with_code_via(&shown.code, true).err(),
            Some("E_SYNC_PAIRING_AUTH")
        );
        assert!(held(&phone).is_none());
    }

    let shown = mac.service.pairing_open().unwrap();
    let (pairing, _) = offer_record(&kit, &shown.code);
    let channel = super::cloudkit::pairing::ICloudPairing::join(Arc::clone(&kit) as _);
    use super::pairing::PairingChannel as _;
    channel.take(pairing.id()).unwrap();
    channel
        .confirm(pairing.id(), &other.seal_confirmation("intruder").unwrap())
        .unwrap();
    assert_eq!(
        mac.service.pairing_check().err(),
        Some("E_SYNC_PAIRING_AUTH")
    );
}

#[test]
fn an_expired_icloud_offer_is_refused_by_the_joining_device() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    let shown = mac.service.pairing_open().unwrap();
    let phone = device(&kit);
    phone
        .service
        .shift_clock(super::pairing::TTL_MS + 5 * 60_000 + 1);
    assert_eq!(
        phone.service.join_with_code_via(&shown.code, true).err(),
        Some("E_SYNC_PAIRING_EXPIRED")
    );
    assert!(held(&phone).is_none());
    assert_eq!(mac.service.pairing_check().unwrap().state, "taken");
    mac.service
        .shift_clock(super::pairing::TTL_MS + super::pairing::GRACE_MS + 1);
    assert_eq!(mac.service.pairing_check().unwrap().state, "unconfirmed");
}

/// A keychain whose next `failures` writes fail as the Security framework's would.
#[derive(Default)]
struct Flaky {
    items: Secrets,
    failures: AtomicUsize,
    removals: AtomicUsize,
}

const FLAKY_STATUS: i32 = -25308;

impl Flaky {
    fn failing(writes: usize) -> Arc<Self> {
        Arc::new(Self {
            failures: AtomicUsize::new(writes),
            ..Self::default()
        })
    }

    fn failing_removals(removals: usize) -> Arc<Self> {
        Arc::new(Self {
            removals: AtomicUsize::new(removals),
            ..Self::default()
        })
    }

    fn write(&self) -> Result<(), SyncError> {
        Self::fail(&self.failures)
    }

    fn fail(left: &AtomicUsize) -> Result<(), SyncError> {
        match left.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)) {
            Ok(_) => Err(SyncError::Keychain(FLAKY_STATUS)),
            Err(_) => Ok(()),
        }
    }
}

impl SecretStore for Flaky {
    fn read(&self, account: &str) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, SyncError> {
        self.items.read(account)
    }

    fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError> {
        self.write()?;
        self.items.add(account, secret)
    }

    fn replace(&self, account: &str, secret: &[u8]) -> Result<(), SyncError> {
        self.write()?;
        self.items.replace(account, secret)
    }

    fn remove(&self, account: &str) -> Result<bool, SyncError> {
        Self::fail(&self.removals)?;
        self.items.remove(account)
    }
}

fn current_vault(kit: &Fake) -> Option<String> {
    kit.record(ZONE_DEVOT, "current")
        .and_then(|record| record.text("vault").map(str::to_string))
}

#[test]
fn a_new_vault_whose_key_cannot_be_kept_claims_nothing() {
    let kit = Arc::new(Fake::new());
    let own = Flaky::failing(1);
    let mac = device_of(
        &kit,
        Arc::new(Secrets::default()),
        Arc::clone(&own) as _,
        Gate::open(),
    );
    assert_eq!(
        mac.service.use_icloud(None, 0).err(),
        Some("E_SYNC_KEYCHAIN")
    );
    assert_eq!(current_vault(&kit), None, "no vault no device holds");
    assert!(held(&mac).is_none());

    let snapshot = mac.service.use_icloud(None, 0).unwrap();
    assert!(snapshot.enabled && snapshot.vault);
    assert_eq!(
        current_vault(&kit),
        Some(held(&mac).unwrap().id().to_string())
    );
}

#[test]
fn a_claim_that_failed_keeps_no_key_for_a_vault_current_does_not_name() {
    use super::cloudkit::error::code;
    use super::cloudkit::kit::CkError;
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    kit.fail_next(Op::Save, CkError::of(code::NETWORK_UNAVAILABLE));
    assert_eq!(mac.service.use_icloud(None, 0).err(), Some(error::OFFLINE));
    assert!(held(&mac).is_none());
    assert_eq!(current_vault(&kit), None);
    mac.service.use_icloud(None, 0).unwrap();
    assert_eq!(
        current_vault(&kit),
        Some(held(&mac).unwrap().id().to_string())
    );
}

#[test]
fn a_device_holding_a_vault_hears_nothing_of_icloud_with_its_trial_over() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&kit, &keychain);
    mac.service.use_icloud(None, 0).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let licence = crate::licence::testing::licence(dir.path(), true);
    let on_relay = device_of(
        &kit,
        Arc::clone(&keychain) as _,
        Arc::new(Secrets::default()),
        Gate::of(&licence),
    );
    Vault::create(on_relay.secrets.as_ref()).unwrap();
    assert_eq!(on_relay.service.icloud_look(0).unwrap().icloud_join, None);
    assert_eq!(
        on_relay.service.icloud_join(true).err(),
        Some("E_SYNC_VAULT_EXISTS")
    );

    let fresh = device_of(
        &kit,
        Arc::clone(&keychain) as _,
        Arc::new(Secrets::default()),
        Gate::of(&licence),
    );
    let view = fresh.service.icloud_look(0).unwrap().icloud_join.unwrap();
    assert_eq!(
        (view.state, view.code),
        ("unavailable", Some("E_LICENCE_REQUIRED"))
    );
}

#[test]
fn a_handover_item_that_cannot_be_written_or_read_still_joins_and_logs_its_status() {
    crate::test_log::capture();
    let kit = Arc::new(Fake::new());
    let mac = device_of(
        &kit,
        Arc::new(FailingStore),
        Arc::new(Secrets::default()),
        Gate::open(),
    );
    let made = mac.service.use_icloud(None, 0).unwrap();
    assert!(made.enabled && made.vault);
    let vault = held(&mac).unwrap();
    let key = mac.service.recovery_key().unwrap().unwrap();

    let phone = device_of(
        &kit,
        Arc::new(FailingStore),
        Arc::new(Secrets::default()),
        Gate::open(),
    );
    let view = phone.service.icloud_look(0).unwrap().icloud_join.unwrap();
    assert_eq!(
        (view.state, view.reason, view.code),
        ("fallback", Some("unreadable"), Some("E_SYNC_KEYCHAIN"))
    );
    let joined = phone.service.use_icloud(Some(&key), 0).unwrap();
    assert!(joined.enabled && joined.vault);
    assert!(held(&phone).unwrap().same(&vault));

    let lines = crate::test_log::lines();
    let write = format!(
        "W_SYNC_HANDOVER_WRITE E_SYNC_KEYCHAIN -25293 vault={}",
        vault.id()
    );
    assert!(lines.iter().any(|line| line.contains(&write)), "{lines:?}");
    assert!(
        lines
            .iter()
            .any(|line| line.contains("W_SYNC_HANDOVER_UNREADABLE E_SYNC_KEYCHAIN -25293")),
        "{lines:?}"
    );
}

#[test]
fn a_handover_item_that_could_not_be_written_is_written_at_a_later_connect() {
    let kit = Arc::new(Fake::new());
    let keychain = Flaky::failing(1);
    let mac = device_of(
        &kit,
        Arc::clone(&keychain) as _,
        Arc::new(Secrets::default()),
        Gate::open(),
    );
    mac.service.use_icloud(None, 0).unwrap();
    assert!(handed_over(keychain.as_ref()).is_none());

    mac.service.connect(false).unwrap();
    let vault = held(&mac).unwrap();
    assert!(handed_over(keychain.as_ref()).unwrap().same(&vault));
}

#[test]
fn a_device_in_the_vault_current_names_writes_an_item_naming_another_again() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&kit, &keychain);
    mac.service.use_icloud(None, 0).unwrap();
    let vault = held(&mac).unwrap();

    let other = Vault::generate().unwrap();
    super::handover::write(keychain.as_ref(), &other).unwrap();
    mac.service.connect(false).unwrap();
    assert!(handed_over(keychain.as_ref()).unwrap().same(&vault));

    let damaged = [1, 0, 0];
    use super::SecretStore as _;
    keychain
        .replace(super::handover::ACCOUNT, &damaged)
        .unwrap();
    mac.service.connect(false).unwrap();
    assert!(handed_over(keychain.as_ref()).unwrap().same(&vault));

    keychain
        .replace(super::handover::ACCOUNT, &[2, 0, 0])
        .unwrap();
    mac.service.connect(false).unwrap();
    assert_eq!(
        keychain
            .read(super::handover::ACCOUNT)
            .unwrap()
            .unwrap()
            .as_slice(),
        [2, 0, 0],
        "a later build's item stays"
    );
}

#[test]
fn a_device_in_a_vault_current_does_not_name_leaves_the_item_as_it_is() {
    use super::cloudkit::CloudKit as _;
    use super::cloudkit::kit::{SavePolicy, Value};
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&kit, &keychain);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    mac.service.disconnect();
    let winner = Vault::generate().unwrap();
    let mut current = kit.record(ZONE_DEVOT, "current").unwrap();
    current.set("vault", Value::Text(winner.id().to_string()));
    kit.save(ZONE_DEVOT, &[current], SavePolicy::Overwrite)
        .unwrap();
    super::handover::write(keychain.as_ref(), &winner).unwrap();

    mac.service.connect(false).unwrap();
    assert!(handed_over(keychain.as_ref()).unwrap().same(&winner));
}

#[test]
fn an_account_change_takes_the_vault_s_handover_item_off_this_device() {
    let first = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&first, &keychain);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(true).unwrap();
    mac.service.disconnect();
    let vault = held(&mac).unwrap();

    let second = Arc::new(Fake::new());
    second.switch_user("_user-two");
    let switched = on_apple_id(&second, &mac, &keychain);
    assert_eq!(switched.connect(true).err(), Some(error::ACCOUNT_CHANGED));
    assert!(
        handed_over(keychain.as_ref()).is_none(),
        "the key does not stay in the next Apple ID's keychain"
    );
    assert!(
        held(&mac).unwrap().same(&vault),
        "this device keeps its own"
    );

    let theirs = Vault::generate().unwrap();
    super::handover::write(keychain.as_ref(), &theirs).unwrap();
    assert_eq!(switched.connect(true).err(), Some(error::ACCOUNT_CHANGED));
    assert!(
        handed_over(keychain.as_ref()).unwrap().same(&theirs),
        "the new Apple ID's own item stays"
    );

    switched.icloud_upload_again().unwrap();
    assert!(handed_over(keychain.as_ref()).unwrap().same(&vault));
}

/// A Mac and an iPhone on one Apple ID, both in its vault, each having synced a note.
fn two_in_the_vault(kit: &Arc<Fake>, keychain: &Arc<Secrets>) -> (Device, Device) {
    let mac = device_with(kit, keychain);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(true).unwrap();
    mac.service
        .push(NOTE, 0, &b64(b"first"), "record", "")
        .unwrap();
    let phone = device_with(kit, keychain);
    phone.service.icloud_look(0).unwrap();
    phone.service.connect(true).unwrap();
    assert_eq!(phone.service.pull("").unwrap().records.len(), 1);
    (mac, phone)
}

fn recovery_key_of(device: &Device) -> String {
    held(device).unwrap().recovery_key().to_string()
}

#[test]
fn leaving_removes_the_vault_from_the_apple_id_and_the_others_ask_first() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, phone) = two_in_the_vault(&kit, &keychain);
    let vault = held(&mac).unwrap().id().to_string();
    let key = recovery_key_of(&mac);

    let left = mac.service.icloud_leave(&key).unwrap();
    assert!(!left.vault && !left.enabled);
    assert_eq!(
        kit.deleted_zones(),
        [ZONE_DEVOT, vault_zone(&vault).as_str(), "devot-clock"]
    );
    assert!(handed_over(keychain.as_ref()).is_none());
    assert!(held(&mac).is_none());
    assert_eq!(mac.service.connect(true).err(), Some("E_SYNC_OFF"));
    assert_eq!(current_vault(&kit), None);

    let (saves, zones) = (kit.calls(Op::Save), kit.calls(Op::SaveZones));
    assert_eq!(phone.service.connect(true).err(), Some(error::DELETED));
    assert_eq!(kit.calls(Op::Save), saves, "it uploads nothing");
    assert_eq!(kit.calls(Op::SaveZones), zones, "and remakes no zone");
    assert!(
        held(&phone).unwrap().id().to_string() == vault,
        "it keeps its vault, to upload again or turn sync off"
    );
}

#[test]
fn leaving_needs_this_vault_s_recovery_key_and_deletes_nothing_without_it() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, _phone) = two_in_the_vault(&kit, &keychain);
    let other = Vault::generate().unwrap().recovery_key().to_string();
    for (key, refused) in [
        ("", "E_SYNC_RECOVERY_FORMAT"),
        ("not a key", "E_SYNC_RECOVERY_FORMAT"),
        (other.as_str(), "E_SYNC_RECOVERY_OTHER_VAULT"),
    ] {
        assert_eq!(mac.service.icloud_leave(key).err(), Some(refused), "{key}");
    }
    let long = "A".repeat(513);
    assert_eq!(
        mac.service.icloud_leave(&long).err(),
        Some("E_SYNC_RECOVERY_FORMAT")
    );
    assert_eq!(kit.calls(Op::DeleteZones), 0);
    assert!(handed_over(keychain.as_ref()).is_some());
    assert!(held(&mac).is_some() && mac.service.snapshot().enabled);
}

#[test]
fn leaving_needs_a_vault_on_icloud_and_the_apple_id_it_syncs_with() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    assert_eq!(
        mac.service.icloud_leave("x").err(),
        Some("E_SYNC_NO_VAULT_KEY")
    );
    Vault::create(mac.secrets.as_ref()).unwrap();
    let key = recovery_key_of(&mac);
    assert_eq!(
        mac.service.icloud_leave(&key).err(),
        Some("E_SYNC_ICLOUD_NOT_USED")
    );

    let first = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, _phone) = two_in_the_vault(&first, &keychain);
    first.switch_user("_user-two");
    assert_eq!(
        mac.service.icloud_leave(&recovery_key_of(&mac)).err(),
        Some(error::ACCOUNT_CHANGED)
    );
    assert_eq!(
        first.calls(Op::DeleteZones),
        0,
        "never another Apple ID's zones"
    );
    assert!(held(&mac).is_some());
}

#[test]
fn a_leave_that_failed_part_way_is_retried_to_the_same_end() {
    use super::cloudkit::error::code;
    use super::cloudkit::kit::CkError;
    let kit = Arc::new(Fake::new());
    let keychain = Flaky::failing_removals(1);
    let mac = device_of(
        &kit,
        Arc::clone(&keychain) as _,
        Arc::new(Secrets::default()),
        Gate::open(),
    );
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(true).unwrap();
    let vault = held(&mac).unwrap();
    let key = recovery_key_of(&mac);
    let zone = vault_zone(&vault.id().to_string());

    kit.fail_zone_delete(&zone, CkError::of(code::NETWORK_UNAVAILABLE));
    assert_eq!(mac.service.icloud_leave(&key).err(), Some(error::OFFLINE));
    assert!(kit.zone_exists(&zone) && !kit.zone_exists(ZONE_DEVOT));
    assert!(held(&mac).is_some() && handed_over(keychain.as_ref()).is_some());

    kit.fail_zone_delete("devot-clock", CkError::of(code::REQUEST_RATE_LIMITED));
    assert_eq!(mac.service.icloud_leave(&key).err(), Some(error::BUSY));
    assert!(!kit.zone_exists(&zone) && !kit.zone_exists(ZONE_DEVOT));
    assert!(held(&mac).is_some() && handed_over(keychain.as_ref()).is_some());

    assert_eq!(
        mac.service.icloud_leave(&key).err(),
        Some("E_SYNC_KEYCHAIN"),
        "the handover item could not be removed"
    );
    assert!(!kit.zone_exists("devot-clock"));
    assert!(
        held(&mac).is_some(),
        "the key stays here until the item is gone"
    );

    let left = mac.service.icloud_leave(&key).unwrap();
    assert!(!left.vault && !left.enabled);
    assert!(handed_over(keychain.as_ref()).is_none() && held(&mac).is_none());
    assert_eq!(
        kit.deleted_zones(),
        [ZONE_DEVOT, zone.as_str(), "devot-clock"]
    );
}

#[test]
fn leaving_a_relay_vault_is_refused_for_a_vault_on_icloud() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    assert_eq!(mac.service.leave_vault().err(), Some("E_SYNC_LEAVE_ICLOUD"));
    assert!(held(&mac).is_some() && mac.service.snapshot().enabled);
}

#[test]
fn a_device_that_connects_part_way_through_a_leave_stops_instead_of_making_the_vault_again() {
    use super::cloudkit::error::code;
    use super::cloudkit::kit::CkError;
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, phone) = two_in_the_vault(&kit, &keychain);
    let joiner = device_with(&kit, &keychain);
    joiner.service.icloud_look(0).unwrap();
    let zone = vault_zone(&held(&mac).unwrap().id().to_string());
    let key = recovery_key_of(&mac);

    // `current` is gone and the vault's zone is still there.
    kit.fail_zone_delete(&zone, CkError::of(code::NETWORK_UNAVAILABLE));
    assert_eq!(mac.service.icloud_leave(&key).err(), Some(error::OFFLINE));
    assert_eq!(current_vault(&kit), None);
    assert!(kit.zone_exists(&zone));

    let (saves, zones) = (kit.calls(Op::Save), kit.calls(Op::SaveZones));
    assert_eq!(phone.service.connect(true).err(), Some(error::DELETED));
    assert_eq!(joiner.service.connect(false).err(), Some(error::DELETED));
    assert_eq!(kit.calls(Op::Save), saves, "nothing uploaded");
    assert_eq!(kit.calls(Op::SaveZones), zones, "no zone made again");

    mac.service.icloud_leave(&key).unwrap();
    for zone in [zone.as_str(), ZONE_DEVOT, "devot-clock"] {
        assert!(!kit.zone_exists(zone), "{zone}");
    }
    assert_eq!(joiner.service.connect(false).err(), Some(error::DELETED));
    assert_eq!(kit.calls(Op::SaveZones), zones, "still none made again");
}

#[test]
fn a_recovery_key_entered_part_way_through_a_leave_is_refused() {
    use super::cloudkit::error::code;
    use super::cloudkit::kit::CkError;
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, _phone) = two_in_the_vault(&kit, &keychain);
    let zone = vault_zone(&held(&mac).unwrap().id().to_string());
    let key = recovery_key_of(&mac);
    kit.fail_zone_delete(&zone, CkError::of(code::NETWORK_UNAVAILABLE));
    assert_eq!(mac.service.icloud_leave(&key).err(), Some(error::OFFLINE));
    assert!(kit.zone_exists(&zone) && !kit.zone_exists(ZONE_DEVOT));

    let owner = device(&kit);
    let (saves, zones) = (kit.calls(Op::Save), kit.calls(Op::SaveZones));
    assert_eq!(
        owner.service.use_icloud(Some(&key), 0).err(),
        Some(error::LEAVING),
        "the vault is about to vanish"
    );
    assert!(held(&owner).is_none());
    assert!(!owner.service.snapshot().enabled);
    assert_eq!(current_vault(&kit), None, "current is not claimed again");
    assert_eq!(kit.calls(Op::Save), saves);
    assert_eq!(
        kit.calls(Op::SaveZones),
        zones,
        "zone devot is not made again"
    );

    mac.service.icloud_leave(&key).unwrap();
    assert_eq!(
        owner.service.use_icloud(Some(&key), 0).err(),
        Some("E_SYNC_ICLOUD_NO_VAULT"),
        "once left, the vault is not on this Apple ID"
    );
}

#[test]
fn upload_again_part_way_through_a_leave_syncs_until_the_leave_is_retried() {
    use super::cloudkit::error::code;
    use super::cloudkit::kit::CkError;
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, phone) = two_in_the_vault(&kit, &keychain);
    let vault = held(&mac).unwrap().id().to_string();
    let zone = vault_zone(&vault);
    let key = recovery_key_of(&mac);
    kit.fail_zone_delete(&zone, CkError::of(code::NETWORK_UNAVAILABLE));
    assert_eq!(mac.service.icloud_leave(&key).err(), Some(error::OFFLINE));
    assert_eq!(phone.service.connect(true).err(), Some(error::DELETED));

    // Not refused: if the leave is never retried, Upload Again is the way back.
    phone.service.icloud_upload_again().unwrap();
    phone.service.connect(true).unwrap();
    assert_eq!(current_vault(&kit), Some(vault.clone()));
    assert!(kit.record(ZONE_DEVOT, &format!("meta-{vault}")).is_some());

    mac.service.icloud_leave(&key).unwrap();
    for zone in [zone.as_str(), ZONE_DEVOT, "devot-clock"] {
        assert!(!kit.zone_exists(zone), "{zone}");
    }
    assert_eq!(phone.service.connect(true).err(), Some(error::DELETED));
}

#[test]
fn a_device_that_never_synced_stops_after_a_leave_instead_of_making_the_vault_again() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let mac = device_with(&kit, &keychain);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(true).unwrap();
    let vault = held(&mac).unwrap().id().to_string();
    let phone = device_with(&kit, &keychain);
    phone.service.icloud_look(0).unwrap();
    phone.service.connect(false).unwrap();
    phone.service.disconnect();
    // Joined through the keychain before the leave, and connects only after it.
    let joiner = device_with(&kit, &keychain);
    joiner.service.icloud_look(0).unwrap();

    mac.service.icloud_leave(&recovery_key_of(&mac)).unwrap();
    let (saves, zones) = (kit.calls(Op::Save), kit.calls(Op::SaveZones));
    assert_eq!(phone.service.connect(false).err(), Some(error::DELETED));
    assert_eq!(joiner.service.connect(false).err(), Some(error::DELETED));
    assert_eq!(kit.calls(Op::Save), saves, "nothing uploaded");
    assert_eq!(kit.calls(Op::SaveZones), zones, "no zone made again");
    assert!(
        handed_over(keychain.as_ref()).is_none(),
        "no item written again"
    );
    assert_eq!(current_vault(&kit), None);

    phone.service.icloud_upload_again().unwrap();
    phone.service.connect(true).unwrap();
    assert!(kit.zone_exists(&vault_zone(&vault)));
    assert_eq!(current_vault(&kit), Some(vault));
}

/// `device` signed in to another Apple ID, `kit`, whose iCloud Keychain is `keychain`.
fn on_apple_id(kit: &Arc<Fake>, device: &Device, keychain: &Arc<Secrets>) -> SyncService {
    SyncService::new(
        SettingsStore::new(&device._dir.path().join(FILE)),
        Arc::clone(&device.secrets),
        Arc::new(|_, _| ()),
        Gate::open(),
    )
    .with_icloud(Arc::clone(kit) as _)
    .with_handover(Arc::clone(keychain) as _)
}

#[test]
fn an_account_change_keeps_the_item_of_a_vault_the_new_apple_id_syncs() {
    let first = Arc::new(Fake::new());
    let (mac, phone) = two_in_the_vault(&first, &Arc::new(Secrets::default()));
    let vault = held(&mac).unwrap();

    let second = Arc::new(Fake::new());
    second.switch_user("_user-two");
    let theirs = Arc::new(Secrets::default());
    let moved = on_apple_id(&second, &phone, &theirs);
    assert_eq!(moved.connect(true).err(), Some(error::ACCOUNT_CHANGED));
    moved.icloud_upload_again().unwrap();
    moved.connect(true).unwrap();
    assert!(handed_over(theirs.as_ref()).unwrap().same(&vault));

    let mac_there = on_apple_id(&second, &mac, &theirs);
    assert_eq!(mac_there.connect(true).err(), Some(error::ACCOUNT_CHANGED));
    assert!(
        handed_over(theirs.as_ref()).unwrap().same(&vault),
        "the new Apple ID syncs the vault: its item stays"
    );
}

#[test]
fn a_vault_never_connected_is_left_only_from_the_apple_id_current_names_it_on() {
    let first = Arc::new(Fake::new());
    let mac = device(&first);
    mac.service.use_icloud(None, 0).unwrap();
    let key = recovery_key_of(&mac);
    let second = Arc::new(Fake::new());
    second.switch_user("_user-two");
    let elsewhere = on_apple_id(&second, &mac, &Arc::new(Secrets::default()));
    assert_eq!(
        elsewhere.icloud_leave(&key).err(),
        Some("E_SYNC_ICLOUD_NO_VAULT")
    );
    device(&second).service.use_icloud(None, 0).unwrap();
    assert_eq!(
        elsewhere.icloud_leave(&key).err(),
        Some("E_SYNC_ICLOUD_NO_VAULT")
    );
    assert_eq!(second.calls(Op::DeleteZones), 0);
    assert!(held(&mac).is_some());

    use super::cloudkit::error::code;
    use super::cloudkit::kit::CkError;
    first.fail_zone_delete("devot-clock", CkError::of(code::REQUEST_RATE_LIMITED));
    assert_eq!(mac.service.icloud_leave(&key).err(), Some(error::BUSY));
    assert_eq!(current_vault(&first), None);
    let left = mac.service.icloud_leave(&key).unwrap();
    assert!(
        !left.vault && held(&mac).is_none(),
        "a retry ends the leave"
    );
}

#[test]
fn turning_sync_off_keeps_the_vault_on_icloud() {
    let kit = Arc::new(Fake::new());
    let keychain = Arc::new(Secrets::default());
    let (mac, _phone) = two_in_the_vault(&kit, &keychain);
    let off = mac
        .service
        .set(super::service::SettingsPatch {
            enabled: Some(false),
            ..Default::default()
        })
        .unwrap();
    assert!(off.vault && !off.enabled);
    assert_eq!(off.transport, "icloud");
    assert_eq!(kit.calls(Op::DeleteZones), 0);
    assert!(handed_over(keychain.as_ref()).is_some());
}

#[test]
fn a_recovery_key_works_on_icloud_only_for_the_vault_current_names() {
    let kit = Arc::new(Fake::new());
    let on_relay = Vault::generate().unwrap();
    let phone = device(&kit);
    assert_eq!(
        phone
            .service
            .use_icloud(Some(&on_relay.recovery_key()), 0)
            .err(),
        Some("E_SYNC_ICLOUD_NO_VAULT"),
        "not on this Apple ID's iCloud yet"
    );
    assert!(held(&phone).is_none());

    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    assert_eq!(
        phone
            .service
            .use_icloud(Some(&on_relay.recovery_key()), 0)
            .err(),
        Some("E_SYNC_ICLOUD_OTHER_VAULT")
    );
    assert!(held(&phone).is_none());
}

#[test]
fn a_recovery_key_claims_current_for_a_vault_whose_zone_came_before_it() {
    use super::cloudkit::kit::CloudKit as _;
    let kit = Arc::new(Fake::new());
    let vault = Vault::generate().unwrap();
    let id = vault.id().to_string();
    kit.save_zones(&[ZONE_DEVOT.to_string(), vault_zone(&id)])
        .unwrap();
    assert_eq!(current_vault(&kit), None);

    let phone = device(&kit);
    let snapshot = phone
        .service
        .use_icloud(Some(&vault.recovery_key()), 0)
        .unwrap();
    assert!(snapshot.enabled && snapshot.vault);
    assert!(held(&phone).unwrap().same(&vault));
    assert_eq!(current_vault(&kit), Some(id));
}

mod moving_from_a_relay {
    use super::super::moved::{self, MOVED_ID};
    use super::super::relay_tests::{NodeRelay, SECRET, service_on};
    use super::super::service::StatusView;
    use super::*;

    struct OnRelay {
        service: SyncService,
        secrets: Arc<Secrets>,
        dir: tempfile::TempDir,
    }

    fn on_relay(relay: &NodeRelay, kit: &Arc<Fake>) -> OnRelay {
        let dir = tempfile::tempdir().unwrap();
        let secrets: Arc<Secrets> = Arc::default();
        let service = launch(relay, kit, &dir, &secrets);
        OnRelay {
            service,
            secrets,
            dir,
        }
    }

    fn launch(
        relay: &NodeRelay,
        kit: &Arc<Fake>,
        dir: &tempfile::TempDir,
        secrets: &Arc<Secrets>,
    ) -> SyncService {
        service_on(relay, dir.path(), Arc::clone(secrets))
            .with_icloud(Arc::clone(kit) as _)
            .with_handover(Arc::new(Secrets::default()))
    }

    /// The app quits and opens again: a new service on the same settings and keychain.
    fn relaunch(device: OnRelay, relay: &NodeRelay, kit: &Arc<Fake>) -> OnRelay {
        let OnRelay {
            service,
            secrets,
            dir,
        } = device;
        drop(service);
        let service = launch(relay, kit, &dir, &secrets);
        OnRelay {
            service,
            secrets,
            dir,
        }
    }

    fn vault_id(device: &OnRelay) -> String {
        Vault::load(device.secrets.as_ref())
            .unwrap()
            .unwrap()
            .id()
            .to_string()
    }

    fn kept_unseen(device: &OnRelay) -> Option<super::super::settings::Unseen> {
        SettingsStore::new(&device.dir.path().join(FILE))
            .get()
            .unseen
    }

    fn moving(device: &OnRelay) -> String {
        SettingsStore::new(&device.dir.path().join(FILE))
            .get()
            .moving
    }

    /// `use_icloud` on `device` quits between the marker and the switch: `current` claimed, the
    /// move recorded, and the marker on the relay.
    fn quit_after_the_marker(device: &OnRelay, kit: &Arc<Fake>) {
        let id = vault_id(device);
        device.service.quit_before_next_switch();
        assert_eq!(
            device.service.use_icloud(None, 3).err(),
            Some("E_TEST_QUIT")
        );
        assert_eq!(moving(device), id);
        assert_eq!(
            super::super::cloudkit::current::read(kit.as_ref()).unwrap(),
            Some(id)
        );
        assert_eq!(marker_on_relay(device), Some(b64(&moved::body("icloud"))));
    }

    /// As `use_icloud` leaves `device` when the app quits after it recorded the move and before
    /// it left the marker, a point no fault in a test can reach.
    fn quit_before_the_marker(device: &OnRelay, kit: &Arc<Fake>) {
        let id = vault_id(device);
        super::super::cloudkit::current::claim(kit.as_ref(), &id).unwrap();
        let store = SettingsStore::new(&device.dir.path().join(FILE));
        let mut settings = store.get();
        settings.moving = id;
        store.set(&settings).unwrap();
    }

    /// `current` names `vault` alone, as on another Apple ID's iCloud or a restored backup.
    fn current_names(kit: &Arc<Fake>, vault: Option<&str>) {
        kit.delete_zone(ZONE_DEVOT);
        if let Some(vault) = vault {
            super::super::cloudkit::current::claim(kit.as_ref(), vault).unwrap();
        }
    }

    fn stopped_on_the_marker() -> StatusView {
        StatusView {
            state: "stopped".into(),
            code: Some("E_SYNC_VAULT_MOVED".into()),
            ..StatusView::default()
        }
    }

    /// The first device's vault on the relay, and a second device joined to it there.
    fn two_on_relay(relay: &NodeRelay, kit: &Arc<Fake>) -> (OnRelay, OnRelay) {
        let mac = on_relay(relay, kit);
        let key = mac
            .service
            .create_vault(SECRET)
            .unwrap()
            .recovery_key
            .unwrap();
        let phone = on_relay(relay, kit);
        phone.service.join_with_recovery(&key).unwrap();
        (mac, phone)
    }

    fn marker_on_relay(device: &OnRelay) -> Option<String> {
        device.service.connect(false).unwrap();
        let page = device.service.pull("").unwrap();
        device.service.disconnect();
        page.records
            .into_iter()
            .find(|r| r.id == MOVED_ID)
            .and_then(|r| r.data)
    }

    #[test]
    fn a_relay_vault_moved_to_icloud_leaves_the_marker_on_the_relay_first() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, phone) = two_on_relay(&relay, &kit);
        let moved_to = mac.service.use_icloud(None, 3).unwrap();
        assert_eq!(moved_to.transport, "icloud");
        assert!(!moved_to.move_started);
        assert_eq!(moving(&mac), "");
        assert_eq!(marker_on_relay(&phone), Some(b64(&moved::body("icloud"))));
        assert_eq!(
            super::super::cloudkit::current::read(kit.as_ref()).unwrap(),
            Some(
                Vault::load(mac.secrets.as_ref())
                    .unwrap()
                    .unwrap()
                    .id()
                    .to_string()
            )
        );
        // Moving again (a retry after a lost answer) writes over the marker.
        mac.service.use_icloud(None, 3).unwrap();
    }

    #[test]
    fn a_relay_vault_stays_on_the_relay_when_the_marker_cannot_be_left() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        drop(relay);
        assert!(mac.service.use_icloud(None, 3).is_err());
        let snapshot = mac.service.snapshot();
        assert_eq!(snapshot.transport, "relay");
        assert!(!snapshot.move_started);
        assert_eq!(moving(&mac), "");
    }

    #[test]
    fn leaving_the_relay_vault_calls_off_a_move_to_icloud_under_way() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        quit_after_the_marker(&mac, &kit);
        assert!(mac.service.snapshot().move_started);
        let left = mac.service.leave_vault().unwrap();
        assert!(!left.vault && !left.move_started);
        assert_eq!(moving(&mac), "");
        assert_eq!(kept_unseen(&mac), None);
        mac.service.report(stopped_on_the_marker()).unwrap();
        assert_eq!(
            mac.service.snapshot().transport,
            "relay",
            "no move finishes"
        );
    }

    #[test]
    fn a_device_that_quit_after_leaving_the_marker_finishes_the_move_at_its_next_launch() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        let id = vault_id(&mac);
        quit_after_the_marker(&mac, &kit);
        let mac = relaunch(mac, &relay, &kit);
        let launched = mac.service.snapshot();
        assert_eq!(launched.transport, "relay");
        assert!(launched.move_started);
        // Its engine pulls its own marker and stops on it, which finishes the move here.
        assert_eq!(marker_on_relay(&mac), Some(b64(&moved::body("icloud"))));
        mac.service.report(stopped_on_the_marker()).unwrap();
        let finished = mac.service.snapshot();
        assert_eq!(finished.transport, "icloud");
        assert!(finished.enabled && !finished.move_started);
        assert_eq!(finished.status.state, "connecting");
        assert_eq!(finished.status.code, None);
        assert_eq!(moving(&mac), "");
        assert_eq!(
            super::super::cloudkit::current::read(kit.as_ref()).unwrap(),
            Some(id)
        );
        assert!(matches!(
            mac.service.connect(false).unwrap(),
            Connected::ICloud(_)
        ));
    }

    #[test]
    fn a_started_move_that_cannot_finish_yet_stops_and_says_it_started_here() {
        use super::super::cloudkit::kit::Account;
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        quit_after_the_marker(&mac, &kit);
        let mac = relaunch(mac, &relay, &kit);
        kit.set_account(Account::Missing);
        mac.service.report(stopped_on_the_marker()).unwrap();
        let stopped = mac.service.snapshot();
        assert_eq!(stopped.transport, "relay");
        assert_eq!(stopped.status, stopped_on_the_marker());
        assert!(stopped.move_started);
        // Signed in again, the owner finishes it from Settings without leaving the marker twice.
        kit.set_account(Account::Available);
        drop(relay);
        let followed = mac.service.use_icloud(None, 3).unwrap();
        assert_eq!(followed.transport, "icloud");
        assert!(!followed.move_started);
        assert_eq!(moving(&mac), "");
    }

    /// Without the owner, a vault never goes to an iCloud the other devices may not follow.
    fn waits_for_the_owner(current: Option<&str>) {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        quit_after_the_marker(&mac, &kit);
        let mac = relaunch(mac, &relay, &kit);
        current_names(&kit, current);
        mac.service.report(stopped_on_the_marker()).unwrap();
        let stopped = mac.service.snapshot();
        assert_eq!(stopped.transport, "relay");
        assert_eq!(stopped.status, stopped_on_the_marker());
        assert!(stopped.move_started);
        assert_eq!(moving(&mac), vault_id(&mac));
        assert_eq!(
            super::super::cloudkit::current::read(kit.as_ref()).unwrap(),
            current.map(str::to_string)
        );
    }

    #[test]
    fn a_started_move_waits_for_the_owner_when_current_names_no_vault() {
        waits_for_the_owner(None);
    }

    #[test]
    fn a_started_move_waits_for_the_owner_when_current_names_another_vault() {
        let other = Vault::generate().unwrap().id().to_string();
        waits_for_the_owner(Some(&other));
    }

    #[test]
    fn turning_sync_off_forgets_a_started_move() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        quit_after_the_marker(&mac, &kit);
        let off = mac
            .service
            .set(super::super::service::SettingsPatch {
                relay_url: None,
                enabled: Some(false),
            })
            .unwrap();
        assert!(!off.move_started);
        assert_eq!(moving(&mac), "");
        assert_eq!(kept_unseen(&mac), None);
    }

    #[test]
    fn another_relay_forgets_a_started_move() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        quit_after_the_marker(&mac, &kit);
        let same = mac
            .service
            .set(super::super::service::SettingsPatch {
                relay_url: Some(relay.url.as_str().to_string()),
                enabled: None,
            })
            .unwrap();
        assert!(same.move_started);
        assert!(kept_unseen(&mac).is_some());
        let elsewhere = mac
            .service
            .set(super::super::service::SettingsPatch {
                relay_url: Some("https://relay.example.com".into()),
                enabled: None,
            })
            .unwrap();
        assert!(!elsewhere.move_started);
        assert_eq!(moving(&mac), "");
        assert_eq!(kept_unseen(&mac), None);
    }

    #[test]
    fn a_marker_from_another_device_finishes_a_move_that_quit_before_its_own_marker() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, phone) = two_on_relay(&relay, &kit);
        quit_before_the_marker(&mac, &kit);
        let mac = relaunch(mac, &relay, &kit);
        assert!(mac.service.snapshot().move_started);
        assert_eq!(marker_on_relay(&mac), None);
        phone.service.use_icloud(None, 3).unwrap();
        assert_eq!(marker_on_relay(&mac), Some(b64(&moved::body("icloud"))));
        // The owner asked this device to move the vault `current` names, so it switches.
        mac.service.report(stopped_on_the_marker()).unwrap();
        let finished = mac.service.snapshot();
        assert_eq!(finished.transport, "icloud");
        assert!(!finished.move_started);
        assert_eq!(moving(&mac), "");
    }

    fn relay_device(device: &OnRelay) -> String {
        super::super::settings::DeviceCredentials::load(device.secrets.as_ref())
            .unwrap()
            .unwrap()
            .device
    }

    fn unseen(device: &OnRelay) -> Vec<super::super::client::DeviceInfo> {
        let listed = device.service.devices().unwrap();
        listed.into_iter().filter(|d| d.unseen).collect()
    }

    #[test]
    fn the_moving_device_lists_the_relay_s_devices_not_seen_on_icloud_until_each_follows() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let mac = on_relay(&relay, &kit);
        let key = mac
            .service
            .create_vault(SECRET)
            .unwrap()
            .recovery_key
            .unwrap();
        let phone = on_relay(&relay, &kit);
        phone.service.join_with_recovery(&key).unwrap();
        let pad = on_relay(&relay, &kit);
        pad.service.join_with_recovery(&key).unwrap();
        mac.service.use_icloud(None, 3).unwrap();
        mac.service.connect(false).unwrap();

        let waiting = unseen(&mac);
        let mut ids: Vec<_> = waiting.iter().map(|d| d.id.clone()).collect();
        ids.sort();
        let mut expected = vec![relay_device(&phone), relay_device(&pad)];
        expected.sort();
        assert_eq!(ids, expected);
        assert!(waiting.iter().all(|d| !d.current && d.created > 0));
        assert!(waiting.iter().all(|d| d.label == "Devot for macOS"));
        assert_eq!(mac.service.devices().unwrap().len(), 3);

        phone.service.report(stopped_on_the_marker()).unwrap();
        phone.service.use_icloud(None, 3).unwrap();
        phone.service.connect(false).unwrap();
        let waiting = unseen(&mac);
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].id, relay_device(&pad));
        let listed = mac.service.devices().unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed.iter().filter(|d| !d.unseen).count(), 2);

        // The device that followed names nobody: only the device that moved the vault does.
        assert!(unseen(&phone).is_empty());

        drop(relay);
        pad.service.report(stopped_on_the_marker()).unwrap();
        pad.service.use_icloud(None, 3).unwrap();
        pad.service.connect(false).unwrap();
        assert!(unseen(&mac).is_empty());
        assert_eq!(mac.service.devices().unwrap().len(), 3);
    }

    #[test]
    fn a_device_off_the_list_stays_off_it() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, phone) = two_on_relay(&relay, &kit);
        mac.service.use_icloud(None, 3).unwrap();
        mac.service.connect(false).unwrap();
        phone.service.report(stopped_on_the_marker()).unwrap();
        phone.service.use_icloud(None, 3).unwrap();
        phone.service.connect(false).unwrap();
        assert!(unseen(&mac).is_empty());
        let settings = SettingsStore::new(&mac.dir.path().join(FILE)).get();
        assert_eq!(settings.unseen, None);
    }

    #[test]
    fn leaving_icloud_forgets_the_devices_not_seen() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let mac = on_relay(&relay, &kit);
        let key = mac
            .service
            .create_vault(SECRET)
            .unwrap()
            .recovery_key
            .unwrap();
        let phone = on_relay(&relay, &kit);
        phone.service.join_with_recovery(&key).unwrap();
        mac.service.use_icloud(None, 3).unwrap();
        mac.service.connect(false).unwrap();
        assert_eq!(unseen(&mac).len(), 1);
        mac.service.icloud_leave(&key).unwrap();
        let settings = SettingsStore::new(&mac.dir.path().join(FILE)).get();
        assert_eq!(settings.unseen, None);
    }

    #[test]
    fn a_move_finished_at_the_next_launch_still_lists_the_devices_not_seen() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, phone) = two_on_relay(&relay, &kit);
        quit_after_the_marker(&mac, &kit);
        let mac = relaunch(mac, &relay, &kit);
        assert_eq!(marker_on_relay(&mac), Some(b64(&moved::body("icloud"))));
        mac.service.report(stopped_on_the_marker()).unwrap();
        mac.service.connect(false).unwrap();
        let waiting = unseen(&mac);
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].id, relay_device(&phone));
    }

    #[test]
    fn a_marker_the_relay_refuses_forgets_the_devices_kept_for_the_move() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        mac.service.fail_next_marker();
        assert_eq!(mac.service.use_icloud(None, 3).err(), Some("E_TEST_MARKER"));
        assert_eq!(moving(&mac), "");
        assert_eq!(kept_unseen(&mac), None);
    }

    #[test]
    fn a_device_list_the_relay_could_not_give_still_moves_the_vault() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, _phone) = two_on_relay(&relay, &kit);
        mac.service.fail_next_device_list();
        let moved_to = mac.service.use_icloud(None, 3).unwrap();
        assert_eq!(moved_to.transport, "icloud");
        mac.service.connect(false).unwrap();
        assert!(unseen(&mac).is_empty());
        assert_eq!(mac.service.devices().unwrap().len(), 1);
    }

    #[test]
    fn a_device_that_follows_the_marker_moves_without_the_relay() {
        let relay = NodeRelay::start();
        let kit = Arc::new(Fake::new());
        let (mac, phone) = two_on_relay(&relay, &kit);
        mac.service.use_icloud(None, 3).unwrap();
        drop(relay);
        phone.service.report(stopped_on_the_marker()).unwrap();
        // A move another device started is followed only when the owner asks.
        let stopped = phone.service.snapshot();
        assert_eq!(stopped.transport, "relay");
        assert!(!stopped.move_started);
        let followed = phone.service.use_icloud(None, 3).unwrap();
        assert_eq!(followed.transport, "icloud");
        assert!(
            Vault::load(phone.secrets.as_ref())
                .unwrap()
                .unwrap()
                .same(&Vault::load(mac.secrets.as_ref()).unwrap().unwrap())
        );
    }
}
