use std::collections::BTreeSet;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::format::{verify_licence, verify_revocations};
use super::keys::{PRODUCTION, TEST, decode_key};
use super::store::MemoryKey;
use super::testing::{
    ID, LICENSEE, key, licence_json, sign, sign_raw, test_keys, trial_over, vectors,
};
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
    trial: Arc<MemoryKey>,
    now: Arc<AtomicI64>,
    emitted: Arc<Mutex<Vec<Snapshot>>>,
    _dir: tempfile::TempDir,
}

/// When the tests' clock starts: long after `trial_over`'s trial.
const START: i64 = 1_790_000_000_000;
const HOUR: i64 = 3_600_000;

fn setup_with(dir: tempfile::TempDir, gated: bool, trial: Arc<MemoryKey>) -> Setup {
    let store = Arc::new(MemoryKey::default());
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&emitted);
    let now = Arc::new(AtomicI64::new(START));
    let clock = Arc::clone(&now);
    let licence = Licence::new(
        test_keys(gated),
        Arc::clone(&store) as Arc<dyn KeyStore>,
        Arc::clone(&trial) as Arc<dyn KeyStore>,
        dir.path(),
        Arc::new(move |s: &Snapshot| seen.lock().expect("emitted").push(s.clone())),
    )
    .with_clock(Arc::new(move || clock.load(Ordering::SeqCst)));
    Setup {
        licence,
        store,
        trial,
        now,
        emitted,
        _dir: dir,
    }
}

fn setup_in(dir: tempfile::TempDir, gated: bool) -> Setup {
    setup_with(dir, gated, trial_over())
}

/// A first launch: nothing in the trial's keychain item yet.
fn first_launch(gated: bool) -> Setup {
    setup_with(
        tempfile::tempdir().expect("temp dir"),
        gated,
        Arc::new(MemoryKey::default()),
    )
}

impl Setup {
    fn at(&self, now: i64) {
        self.now.store(now, Ordering::SeqCst);
    }

    fn kept_trial(&self) -> Option<trial::Record> {
        let text = self.trial.key.lock().expect("trial").clone()?;
        Some(trial::Record::read(&text).expect("record"))
    }

    fn trial_view(&self) -> TrialView {
        self.licence.snapshot().trial.expect("gated")
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
            [
                "activation",
                "code",
                "gated",
                "id",
                "licensee",
                "plan",
                "state",
                "trial"
            ]
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
        trial_over(),
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
        trial_over(),
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
        trial_over(),
        &path,
        Arc::new(|_: &Snapshot| {}),
    );
    assert_eq!(again.revoked(), BTreeSet::from([OTHER_ID.to_owned()]));

