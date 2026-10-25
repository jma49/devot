use std::collections::BTreeSet;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::format::{verify_licence, verify_revocations};
use super::keys::{PRODUCTION, TEST, decode_key};
use super::store::MemoryKey;
use super::testing::{ID, LICENSEE, key, licence_json, sign, sign_raw, test_keys, vectors};
use super::*;

fn str_of<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().expect(field)
}

const OTHER_ID: &str = "3f4lHWhFWnUPeDt7yIa3rw";

fn list(issued_at: &str, ids: &[&str]) -> String {
    sign(
        "devot1rev",
        &json!({ "kid": "test", "issuedAt": issued_at, "ids": ids }),
    )
}

#[test]
fn every_valid_vector_verifies_to_its_payload() {
    let v = vectors();
    let keys = test_keys(false);
    let licences = v["licences"].as_array().expect("licences");
    assert!(!licences.is_empty());
    for entry in licences {
        let payload = verify_licence(str_of(entry, "key"), &keys)
            .unwrap_or_else(|e| panic!("{}: {e:?}", str_of(entry, "name")));
        let expected = &entry["payload"];
        assert_eq!(payload.id, str_of(expected, "id"));
        assert_eq!(payload.kid, str_of(expected, "kid"));
        assert_eq!(payload.licensee, str_of(expected, "licensee"));
        assert_eq!(payload.issued_at, str_of(expected, "issuedAt"));
        assert_eq!(str_of(expected, "plan"), "pro");
    }
}

#[test]
fn every_invalid_vector_fails_with_its_code() {
    let v = vectors();
    let keys = test_keys(false);
    let invalid = v["invalid"].as_array().expect("invalid");
    assert!(!invalid.is_empty());
    for entry in invalid {
        let got = verify_licence(str_of(entry, "key"), &keys).map(|_| ());
        assert_eq!(
            got.map_err(VerifyError::code),
            Err(str_of(entry, "code")),
            "{}",
            str_of(entry, "name")
        );
    }
}

#[test]
fn the_revocation_list_verifies_and_its_tampered_copies_fail() {
    let v = vectors();
    let keys = test_keys(false);
    let r = &v["revocations"];
    let verified = verify_revocations(str_of(r, "list"), &keys).expect("list");
    assert_eq!(verified.kid, str_of(&r["payload"], "kid"));
    assert_eq!(verified.issued_at, str_of(&r["payload"], "issuedAt"));
    let ids: BTreeSet<String> = r["payload"]["ids"]
        .as_array()
        .expect("ids")
        .iter()
        .map(|id| id.as_str().expect("id").to_owned())
        .collect();
    assert_eq!(verified.ids, ids);
    for copy in ["tampered", "licenceAsList"] {
        assert_eq!(
            verify_revocations(str_of(&r[copy], "list"), &keys).map_err(VerifyError::code),
            Err(str_of(&r[copy], "code")),
            "{copy}"
        );
    }
    assert_eq!(
        verify_licence(str_of(r, "list"), &keys).map(|_| ()),
        Err(VerifyError::Malformed)
    );
}

#[test]
fn the_vectors_key_is_the_test_key_the_build_holds() {
    let v = vectors();
    assert_eq!(str_of(&v["keys"][0], "kid"), TEST.0);
    assert_eq!(str_of(&v["keys"][0], "publicKey"), TEST.1);
    // The test key signs the keys these tests make.
    assert!(verify_licence(&key(ID), &test_keys(false)).is_ok());
    assert!(decode_key(TEST.1).is_some());
}

#[test]
fn production_keys_decode_and_are_never_the_test_key() {
    for (kid, raw) in PRODUCTION {
        assert!(decode_key(raw).is_some(), "{kid}");
        assert_ne!(*kid, TEST.0);
        assert_ne!(*raw, TEST.1);
        assert!(!kid.is_empty());
    }
    let mut kids: Vec<_> = PRODUCTION.iter().map(|(kid, _)| *kid).collect();
    kids.sort_unstable();
    kids.dedup();
    assert_eq!(kids.len(), PRODUCTION.len());
}

#[test]
fn the_built_in_keys_gate_only_once_a_production_key_ships() {
    let keys = PublicKeys::built_in();
    assert_eq!(keys.gated(), !PRODUCTION.is_empty());
    // Test and debug builds hold the test key too.
    assert!(verify_licence(&key(ID), &keys).is_ok());
}

