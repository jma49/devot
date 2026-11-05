//! The service with a vault on iCloud, against the in-memory CloudKit (`cloudkit::fake`).

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value as Json, json};

use super::Vault;
use super::cloudkit::error;
use super::cloudkit::fake::{Fake, Op};
use super::cloudkit::kit::{ZONE_DEVOT, vault_zone};
use super::relay_tests::Secrets;
use super::service::{Connected, PushDto, PushItemDto, SyncService};
use super::settings::{FILE, SettingsStore};
use crate::licence::Gate;

const NOTE: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789a1";
const OTHER: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789a2";

type Events = Arc<Mutex<Vec<(String, Json)>>>;

struct Device {
    service: SyncService,
    secrets: Arc<Secrets>,
    events: Events,
    _dir: tempfile::TempDir,
}

fn device(kit: &Arc<Fake>) -> Device {
    device_with(kit, &Arc::new(Secrets::default()))
}

/// A device on the Apple ID `kit` stands for, whose iCloud Keychain is `keychain`.
fn device_with(kit: &Arc<Fake>, keychain: &Arc<Secrets>) -> Device {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(Secrets::default());
    let events: Events = Arc::default();
    let sent = Arc::clone(&events);
    let service = SyncService::new(
        SettingsStore::new(&dir.path().join(FILE)),
        Arc::clone(&secrets) as _,
        Arc::new(move |event: &str, payload: Json| {
            sent.lock().unwrap().push((event.to_string(), payload));
        }),
        Gate::open(),
    )
    .with_icloud(Arc::clone(kit) as _)
    .with_handover(Arc::clone(keychain) as _);
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
fn refuses_a_batch_too_large_or_with_a_bad_tag_before_any_upload() {
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
    assert_eq!(
        mac.service
            .push_many(&[item(NOTE, 0, b"x", "not base64!")])
            .err(),
        Some("E_SYNC_TAG_INVALID")
    );
    assert_eq!(kit.calls(Op::Save), saves);
}

#[test]
fn a_full_icloud_pauses_with_its_code_and_no_end() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None, 0).unwrap();
    mac.service.connect(false).unwrap();
    kit.fail_record(
        NOTE,
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

fn handed_over(keychain: &Secrets) -> Option<Vault> {
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
        handed_over(&keychain).unwrap().same(&vault),
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
    assert!(handed_over(&keychain).unwrap().same(&held(&mac).unwrap()));

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
        Some("E_SYNC_ICLOUD_OTHER_ACCOUNT"),
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
        handed_over(&keychain).unwrap().same(&vault),
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