    // A file changed on disk is not trusted.
    std::fs::write(path.join(REVOCATIONS_FILE), str_of(&r["tampered"], "list")).expect("write");
    let tampered = Licence::new(
        test_keys(true),
        Arc::new(MemoryKey::default()),
        trial_over(),
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

#[test]
fn the_first_launch_of_a_gated_build_begins_a_three_day_trial_kept_in_the_keychain() {
    let s = first_launch(true);
    assert_eq!(
        s.trial_view(),
        TrialView {
            state: trial::TrialState::Running,
            ends_at: Some(START + 72 * HOUR),
            code: None,
        }
    );
    assert_eq!(s.kept_trial(), Some(trial::Record::first(START)));
    assert_eq!(s.licence.require(), Ok(()));
    for what in [Write::Body, Write::Content, Write::Bookkeeping] {
        assert_eq!(s.licence.require_write(what), Ok(()));
    }
    let sent = serde_json::to_value(s.licence.snapshot()).expect("json");
    assert_eq!(
        sent["trial"],
        json!({ "state": "running", "endsAt": START + 72 * HOUR, "code": null })
    );
}

#[test]
fn a_later_launch_and_a_reinstall_keep_the_trial_begun_first() {
    let first = first_launch(true);
    first.licence.snapshot();
    let item = Arc::clone(&first.trial);
    let again = setup_with(tempfile::tempdir().expect("dir"), true, item);
    again.at(START + 24 * HOUR);
    assert_eq!(again.trial_view().ends_at, Some(START + 72 * HOUR));
    assert_eq!(again.trial_view().state, trial::TrialState::Running);
    // Each launch records the latest time seen.
    assert_eq!(
        again.kept_trial().map(|r| (r.start, r.seen)),
        Some((START, START + 24 * HOUR))
    );
}

#[test]
fn once_the_trial_ran_out_user_content_sync_and_ai_are_refused() {
    let s = first_launch(true);
    s.licence.snapshot();
    s.at(START + 72 * HOUR);
    assert_eq!(s.trial_view().state, trial::TrialState::Ended);
    assert_eq!(s.licence.require(), Err(REQUIRED));
    assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    assert_eq!(s.licence.require_write(Write::Bookkeeping), Ok(()));
}

#[test]
fn a_note_being_saved_as_the_trial_ends_still_lands_for_a_few_minutes() {
    let s = first_launch(true);
    s.licence.snapshot();
    let end = START + 72 * HOUR;
    s.at(end + trial::GRACE_MS - 1);
    assert_eq!(s.licence.require_write(Write::Body), Ok(()));
    assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    assert_eq!(s.licence.require(), Err(REQUIRED));
    s.at(end + trial::GRACE_MS);
    assert_eq!(s.licence.require_write(Write::Body), Err(REQUIRED));
}

#[test]
fn setting_the_clock_back_ends_the_trial_and_setting_it_right_does_not_bring_it_back() {
    let s = first_launch(true);
    s.licence.snapshot();
    s.at(START + 10 * HOUR);
    s.licence.tick();
    assert_eq!(s.kept_trial().map(|r| r.seen), Some(START + 10 * HOUR));
    // Within the hour it may be a correction.
    s.at(START + 9 * HOUR + 1);
    assert_eq!(s.trial_view().state, trial::TrialState::Running);
    s.at(START + 9 * HOUR - 1);
    assert_eq!(s.trial_view().state, trial::TrialState::Ended);
    assert_eq!(s.licence.require_write(Write::Body), Err(REQUIRED));
    assert_eq!(s.kept_trial().map(|r| r.ended), Some(true));
    s.at(START + 11 * HOUR);
    assert_eq!(s.trial_view().state, trial::TrialState::Ended);
    assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    // So does the next launch.
    let again = setup_with(
        tempfile::tempdir().expect("dir"),
        true,
        Arc::clone(&s.trial),
    );
    again.at(START + 11 * HOUR);
    assert_eq!(again.trial_view().state, trial::TrialState::Ended);
}

// Each refused write may bring back the keychain's prompt.
#[test]
fn a_refused_trial_write_is_tried_again_after_the_full_interval_not_every_tick() {
    let s = first_launch(true);
    s.licence.snapshot();
    s.trial.unwritable.store(true, Ordering::SeqCst);
    let writes = || s.trial.writes.load(Ordering::SeqCst);
    let before = writes();
    for minutes in [10, 11, 12, 15] {
        s.at(START + minutes * 60_000);
        s.licence.tick();
    }
    assert_eq!(writes() - before, 1);
    s.at(START + 20 * 60_000);
    s.licence.tick();
    assert_eq!(writes() - before, 2);
}

#[test]
fn a_valid_licence_never_writes_the_trial_as_time_passes() {
    let s = first_launch(true);
    *s.store.key.lock().expect("key") = Some(key(ID));
    assert_eq!(s.licence.snapshot().state, LicenceState::Valid);
    let before = s.trial.writes.load(Ordering::SeqCst);
    for minutes in [10, 20, 30] {
        s.at(START + minutes * 60_000);
        s.licence.tick();
    }
    assert_eq!(s.trial.writes.load(Ordering::SeqCst), before);
}

#[test]
fn a_clock_set_back_while_devot_was_closed_is_logged_as_one() {
    crate::test_log::capture();
    let set_back = || {
        crate::test_log::lines()
            .iter()
            .filter(|line| line.as_str() == "WARN W_TRIAL_CLOCK_SET_BACK")
            .count()
    };
    let before = set_back();
    let seen_later = trial::Record {
        start: START - 2 * HOUR,
        seen: START + 2 * HOUR,
        ended: false,
    };
    let s = setup_with(
        tempfile::tempdir().expect("dir"),
        true,
        Arc::new(MemoryKey::holding(&seen_later.text())),
    );
    assert_eq!(s.trial_view().state, trial::TrialState::Ended);
    assert!(set_back() > before);
}

#[test]
fn a_valid_licence_unlocks_everything_whatever_the_trial() {
    let s = setup(true);
    assert_eq!(s.trial_view().state, trial::TrialState::Ended);
    assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    s.licence.set(&key(ID)).expect("set");
    assert_eq!(s.licence.require(), Ok(()));
    for what in [Write::Body, Write::Content] {
        assert_eq!(s.licence.require_write(what), Ok(()));
    }
    s.licence
        .apply_revocations(&list("2026-11-01T00:00:00Z", &[ID]))
        .expect("list");
    assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
}

#[test]
fn an_ungated_build_never_starts_the_trial_clock() {
    let s = first_launch(false);
    assert_eq!(s.licence.snapshot().trial, None);
    s.at(START + 100 * HOUR);
    s.licence.tick();
    assert_eq!(s.licence.require(), Ok(()));
    for what in [Write::Body, Write::Content] {
        assert_eq!(s.licence.require_write(what), Ok(()));
    }
    assert_eq!(s.trial.reads.load(Ordering::SeqCst), 0);
    assert_eq!(s.kept_trial(), None);
    assert!(s.emitted.lock().expect("emitted").is_empty());
}

#[test]
fn a_trial_the_keychain_cannot_give_counts_as_ended_and_is_read_again_at_the_next_tick() {
    let s = first_launch(true);
    s.trial.unreadable.store(true, Ordering::SeqCst);
    assert_eq!(
        s.trial_view(),
        TrialView {
            state: trial::TrialState::Ended,
            ends_at: None,
            code: Some("E_LICENCE_KEYCHAIN"),
        }
    );
    assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    s.licence.snapshot();
    assert_eq!(s.trial.reads.load(Ordering::SeqCst), 1);
    s.trial.unreadable.store(false, Ordering::SeqCst);
    s.licence.tick();
    assert_eq!(s.trial_view().state, trial::TrialState::Running);
    assert_eq!(s.licence.require_write(Write::Content), Ok(()));

    // A damaged item does not begin a new trial.
    let damaged = setup_with(
        tempfile::tempdir().expect("dir"),
        true,
        Arc::new(MemoryKey::holding("{\"start\":")),
    );
    assert_eq!(damaged.trial_view().code, Some("E_TRIAL_UNREADABLE"));
    assert_eq!(damaged.licence.require(), Err(REQUIRED));
}

#[test]
fn the_latest_time_seen_is_written_every_ten_minutes_and_the_end_is_announced_once() {
    let s = first_launch(true);
    s.licence.tick();
    assert_eq!(s.emitted.lock().expect("emitted").len(), 1);
    s.at(START + 9 * 60_000);
    s.licence.require_write(Write::Body).expect("running");
    s.licence.tick();
    assert_eq!(s.kept_trial().map(|r| r.seen), Some(START));
    s.at(START + 10 * 60_000);
    s.licence.tick();
    assert_eq!(s.kept_trial().map(|r| r.seen), Some(START + 10 * 60_000));
    assert_eq!(s.emitted.lock().expect("emitted").len(), 1);
    s.at(START + 72 * HOUR);
    s.licence.tick();
    s.licence.tick();
    let emitted = s.emitted.lock().expect("emitted");
    assert_eq!(emitted.len(), 2);
    assert_eq!(
        emitted[1].trial.map(|t| t.state),
        Some(trial::TrialState::Ended)
    );
}

// The first Developer ID build reads items an ad-hoc build made, which macOS may only give after
// asking (docs/releasing.md, Signing the app); a denied read must lose nothing.
#[test]
fn a_denied_trial_read_neither_begins_a_new_trial_nor_locks_out_a_licence() {
    let begun = trial::Record::first(START - 2 * HOUR).text();
    let s = setup_with(
        tempfile::tempdir().expect("dir"),
        true,
        Arc::new(MemoryKey::holding(&begun)),
    );
    *s.store.key.lock().expect("key") = Some(key(ID));
    s.trial.unreadable.store(true, Ordering::SeqCst);
    assert_eq!(s.trial_view().code, Some("E_LICENCE_KEYCHAIN"));
    assert_eq!(s.licence.snapshot().state, LicenceState::Valid);
    assert_eq!(s.licence.require(), Ok(()));
    for what in [Write::Body, Write::Content] {
        assert_eq!(s.licence.require_write(what), Ok(()));
    }
    for minutes in [1, 11, 21] {
        s.at(START + minutes * 60_000);
        s.licence.tick();
    }
    assert_eq!(
        s.trial.key.lock().expect("trial").as_deref(),
        Some(begun.as_str())
    );

    s.trial.unreadable.store(false, Ordering::SeqCst);
    s.licence.tick();
    assert_eq!(s.trial_view().ends_at, Some(START - 2 * HOUR + 72 * HOUR));
}

#[test]
fn a_denied_licence_read_keeps_the_key_and_is_asked_again_at_the_next_tick_not_at_every_write() {
    let s = setup(true);
    *s.store.key.lock().expect("key") = Some(key(ID));
    s.store.unreadable.store(true, Ordering::SeqCst);
    let denied = s.licence.snapshot();
    assert_eq!(
        (denied.state, denied.code),
        (LicenceState::None, Some("E_LICENCE_KEYCHAIN"))
    );
    for _ in 0..5 {
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    }
    s.licence.snapshot();
    assert_eq!(s.store.reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        s.store.key.lock().expect("key").as_deref(),
        Some(key(ID).as_str())
    );

    s.store.unreadable.store(false, Ordering::SeqCst);
    s.licence.tick();
    assert_eq!(s.store.reads.load(Ordering::SeqCst), 2);
    assert_eq!(s.licence.snapshot().state, LicenceState::Valid);
    assert_eq!(s.licence.require_write(Write::Content), Ok(()));
    let emitted = s.emitted.lock().expect("emitted");
    assert_eq!(
        emitted.last().map(|snapshot| snapshot.state),
        Some(LicenceState::Valid)
    );
}

mod seats {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    use super::super::activation::State as SeatState;
    use super::super::client::Reply as ActivationReply;
    use super::super::store::MemoryKey;
    use super::super::testing::{ID, key, sign, test_keys, trial_over};
    use super::super::tests::OTHER_ID;
    use super::super::{Licence, LicenceState, REQUIRED, Snapshot};
    use crate::storage::Write;

    const DAY: i64 = 86_400_000;
    /// `setup`'s clock starts here.
    const START: i64 = 1_790_000_000_000;

    fn lease_for(id: &str, device: &str, expires_at: &str) -> String {
        sign(
            "devot1dev",
            &serde_json::json!({
                "id": id,
                "device": device,
                "kid": "test",
                "issuedAt": "2026-10-24T09:30:00Z",
                "expiresAt": expires_at,
            }),
        )
    }

    struct Seats {
        licence: Arc<Licence>,
        now: Arc<AtomicI64>,
        activation: Arc<MemoryKey>,
        _dir: tempfile::TempDir,
    }

    fn seat_setup(
        answer: impl Fn(&str) -> Result<ActivationReply, &'static str> + Send + Sync + 'static,
    ) -> Seats {
        seat_setup_with(None, answer)
    }

    fn seat_setup_with(
        held: Option<&str>,
        answer: impl Fn(&str) -> Result<ActivationReply, &'static str> + Send + Sync + 'static,
    ) -> Seats {
        let dir = tempfile::tempdir().expect("temp dir");
        let now = Arc::new(AtomicI64::new(START));
        let clock = Arc::clone(&now);
        let key_store = held.map_or_else(MemoryKey::default, MemoryKey::holding);
        let activation = Arc::new(MemoryKey::default());
        let licence = Arc::new(
            Licence::new(
                test_keys(true),
                Arc::new(key_store),
                trial_over(),
                dir.path(),
                Arc::new(|_: &Snapshot| {}),
            )
            .with_clock(Arc::new(move || clock.load(Ordering::SeqCst)))
            .with_activation(
                Arc::new(MemoryKey::default()),
                Arc::clone(&activation) as Arc<dyn super::super::store::KeyStore>,
                Arc::new(move |_: &str, device: &str, _: &str| answer(device)),
            ),
        );
        Seats {
            licence,
            now,
            activation,
            _dir: dir,
        }
    }

    fn active(device: &str) -> Result<ActivationReply, &'static str> {
        Ok(ActivationReply {
            lease: lease_for(ID, device, "2099-01-01T00:00:00Z"),
            used: 1,
            limit: 3,
        })
    }

    #[test]
    fn a_key_takes_a_seat_and_the_snapshot_reports_it() {
        let s = seat_setup(active);
        s.licence.set(&key(ID)).expect("set");
        let snapshot = s.licence.snapshot();
        assert_eq!(snapshot.state, LicenceState::Valid);
        let seat = snapshot.activation.expect("seat");
        assert_eq!(
            (seat.state, seat.used, seat.limit),
            (SeatState::Active, 1, 3)
        );
        assert!(seat.expires_at.is_some());
        assert_eq!(s.licence.require_write(Write::Content), Ok(()));
    }

    #[test]
    fn an_unreachable_worker_leaves_a_thirty_day_migration_window() {
        let s = seat_setup(|_| Err("E_NET_TIMEOUT"));
        s.licence.set(&key(ID)).expect("set");
        let snapshot = s.licence.snapshot();
        assert_eq!(snapshot.code, Some("E_NET_TIMEOUT"));
        // A migration window is usable, so it reports as active; the code says why it was needed.
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Active)
        );
        assert_eq!(s.licence.require_write(Write::Content), Ok(()));
        s.now.fetch_add(29 * DAY, Ordering::SeqCst);
        assert_eq!(s.licence.require_write(Write::Content), Ok(()));
        s.now.fetch_add(2 * DAY, Ordering::SeqCst);
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
        assert_eq!(
            s.licence.snapshot().code,
            Some("E_LICENCE_ACTIVATION_REQUIRED")
        );
    }

    #[test]
    fn a_refused_seat_does_not_open_a_window() {
        let s = seat_setup(|_| Err("E_LICENCE_DEVICE_LIMIT"));
        s.licence.set(&key(ID)).expect("set");
        let snapshot = s.licence.snapshot();
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Required)
        );
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    }

    #[test]
    fn an_expired_lease_locks_writes_until_it_is_renewed() {
        let renew = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&renew);
        let s = seat_setup(move |device| {
            if flag.load(Ordering::SeqCst) {
                active(device)
            } else {
                Ok(ActivationReply {
                    lease: lease_for(ID, device, "2000-01-01T00:00:00Z"),
                    used: 1,
                    limit: 3,
                })
            }
        });
        s.licence.set(&key(ID)).expect("set");
        assert_eq!(
            s.licence.snapshot().code,
            Some("E_LICENCE_ACTIVATION_EXPIRED")
        );
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
        renew.store(true, Ordering::SeqCst);
        assert_eq!(s.licence.refresh_activation(), Ok(true));
        assert_eq!(s.licence.require_write(Write::Content), Ok(()));
    }

    #[test]
    fn a_lease_signed_for_another_device_is_not_this_devices_seat() {
        let s = seat_setup(|_| {
            Ok(ActivationReply {
                lease: lease_for(ID, "BBBBBBBBBBBBBBBBBBBBBB", "2099-01-01T00:00:00Z"),
                used: 1,
                limit: 3,
            })
        });
        s.licence.set(&key(ID)).expect("set");
        let snapshot = s.licence.snapshot();
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Required)
        );
        assert_eq!(snapshot.code, Some("E_LICENCE_ACTIVATION_REQUIRED"));
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    }

    #[test]
    fn a_key_sold_after_seats_gets_no_window_when_the_worker_is_unreachable() {
        let s = seat_setup(|_| Err("E_NET_TIMEOUT"));
        let fresh = sign(
            "devot1",
            &serde_json::json!({
                "id": ID,
                "kid": "test",
                "plan": "pro",
                "licensee": "buyer@example.com",
                "issuedAt": "2026-12-01T00:00:00Z",
            }),
        );
        s.licence.set(&fresh).expect("set");
        let snapshot = s.licence.snapshot();
        assert_eq!(snapshot.code, Some("E_LICENCE_ACTIVATION_REQUIRED"));
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Required)
        );
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    }

    #[test]
    fn a_key_already_held_from_before_seats_starts_its_window_without_adding_it_again() {
        let held = key(ID);
        let s = seat_setup_with(Some(held.as_str()), |_| Err("E_NET_TIMEOUT"));
        let snapshot = s.licence.snapshot();
        assert_eq!(snapshot.state, LicenceState::Valid);
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Active)
        );
        assert_eq!(s.licence.require_write(Write::Content), Ok(()));
    }

    #[test]
    fn a_refused_key_cannot_reopen_a_window_by_going_offline() {
        let online = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&online);
        let s = seat_setup(move |_| {
            if flag.load(Ordering::SeqCst) {
                Err("E_LICENCE_DEVICE_LIMIT")
            } else {
                Err("E_NET_TIMEOUT")
            }
        });
        s.licence.set(&key(ID)).expect("set");
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
        online.store(false, Ordering::SeqCst);
        s.licence.set(&key(ID)).expect("set");
        let snapshot = s.licence.snapshot();
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Required)
        );
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    }

    #[test]
    fn an_unreadable_seat_locks_the_device_and_a_re_paste_recovers() {
        let held = key(ID);
        let s = seat_setup_with(Some(held.as_str()), active);
        *s.activation.key.lock().expect("seat") = Some("not json".into());
        let snapshot = s.licence.snapshot();
        assert_eq!(snapshot.state, LicenceState::Valid);
        assert_eq!(snapshot.code, Some("E_LICENCE_ACTIVATION_UNREADABLE"));
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Required)
        );
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
        s.licence.set(&held).expect("set");
        assert_eq!(
            s.licence.snapshot().activation.map(|seat| seat.state),
            Some(SeatState::Active)
        );
        assert_eq!(s.licence.require_write(Write::Content), Ok(()));
    }

    #[test]
    fn a_lease_for_another_licence_is_not_this_ones() {
        let s = seat_setup(|device| {
            Ok(ActivationReply {
                lease: lease_for(OTHER_ID, device, "2099-01-01T00:00:00Z"),
                used: 1,
                limit: 3,
            })
        });
        s.licence.set(&key(ID)).expect("set");
        assert_eq!(
            s.licence.snapshot().activation.map(|seat| seat.state),
            Some(SeatState::Required)
        );
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    }

    #[test]
    fn a_failed_renewal_keeps_the_lease_that_is_there() {
        let fail = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&fail);
        let s = seat_setup(move |device| {
            if flag.load(Ordering::SeqCst) {
                Err("E_NET_TIMEOUT")
            } else {
                Ok(ActivationReply {
                    // Within the 7 days before its end, so the schedule tries to renew it.
                    lease: lease_for(ID, device, "2026-09-26T08:00:00Z"),
                    used: 1,
                    limit: 3,
                })
            }
        });
        s.licence.set(&key(ID)).expect("set");
        assert_eq!(s.licence.require_write(Write::Content), Ok(()));
        fail.store(true, Ordering::SeqCst);
        // An unreachable Worker is tried again at the next wake-up, not once a day.
        assert!(!s.licence.refresh_activation_if_due());
        assert_eq!(s.licence.require_write(Write::Content), Ok(()));
    }

    #[test]
    fn swapping_keys_does_not_restart_a_window() {
        let s = seat_setup(|_| Err("E_NET_TIMEOUT"));
        let other = sign(
            "devot1",
            &serde_json::json!({
                "id": OTHER_ID,
                "kid": "test",
                "plan": "pro",
                "licensee": "buyer@example.com",
                "issuedAt": "2026-10-24T09:30:00Z",
            }),
        );
        s.licence.set(&key(ID)).expect("set");
        s.licence.set(&other).expect("set");
        s.licence.set(&key(ID)).expect("set");
        let snapshot = s.licence.snapshot();
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Required)
        );
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    }

    #[test]
    fn removing_and_readding_a_key_does_not_restart_its_window() {
        let held = key(ID);
        let s = seat_setup_with(Some(held.as_str()), |_| Err("E_NET_TIMEOUT"));
        // The held key's window starts on the first look.
        assert_eq!(
            s.licence.snapshot().activation.map(|seat| seat.state),
            Some(SeatState::Active)
        );
        s.licence.remove().expect("remove");
        s.licence.set(&held).expect("set");
        let snapshot = s.licence.snapshot();
        assert_eq!(
            snapshot.activation.map(|seat| seat.state),
            Some(SeatState::Required)
        );
        assert_eq!(s.licence.require_write(Write::Content), Err(REQUIRED));
    }
}