#[test]
fn a_kid_the_build_does_not_hold_is_unknown() {
    let none = PublicKeys::new(&[], false);
    assert_eq!(
        verify_licence(&key(ID), &none).map(|_| ()),
        Err(VerifyError::UnknownKid)
    );
    let mut other = licence_json(ID);
    other["kid"] = json!("__proto__");
    assert_eq!(
        verify_licence(&sign("devot1", &other), &test_keys(false)).map(|_| ()),
        Err(VerifyError::UnknownKid)
    );
}

#[test]
fn malformed_keys_are_malformed() {
    let keys = test_keys(false);
    let good = key(ID);
    let (signed, signature) = good.rsplit_once('.').expect("three parts");
    let payload = signed.split_once('.').expect("prefix").1;
    let with = |field: &str, value: Value| {
        let mut payload = licence_json(ID);
        payload[field] = value;
        sign("devot1", &payload)
    };
    let without = |field: &str| {
        let mut payload = licence_json(ID);
        payload.as_object_mut().expect("object").remove(field);
        sign("devot1", &payload)
    };
    let mut bom = vec![0xEF, 0xBB, 0xBF];
    bom.extend(licence_json(ID).to_string().as_bytes());
    let cases = [
        format!("{good}{}", "A".repeat(MAX_LENGTH)),
        format!("{good}.x"),
        format!("devot1.{payload}"),
        format!("devot2.{payload}.{signature}"),
        format!("DEVOT1.{payload}.{signature}"),
        format!("devot1.{payload}=.{signature}"),
        format!("devot1.{payload}.{signature}=="),
        format!("devot1.+{}.{signature}", &payload[1..]),
        format!("devot1..{signature}"),
        format!("devot1.{payload}."),
        format!("devot1.{payload}.{}", &signature[..signature.len() - 2]),
        // The last character of a 64-byte signature carries 4 spare bits that must be zero.
        format!(
            "devot1.{payload}.{}{}",
            &signature[..signature.len() - 1],
            char::from(signature.as_bytes()[signature.len() - 1] + 1)
        ),
        format!(" {good}"),
        sign_raw("devot1", &bom),
        sign_raw("devot1", b"[1,2]"),
        sign_raw("devot1", b"not json"),
        sign_raw("devot1", &[0x7B, 0xFF, 0x7D]),
        with("plan", json!("team")),
        with("id", json!("short")),
        with("id", json!(format!("{ID}="))),
        with("licensee", json!("")),
        with("licensee", json!(7)),
        with("kid", json!(1)),
        with("issuedAt", json!("2026-10-24T09:30:00.000Z")),
        with("issuedAt", json!("2026-10-24")),
        without("id"),
        without("kid"),
        without("plan"),
        without("licensee"),
        without("issuedAt"),
    ];
    for case in &cases {
        assert_eq!(
            verify_licence(case, &keys).map(|_| ()),
            Err(VerifyError::Malformed),
            "{case}"
        );
    }
}

#[test]
fn fields_added_later_are_ignored_and_the_signature_covers_the_bytes_as_sent() {
    let keys = test_keys(false);
    let mut payload = licence_json(ID);
    payload["seats"] = json!(3);
    assert!(verify_licence(&sign("devot1", &payload), &keys).is_ok());
    // The same JSON with other spacing is other bytes: its own signature verifies, a borrowed one not.
    let spaced = sign_raw(
        "devot1",
        serde_json::to_string_pretty(&licence_json(ID))
            .expect("json")
            .as_bytes(),
    );
    assert!(verify_licence(&spaced, &keys).is_ok());
    let compact = key(ID);
    let borrowed = format!(
        "{}.{}",
        spaced.rsplit_once('.').expect("parts").0,
        compact.rsplit_once('.').expect("parts").1
    );
    assert_eq!(
        verify_licence(&borrowed, &keys).map(|_| ()),
        Err(VerifyError::Signature)
    );
}

#[test]
fn a_revocation_list_needs_its_own_shape() {
    let keys = test_keys(false);
    let bad = [
        sign(
            "devot1rev",
            &json!({"kid": "test", "issuedAt": "2026-11-01", "ids": []}),
        ),
        sign(
            "devot1rev",
            &json!({"kid": "test", "issuedAt": "2026-11-01T00:00:00Z", "ids": ["x"]}),
        ),
        sign(
            "devot1rev",
            &json!({"kid": "test", "issuedAt": "2026-11-01T00:00:00Z"}),
        ),
        sign(
            "devot1",
            &json!({"kid": "test", "issuedAt": "2026-11-01T00:00:00Z", "ids": []}),
        ),
    ];
    for list in &bad {
        assert_eq!(
            verify_revocations(list, &keys).map(|_| ()),
            Err(VerifyError::Malformed),
            "{list}"
        );
    }
    assert!(verify_revocations(&list("2026-11-01T00:00:00Z", &[]), &keys).is_ok());
}

