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
    .with_icloud(Arc::clone(kit) as _);
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
    assert_eq!(mac.service.use_icloud(None).err(), Some(error::UNAVAILABLE));
    assert!(!mac.service.snapshot().vault, "no vault is made for it");
}

#[test]
fn a_vault_moved_to_a_build_without_the_container_reports_unavailable() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None).unwrap();
    let state = std::fs::read(mac._dir.path().join(FILE)).unwrap();
    let unsigned = Arc::new(Fake::new().without_entitlement());
    let again = device(&unsigned);
    std::fs::write(again._dir.path().join(FILE), state).unwrap();
    let vault = Vault::load(mac.secrets.as_ref()).unwrap().unwrap();
    Vault::join(again.secrets.as_ref(), vault).unwrap();
    assert_eq!(again.service.connect(false).err(), Some(error::UNAVAILABLE));
}

#[test]
fn uses_icloud_with_a_new_vault_and_shows_its_recovery_key_once() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    let snapshot = mac.service.use_icloud(None).unwrap();
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
    mac.service.use_icloud(None).unwrap();
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
    let snapshot = phone.service.use_icloud(Some(&key)).unwrap();
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
    mac.service.use_icloud(None).unwrap();
    let other = Vault::create(&Secrets::default()).unwrap();
    assert_eq!(
        mac.service.use_icloud(Some(&other.recovery_key())).err(),
        Some("E_SYNC_VAULT_EXISTS")
    );
    assert_eq!(
        mac.service.use_icloud(Some(&"A".repeat(513))).err(),
        Some("E_SYNC_RECOVERY_FORMAT")
    );
}

#[test]
fn pushes_a_batch_and_answers_each_item_in_order() {
    let kit = Arc::new(Fake::new());
    let mac = device(&kit);
    mac.service.use_icloud(None).unwrap();
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
    mac.service.use_icloud(None).unwrap();
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
    mac.service.use_icloud(None).unwrap();
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
    mac.service.use_icloud(None).unwrap();
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

    mac.service.use_icloud(None).unwrap();
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