struct Setup {
    licence: Licence,
    store: Arc<MemoryKey>,
    emitted: Arc<Mutex<Vec<Snapshot>>>,
    _dir: tempfile::TempDir,
}

fn setup_in(dir: tempfile::TempDir, gated: bool) -> Setup {
    let store = Arc::new(MemoryKey::default());
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&emitted);
    let licence = Licence::new(
        test_keys(gated),
        Arc::clone(&store) as Arc<dyn KeyStore>,
        dir.path(),
        Arc::new(move |s: &Snapshot| seen.lock().expect("emitted").push(s.clone())),
    );
    Setup {
        licence,
        store,
        emitted,
        _dir: dir,
    }
}

fn setup(gated: bool) -> Setup {
    setup_in(tempfile::tempdir().expect("temp dir"), gated)
}

#[test]
fn a_licence_unlocks_every_version_whatever_dates_it_carries() {
    let s = setup(true);
    let mut payload = licence_json(ID);
    payload["updatesUntil"] = json!("2000-01-01");
    let snapshot = s.licence.set(&sign("devot1", &payload)).expect("set");
    assert_eq!(snapshot.state, LicenceState::Valid);
    assert_eq!(s.licence.require(), Ok(()));
    let sent = serde_json::to_value(&snapshot).expect("json");
    assert_eq!(
        sent.as_object()
            .map(|o| o.keys().cloned().collect::<Vec<_>>()),
        Some(
            ["code", "gated", "id", "licensee", "plan", "state"]
                .map(String::from)
                .to_vec()
        )
    );
}

#[test]
fn reports_each_state() {
    let s = setup(true);
    let none = s.licence.snapshot();
    assert_eq!(none.state, LicenceState::None);
    assert!(none.gated);
    assert_eq!((none.id, none.licensee, none.code), (None, None, None));

    let snapshot = s.licence.set(&key(ID)).expect("set");
    assert_eq!(snapshot.state, LicenceState::Valid);
    assert_eq!(snapshot.id.as_deref(), Some(ID));
    assert_eq!(snapshot.licensee.as_deref(), Some(LICENSEE));
    assert_eq!(snapshot.plan, Some("pro"));

    assert_eq!(
        s.licence
            .apply_revocations(&list("2026-11-01T00:00:00Z", &[ID])),
        Ok(true)
    );
    assert_eq!(s.licence.snapshot().state, LicenceState::Revoked);

    // A key the keychain holds that no longer verifies (its kid was dropped, say).
    let fresh = setup(true);
    *fresh.store.key.lock().expect("key") =
        Some(str_of(&vectors()["invalid"][0], "key").to_owned());
    let invalid = fresh.licence.snapshot();
    assert_eq!(invalid.state, LicenceState::Invalid);
    assert_eq!(invalid.code, Some("E_LICENCE_SIGNATURE"));
    assert_eq!((invalid.id, invalid.licensee), (None, None));
}

#[test]
fn gated_sync_and_ai_need_a_valid_licence() {
    let s = setup(true);
    assert_eq!(s.licence.require(), Err(REQUIRED));
    s.licence.set(&key(ID)).expect("set");
    assert_eq!(s.licence.require(), Ok(()));
    s.licence
        .apply_revocations(&list("2026-11-01T00:00:00Z", &[ID]))
        .expect("list");
    assert_eq!(s.licence.require(), Err(REQUIRED));
    s.licence.remove().expect("remove");
    assert_eq!(s.licence.require(), Err(REQUIRED));
}

#[test]
fn ungated_builds_need_no_licence_and_do_not_read_the_keychain_to_say_so() {
    let s = setup(false);
    assert_eq!(s.licence.require(), Ok(()));
    assert_eq!(s.store.reads.load(Ordering::SeqCst), 0);
    *s.store.key.lock().expect("key") = Some("devot1.garbage".into());
    assert_eq!(s.licence.require(), Ok(()));
    assert!(!s.licence.snapshot().gated);
}

#[test]
fn the_keychain_is_read_once() {
    let s = setup(true);
    s.licence.snapshot();
    s.licence.require().expect_err("no licence");
    s.licence.snapshot();
    assert_eq!(s.store.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn an_unreadable_keychain_item_can_still_be_replaced_or_removed() {
    let s = setup(true);
    s.store.unreadable.store(true, Ordering::SeqCst);
    let unread = s.licence.snapshot();
    assert_eq!(
        (unread.state, unread.code),
        (LicenceState::None, Some("E_LICENCE_KEYCHAIN"))
    );
    let good = key(ID);
    assert_eq!(
        s.licence.set(&good).expect("set").state,
        LicenceState::Valid
    );
    assert_eq!(s.licence.require(), Ok(()));
    assert_eq!(
        s.store.key.lock().expect("key").as_deref(),
        Some(good.as_str())
    );

    let other = setup(true);
    other.store.unreadable.store(true, Ordering::SeqCst);
    let removed = other.licence.remove().expect("remove");
    assert_eq!((removed.state, removed.code), (LicenceState::None, None));
}

/// A keychain read that waits on a prompt.
struct Prompting {
    entered: std::sync::mpsc::SyncSender<()>,
    answer: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl KeyStore for Prompting {
    fn get(&self) -> Result<Option<String>, &'static str> {
        self.entered.send(()).map_err(|_| "E_TEST")?;
        self.answer
            .lock()
            .map_err(|_| "E_TEST")?
            .recv()
            .map_err(|_| "E_TEST")?;
        Ok(None)
    }

    fn set(&self, _: &str) -> Result<(), &'static str> {
        Ok(())
    }

    fn clear(&self) -> Result<(), &'static str> {
        Ok(())
    }
}

#[test]
fn an_offer_does_not_wait_on_a_keychain_prompt() {
    let dir = tempfile::tempdir().expect("dir");
    let (entered, in_prompt) = std::sync::mpsc::sync_channel(1);
    let (answer, answered) = std::sync::mpsc::channel();
    let licence = Arc::new(Licence::new(
        test_keys(true),
        Arc::new(Prompting {
            entered,
            answer: Mutex::new(answered),
        }),
        dir.path(),
        Arc::new(|_: &Snapshot| {}),
    ));
    let reader = {
        let licence = Arc::clone(&licence);
        std::thread::spawn(move || licence.snapshot())
    };
    in_prompt.recv().expect("reading");

    let (offered, offer) = std::sync::mpsc::channel();
    let link = {
        let licence = Arc::clone(&licence);
        std::thread::spawn(move || {
            let _ = offered.send(licence.offer(&key(ID)).map(|o| o.state));
        })
    };
    let state = offer.recv_timeout(std::time::Duration::from_secs(10));
    answer.send(()).expect("answer");
    reader.join().expect("reader");
    link.join().expect("link");
    assert_eq!(state, Ok(Ok(LicenceState::Valid)));
}

#[test]
fn a_key_that_does_not_verify_is_refused_and_the_licence_stays() {
    let s = setup(true);
    let good = key(ID);
    s.licence.set(&good).expect("set");
    let v = vectors();
    for entry in v["invalid"].as_array().expect("invalid") {
        assert_eq!(
            s.licence.set(str_of(entry, "key")).map(|_| ()),
            Err(str_of(entry, "code"))
        );
    }
    assert_eq!(
        s.licence.set(&"x".repeat(MAX_INPUT + 1)).map(|_| ()),
        Err("E_LICENCE_MALFORMED")
    );
    assert_eq!(
        s.store.key.lock().expect("key").as_deref(),
        Some(good.as_str())
    );
    assert_eq!(s.licence.snapshot().id.as_deref(), Some(ID));
}

#[test]
fn a_pasted_key_loses_the_spaces_and_line_breaks_a_mail_wrapped_it_in() {
    let s = setup(true);
    let good = key(ID);
    let wrapped = format!("  {}\r\n{}\n ", &good[..100], &good[100..]);
    assert_eq!(
        s.licence.set(&wrapped).expect("set").state,
        LicenceState::Valid
    );
    assert_eq!(
        s.store.key.lock().expect("key").as_deref(),
        Some(good.as_str())
    );
}

#[test]
fn removing_forgets_the_key_and_each_change_is_announced() {
    let s = setup(true);
    s.licence.set(&key(ID)).expect("set");
    s.licence.remove().expect("remove");
    s.licence.remove().expect("again");
    assert_eq!(*s.store.key.lock().expect("key"), None);
    assert_eq!(s.licence.snapshot().state, LicenceState::None);
    let states: Vec<_> = s
        .emitted
        .lock()
        .expect("emitted")
        .iter()
        .map(|e| e.state)
        .collect();
    assert_eq!(
        states,
        [LicenceState::Valid, LicenceState::None, LicenceState::None]
    );
}

#[test]
fn an_offer_checks_a_key_without_keeping_it() {
    let s = setup(true);
    s.licence
        .apply_revocations(&list("2026-11-01T00:00:00Z", &[OTHER_ID]))
        .expect("list");
    let offer = s.licence.offer(&key(ID)).expect("offer");
    assert_eq!(offer.id, ID);
    assert_eq!(offer.licensee, LICENSEE);
    assert_eq!(offer.state, LicenceState::Valid);
    assert_eq!(
        s.licence.offer(&key(OTHER_ID)).map(|o| o.state),
        Ok(LicenceState::Revoked)
    );
    assert_eq!(
        s.licence.offer("devot1.x.y").map(|_| ()),
        Err("E_LICENCE_MALFORMED")
    );
    assert_eq!(*s.store.key.lock().expect("key"), None);
}

#[test]
fn an_offer_reads_the_kept_list_but_not_the_keychain() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().to_owned();
    let first = setup_in(dir, true);
    first
        .licence
        .apply_revocations(&list("2026-11-01T00:00:00Z", &[ID]))
        .expect("list");
    let fresh = setup_in(tempfile::tempdir().expect("dir"), true);
    let again = Licence::new(
        test_keys(true),
        Arc::clone(&fresh.store) as Arc<dyn KeyStore>,
        &path,
        Arc::new(|_: &Snapshot| {}),
    );
    assert_eq!(
        again.offer(&key(ID)).map(|o| o.state),
        Ok(LicenceState::Revoked)
    );
    assert_eq!(fresh.store.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn the_last_verified_revocation_list_is_kept_in_app_data_and_read_again() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().to_owned();
    let s = setup_in(dir, true);
    let v = vectors();
    let r = &v["revocations"];
    assert_eq!(
        s.licence.apply_revocations(str_of(&r["tampered"], "list")),
        Err("E_LICENCE_SIGNATURE")
    );
    assert!(!path.join(REVOCATIONS_FILE).exists());
    assert_eq!(s.licence.apply_revocations(str_of(r, "list")), Ok(true));
    assert_eq!(
        std::fs::read_to_string(path.join(REVOCATIONS_FILE)).expect("file"),
        str_of(r, "list")
    );
    // An older list never undoes a newer one.
    assert_eq!(
        s.licence
            .apply_revocations(&list("2026-10-01T00:00:00Z", &[])),
        Ok(false)
    );
    assert_eq!(s.licence.revoked(), BTreeSet::from([OTHER_ID.to_owned()]));

    let again = Licence::new(
        test_keys(true),
        Arc::new(MemoryKey::default()),
        &path,
        Arc::new(|_: &Snapshot| {}),
    );
    assert_eq!(again.revoked(), BTreeSet::from([OTHER_ID.to_owned()]));

    // A file changed on disk is not trusted.
    std::fs::write(path.join(REVOCATIONS_FILE), str_of(&r["tampered"], "list")).expect("write");
    let tampered = Licence::new(
        test_keys(true),
        Arc::new(MemoryKey::default()),
        &path,
        Arc::new(|_: &Snapshot| {}),
    );
    assert!(tampered.revoked().is_empty());
}

#[test]
fn neither_the_key_nor_the_licensee_reaches_a_log_or_a_debug_line() {
    crate::test_log::capture();
    let s = setup(true);
    let good = key(ID);
    s.licence.set(&good).expect("set");
    let _ = s.licence.set(&format!("{good}x"));
    let _ = s.licence.set("devot1.bm90IGpzb24.AAAA");
    let offer = s.licence.offer(&good).expect("offer");
    s.licence.remove().expect("remove");
    let snapshot = s.licence.set(&good).expect("set");
    let (signed, _) = good.rsplit_once('.').expect("parts");
    let payload = signed.split_once('.').expect("prefix").1;
    let mut written = crate::test_log::lines();
    written.push(format!("{snapshot:?}"));
    written.push(format!("{offer:?}"));
    for line in &written {
        assert!(!line.contains(LICENSEE), "{line}");
        assert!(!line.contains(payload), "{line}");
    }
    assert!(
        crate::test_log::lines()
            .iter()
            .any(|l| l.contains(&format!("I_LICENCE_SET licence={ID}")))
    );
}
