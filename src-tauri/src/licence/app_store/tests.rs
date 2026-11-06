//! An App Store build's licence against the fake App Store: every unlock path alone, what never
//! unlocks, refunds, the trial purchase and the clock, and the storefront's time limits.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use super::super::activation::State as SeatState;
use super::super::client::MacKey;
use super::super::client::Reply as ActivationReply;
use super::super::store::{KeyStore, MemoryKey};
use super::super::testing::{ID, key, sign, test_keys};
use super::super::trial::{LENGTH_MS, TrialSource, TrialState};
use super::super::{KEYS_OFF, Licence, REQUIRED, Snapshot};
use super::{Bought, Limits, Storefront, mac_key, purchase_line, refund_line};
use crate::app_store::fake::{FakeAppStore, transaction};
use crate::app_store::{
    AppStore, Ownership, Product, Purchase, Refund, Restore, RevocationReason, StoreError,
    StoreProduct, StoreTransaction, Update,
};
use crate::storage::Write;

const START: i64 = 1_790_000_000_000;
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

const QUICK: Limits = Limits {
    reply: Duration::from_millis(50),
    restore: Duration::from_millis(50),
    retry: Duration::from_millis(20),
};

struct Setup {
    licence: Arc<Licence>,
    shop: Arc<Storefront<FakeAppStore>>,
    now: Arc<AtomicI64>,
    keychain_trial: Arc<MemoryKey>,
    trial_seen: Arc<MemoryKey>,
    _dir: tempfile::TempDir,
}

impl Setup {
    fn store(&self) -> &FakeAppStore {
        self.shop.store()
    }

    fn at(&self, now: i64) {
        self.now.store(now, Ordering::SeqCst);
    }

    fn writes(&self) -> bool {
        self.licence.require_write(Write::Content).is_ok()
    }
}

fn lease_for(device: &str) -> String {
    sign(
        "devot1dev",
        &serde_json::json!({
            "id": ID,
            "device": device,
            "kid": "test",
            "issuedAt": "2026-10-24T09:30:00Z",
            "expiresAt": "2099-01-01T00:00:00Z",
        }),
    )
}

fn build(direct: bool, takes_keys: bool, trial_seen: Arc<MemoryKey>) -> Setup {
    let dir = tempfile::tempdir().expect("temp dir");
    let now = Arc::new(AtomicI64::new(START));
    let clock = Arc::clone(&now);
    let keychain_trial = Arc::new(MemoryKey::default());
    let licence = Licence::new(
        test_keys(true),
        Arc::new(MemoryKey::default()),
        Arc::clone(&keychain_trial) as Arc<dyn KeyStore>,
        dir.path(),
        Arc::new(|_: &Snapshot| {}),
    )
    .with_clock(Arc::new(move || clock.load(Ordering::SeqCst)))
    .with_activation(
        Arc::new(MemoryKey::default()),
        Arc::new(MemoryKey::default()),
        Arc::new(|_: &str, device: &str, _: &str| {
            Ok(ActivationReply {
                lease: lease_for(device),
                used: 1,
                limit: 3,
            })
        }),
    );
    let licence = Arc::new(if direct {
        licence
    } else {
        licence.with_app_store(Arc::clone(&trial_seen) as Arc<dyn KeyStore>, takes_keys)
    });
    let shop = Arc::new(Storefront::new(
        FakeAppStore::default(),
        Arc::clone(&licence),
        QUICK,
    ));
    Setup {
        licence,
        shop,
        now,
        keychain_trial,
        trial_seen,
        _dir: dir,
    }
}

fn app_store() -> Setup {
    build(false, true, Arc::new(MemoryKey::default()))
}

fn block_on<T>(work: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(work)
}

/// Waits until `done` holds, for at most two seconds.
async fn until(done: impl Fn() -> bool) {
    for _ in 0..400 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("not within two seconds");
}

fn entitled(setup: &Setup, transactions: Vec<StoreTransaction>) {
    setup.store().set_entitlements(transactions);
    block_on(setup.shop.read_entitlements()).expect("entitlements");
}

fn refunded(transaction: StoreTransaction, at: i64) -> StoreTransaction {
    StoreTransaction {
        revocation_date_ms: Some(at),
        revocation_reason: Some(RevocationReason::Other),
        ..transaction
    }
}

#[test]
fn nothing_held_is_read_only() {
    let setup = app_store();
    assert_eq!(setup.licence.require(), Err(REQUIRED));
    entitled(&setup, Vec::new());
    assert_eq!(setup.licence.require(), Err(REQUIRED));
    assert_eq!(
        setup.licence.require_write(Write::Body),
        Err(REQUIRED),
        "no grace without a purchase that went away"
    );
    assert!(setup.licence.require_write(Write::Bookkeeping).is_ok());
    let snapshot = setup.licence.snapshot();
    let trial = snapshot.trial.expect("trial");
    assert_eq!(
        (trial.state, trial.source),
        (TrialState::Available, TrialSource::Purchase)
    );
    let store = snapshot.app_store.expect("app store");
    assert!(!store.pro);
    assert_eq!(store.code, None);
    assert!(store.takes_keys);
}

#[test]
fn a_pro_purchase_alone_unlocks() {
    let setup = app_store();
    entitled(&setup, vec![transaction(Product::Pro, 1, START - DAY)]);
    assert_eq!(setup.licence.require(), Ok(()));
    assert!(setup.writes());
    assert!(setup.licence.snapshot().app_store.expect("app store").pro);
}

#[test]
fn a_licence_with_an_active_seat_alone_unlocks() {
    let setup = app_store();
    entitled(&setup, Vec::new());
    setup.licence.set(&key(ID)).expect("key");
    let snapshot = setup.licence.snapshot();
    assert_eq!(
        snapshot.activation.map(|seat| seat.state),
        Some(SeatState::Active)
    );
    assert!(!snapshot.app_store.expect("app store").pro);
    assert_eq!(setup.licence.require(), Ok(()));
}

#[test]
fn a_running_trial_purchase_alone_unlocks_for_thirty_days_from_its_purchase() {
    let setup = app_store();
    let bought = START - 10 * DAY;
    entitled(&setup, vec![transaction(Product::Trial, 2, bought)]);
    assert_eq!(setup.licence.require(), Ok(()));
    let trial = setup.licence.snapshot().trial.expect("trial");
    assert_eq!(trial.state, TrialState::Running);
    assert_eq!(trial.ends_at, Some(bought + LENGTH_MS));
    setup.at(bought + LENGTH_MS - 1);
    assert_eq!(setup.licence.require(), Ok(()));
    setup.at(bought + LENGTH_MS);
    assert_eq!(setup.licence.require(), Err(REQUIRED));
    assert!(
        setup.licence.require_write(Write::Body).is_ok(),
        "a save in flight lands"
    );
    setup.at(bought + LENGTH_MS + 5 * MINUTE);
    assert_eq!(setup.licence.require_write(Write::Body), Err(REQUIRED));
}

#[test]
fn a_family_shared_or_revoked_purchase_does_not_unlock() {
    let setup = app_store();
    let pro = transaction(Product::Pro, 1, START);
    for held in [
        StoreTransaction {
            ownership: Ownership::FamilyShared,
            ..pro.clone()
        },
        refunded(pro.clone(), START),
        StoreTransaction {
            bundle_id: "com.example.other".to_owned(),
            ..pro.clone()
        },
        StoreTransaction {
            ownership: Ownership::FamilyShared,
            ..transaction(Product::Trial, 2, START)
        },
    ] {
        entitled(&setup, vec![held.clone()]);
        assert_eq!(setup.licence.require(), Err(REQUIRED), "{held:?}");
    }
}

#[test]
fn the_trial_product_never_counts_as_pro() {
    let setup = app_store();
    entitled(
        &setup,
        vec![transaction(Product::Trial, 2, START - 40 * DAY)],
    );
    assert_eq!(setup.licence.require(), Err(REQUIRED));
    let snapshot = setup.licence.snapshot();
    assert!(!snapshot.app_store.expect("app store").pro);
    assert_eq!(snapshot.trial.expect("trial").state, TrialState::Ended);
}

#[test]
fn nothing_unlocks_before_the_entitlements_are_read() {
    let setup = app_store();
    let snapshot = setup.licence.snapshot();
    assert_eq!(
        snapshot.app_store.expect("app store").code,
        Some("E_APP_STORE_UNREAD")
    );
    assert_eq!(snapshot.trial.expect("trial").state, TrialState::Ended);
    assert_eq!(setup.licence.require(), Err(REQUIRED));
}

#[test]
fn a_refund_seen_as_an_update_makes_it_read_only_but_a_save_in_flight_lands() {
    let setup = app_store();
    let pro = transaction(Product::Pro, 1, START - DAY);
    entitled(&setup, vec![pro.clone()]);
    block_on(async {
        let running = tauri::async_runtime::spawn(Arc::clone(&setup.shop).run());
        setup.at(START + HOUR);
        setup.store().refund(1, START + HOUR);
        until(|| setup.licence.require().is_err()).await;
        running.abort();
    });
    assert_eq!(setup.licence.require(), Err(REQUIRED));
    assert!(setup.licence.require_write(Write::Body).is_ok());
    assert_eq!(setup.licence.require_write(Write::Content), Err(REQUIRED));
    setup.at(START + HOUR + 5 * MINUTE);
    assert_eq!(setup.licence.require_write(Write::Body), Err(REQUIRED));
    assert!(!setup.licence.snapshot().app_store.expect("app store").pro);
}

#[test]
fn a_refund_leaves_a_seat_or_a_running_trial_unlocked() {
    let seat = app_store();
    entitled(&seat, vec![transaction(Product::Pro, 1, START)]);
    seat.licence.set(&key(ID)).expect("key");
    seat.licence
        .take_transaction(refunded(transaction(Product::Pro, 1, START), START));
    assert_eq!(seat.licence.require(), Ok(()));

    let trial = app_store();
    entitled(
        &trial,
        vec![
            transaction(Product::Pro, 1, START),
            transaction(Product::Trial, 2, START - DAY),
        ],
    );
    trial
        .licence
        .take_transaction(refunded(transaction(Product::Pro, 1, START), START));
    assert_eq!(trial.licence.require(), Ok(()));
}

#[test]
fn a_purchase_refunded_while_the_app_was_closed_is_gone_at_launch() {
    let setup = app_store();
    entitled(&setup, vec![transaction(Product::Pro, 1, START)]);
    entitled(&setup, Vec::new());
    assert_eq!(setup.licence.require(), Err(REQUIRED));
}

#[test]
fn a_clock_set_back_more_than_an_hour_ends_the_trial_purchase() {
    let setup = app_store();
    entitled(&setup, vec![transaction(Product::Trial, 2, START)]);
    setup.at(START + 10 * HOUR);
    setup.licence.tick();
    setup.at(START + 9 * HOUR + 30 * MINUTE);
    assert_eq!(setup.licence.require(), Ok(()), "a correction, not a reset");
    setup.at(START + 9 * HOUR - 1);
    assert_eq!(setup.licence.require(), Err(REQUIRED));
    setup.at(START + 11 * HOUR);
    assert_eq!(setup.licence.require(), Err(REQUIRED), "ended for good");
    assert_eq!(
        setup.licence.snapshot().trial.expect("trial").state,
        TrialState::Ended
    );
}

#[test]
fn the_trial_purchase_keeps_its_latest_time_seen_across_a_relaunch() {
    let seen = Arc::new(MemoryKey::default());
    let first = build(false, true, Arc::clone(&seen));
    entitled(&first, vec![transaction(Product::Trial, 2, START)]);
    first.at(START + 10 * HOUR);
    first.licence.tick();
    assert_eq!(first.licence.require(), Ok(()));
    assert!(seen.key.lock().expect("seen").is_some());

    let relaunched = build(false, true, Arc::clone(&seen));
    relaunched.at(START + 2 * HOUR);
    entitled(&relaunched, vec![transaction(Product::Trial, 2, START)]);
    assert_eq!(relaunched.licence.require(), Err(REQUIRED));
}

#[test]
fn a_clock_behind_the_trials_purchase_date_runs_it_once_the_clock_is_right() {
    let seen = Arc::new(MemoryKey::default());
    let slow = build(false, true, Arc::clone(&seen));
    slow.at(START - 2 * HOUR);
    entitled(&slow, vec![transaction(Product::Trial, 2, START)]);
    assert_eq!(slow.licence.require(), Err(REQUIRED), "not running yet");
    slow.licence.tick();
    slow.at(START + HOUR);
    assert_eq!(slow.licence.require(), Ok(()));

    let relaunched = build(false, true, Arc::clone(&seen));
    relaunched.at(START - 2 * HOUR);
    entitled(&relaunched, vec![transaction(Product::Trial, 2, START)]);
    assert_eq!(relaunched.licence.require(), Err(REQUIRED));
    let corrected = build(false, true, Arc::clone(&seen));
    corrected.at(START + 2 * HOUR);
    entitled(&corrected, vec![transaction(Product::Trial, 2, START)]);
    assert_eq!(corrected.licence.require(), Ok(()), "also after a relaunch");
}

#[test]
fn the_keychain_trial_is_never_made_in_an_app_store_build() {
    let setup = app_store();
    let _ = setup.licence.snapshot();
    entitled(&setup, Vec::new());
    assert_eq!(setup.licence.require(), Err(REQUIRED));
    entitled(&setup, vec![transaction(Product::Trial, 2, START)]);
    setup.at(START + HOUR);
    setup.licence.tick();
    assert_eq!(setup.licence.require(), Ok(()));
    assert_eq!(*setup.keychain_trial.key.lock().expect("trial"), None);
    assert_eq!(setup.keychain_trial.reads.load(Ordering::SeqCst), 0);
    assert_eq!(setup.keychain_trial.writes.load(Ordering::SeqCst), 0);
    let kept = setup.trial_seen.key.lock().expect("seen").clone();
    assert!(kept.is_some_and(|text| text.contains(&format!("\"start\":{START}"))));
}

#[test]
fn nothing_is_written_for_the_trial_before_it_is_bought() {
    let setup = app_store();
    entitled(&setup, vec![transaction(Product::Pro, 1, START)]);
    setup.at(START + DAY);
    setup.licence.tick();
    assert_eq!(setup.trial_seen.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn a_direct_build_is_as_before() {
    let setup = build(true, true, Arc::new(MemoryKey::default()));
    let snapshot = setup.licence.snapshot();
    assert_eq!(snapshot.app_store, None);
    let trial = snapshot.trial.expect("trial");
    assert_eq!(
        (trial.state, trial.source),
        (TrialState::Running, TrialSource::Keychain)
    );
    assert!(setup.keychain_trial.key.lock().expect("trial").is_some());
    setup.at(START + LENGTH_MS);
    setup
        .licence
        .take_transaction(transaction(Product::Pro, 1, START));
    assert_eq!(
        setup.licence.require(),
        Err(REQUIRED),
        "no store to hold it"
    );
    assert_eq!(setup.trial_seen.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn an_app_store_build_without_keys_refuses_them() {
    let setup = build(false, false, Arc::new(MemoryKey::default()));
    assert_eq!(setup.licence.set(&key(ID)).map(|_| ()), Err(KEYS_OFF));
    assert_eq!(setup.licence.offer(&key(ID)).map(|_| ()), Err(KEYS_OFF));
    assert!(
        !setup
            .licence
            .snapshot()
            .app_store
            .expect("app store")
            .takes_keys
    );
}

#[test]
fn a_purchase_unlocks_and_is_finished_once_held() {
    let setup = app_store();
    entitled(&setup, Vec::new());
    let pro = transaction(Product::Pro, 7, START);
    setup
        .store()
        .set_purchase(Product::Pro, Ok(Purchase::Purchased(pro)));
    assert_eq!(
        block_on(setup.shop.purchase(Product::Pro)),
        Ok(Bought::Purchased)
    );
    assert_eq!(setup.licence.require(), Ok(()));
    assert_eq!(setup.store().finished(), vec![7]);
}

#[test]
fn starting_the_trial_buys_the_trial_product() {
    let setup = app_store();
    entitled(&setup, Vec::new());
    setup.store().set_purchase(
        Product::Trial,
        Ok(Purchase::Purchased(transaction(Product::Trial, 8, START))),
    );
    assert_eq!(
        block_on(setup.shop.purchase(Product::Trial)),
        Ok(Bought::Purchased)
    );
    assert_eq!(setup.store().purchased(), vec![Product::Trial]);
    let trial = setup.licence.snapshot().trial.expect("trial");
    assert_eq!(trial.state, TrialState::Running);
    assert_eq!(trial.ends_at, Some(START + LENGTH_MS));
}

#[test]
fn an_unverified_pending_or_cancelled_purchase_unlocks_nothing() {
    let setup = app_store();
    entitled(&setup, Vec::new());
    for (outcome, expected) in [
        (
            Purchase::Unverified("E_APP_STORE_UNVERIFIED_SIGNATURE"),
            Err(StoreError::UNVERIFIED),
        ),
        (Purchase::Pending, Ok(Bought::Pending)),
        (Purchase::Cancelled, Ok(Bought::Cancelled)),
    ] {
        setup.store().set_purchase(Product::Pro, Ok(outcome));
        assert_eq!(block_on(setup.shop.purchase(Product::Pro)), expected);
        assert_eq!(setup.licence.require(), Err(REQUIRED));
    }
    assert_eq!(setup.store().finished(), Vec::<u64>::new());
}

#[test]
fn an_ask_to_buy_approval_arrives_as_an_update_and_unlocks() {
    let setup = app_store();
    block_on(async {
        let running = tauri::async_runtime::spawn(Arc::clone(&setup.shop).run());
        until(|| {
            setup
                .licence
                .snapshot()
                .app_store
                .is_some_and(|s| s.code.is_none())
        })
        .await;
        setup
            .store()
            .push_update(Update::Transaction(transaction(Product::Pro, 9, START)));
        until(|| setup.licence.require().is_ok()).await;
        until(|| setup.store().finished() == vec![9]).await;
        setup
            .store()
            .push_update(Update::Unverified("E_APP_STORE_UNVERIFIED_SIGNATURE"));
        running.abort();
    });
    assert_eq!(setup.licence.require(), Ok(()));
}

#[test]
fn the_listener_starts_before_the_first_read_and_its_updates_land_after_it() {
    let setup = app_store();
    // A refund queued while the app was closed, and the stale entitlement StoreKit still reports.
    let pro = transaction(Product::Pro, 1, START);
    setup.store().set_entitlements(vec![pro.clone()]);
    setup
        .store()
        .push_update(Update::Transaction(refunded(pro, START)));
    setup
        .store()
        .set_entitlements(vec![transaction(Product::Pro, 1, START)]);
    block_on(async {
        let running = tauri::async_runtime::spawn(Arc::clone(&setup.shop).run());
        until(|| setup.store().finished() == vec![1]).await;
        running.abort();
    });
    assert_eq!(setup.licence.require(), Err(REQUIRED));
    assert_eq!(
        setup.store().updates().map(|_| ()),
        Err(StoreError::LISTENING),
        "the listener runs once"
    );
}

#[test]
fn a_bridge_that_never_answers_times_out_and_the_launch_read_is_tried_again() {
    let setup = app_store();
    setup.store().set_silent(true);
    assert_eq!(block_on(setup.shop.products()), Err(StoreError::NO_REPLY));
    assert_eq!(block_on(setup.shop.restore()), Err(StoreError::NO_REPLY));
    block_on(async {
        let running = tauri::async_runtime::spawn(Arc::clone(&setup.shop).run());
        until(|| {
            setup.licence.snapshot().app_store.and_then(|s| s.code) == Some("E_APP_STORE_NO_REPLY")
        })
        .await;
        setup
            .store()
            .set_entitlements(vec![transaction(Product::Pro, 1, START)]);
        setup.store().set_silent(false);
        until(|| setup.licence.require().is_ok()).await;
        running.abort();
    });
}

#[test]
fn a_purchase_has_no_time_limit() {
    let setup = app_store();
    setup.store().set_silent(true);
    setup.store().set_purchase(
        Product::Pro,
        Ok(Purchase::Purchased(transaction(Product::Pro, 3, START))),
    );
    // Only finishing it, after the licence holds it, waits, and that times out.
    assert_eq!(
        block_on(setup.shop.purchase(Product::Pro)),
        Ok(Bought::Purchased)
    );
    assert_eq!(setup.licence.require(), Ok(()));
}

#[test]
fn restore_purchases_reads_the_entitlements_again() {
    let setup = app_store();
    entitled(&setup, Vec::new());
    setup.store().set_restore(Ok(Restore::Synced));
    setup
        .store()
        .set_entitlements(vec![transaction(Product::Pro, 1, START)]);
    assert_eq!(block_on(setup.shop.restore()), Ok(()));
    assert_eq!(setup.licence.require(), Ok(()));

    setup.store().set_restore(Ok(Restore::Cancelled));
    setup.store().set_entitlements(Vec::new());
    assert_eq!(block_on(setup.shop.restore()), Ok(()));
    assert_eq!(setup.licence.require(), Err(REQUIRED));
}

#[test]
fn a_failed_sync_still_restores_what_the_entitlements_read_found() {
    let setup = app_store();
    entitled(&setup, Vec::new());
    setup.store().set_restore(Err(StoreError::UNKNOWN));
    setup
        .store()
        .set_entitlements(vec![transaction(Product::Pro, 1, START)]);
    assert_eq!(block_on(setup.shop.restore()), Ok(()));
    assert_eq!(setup.licence.require(), Ok(()));
}

#[test]
fn the_sheet_gets_storekits_price_for_each_product() {
    let setup = app_store();
    setup.store().set_products(Ok(vec![
        StoreProduct {
            product: Product::Pro,
            display_name: "Devot Pro".to_owned(),
            display_price: "\u{20ac}34,99".to_owned(),
        },
        StoreProduct {
            product: Product::Trial,
            display_name: "30-day Trial".to_owned(),
            display_price: "Free".to_owned(),
        },
    ]));
    let products = block_on(setup.shop.products()).expect("products");
    assert_eq!(
        serde_json::to_value(&products).expect("json"),
        serde_json::json!([
            { "product": "pro", "displayName": "Devot Pro", "displayPrice": "\u{20ac}34,99" },
            { "product": "trial", "displayName": "30-day Trial", "displayPrice": "Free" },
        ])
    );
}

#[test]
fn only_the_two_products_can_be_named() {
    assert_eq!(super::product_of("pro"), Some(Product::Pro));
    assert_eq!(super::product_of("trial"), Some(Product::Trial));
    for other in ["", "Pro", "io.github.jma49.devot.pro", "trial ", "lifetime"] {
        assert_eq!(super::product_of(other), None, "{other}");
    }
}

fn issued(transaction: &str) -> Result<MacKey, &'static str> {
    Ok(MacKey {
        key: format!("key-for-{transaction}"),
        id: ID.to_owned(),
    })
}

#[test]
fn a_mac_key_is_asked_for_with_the_held_pro_purchase_alone() {
    let setup = app_store();
    let asked = std::sync::Mutex::new(Vec::new());
    let exchange = |transaction: &str| {
        asked.lock().expect("asked").push(transaction.to_owned());
        issued(transaction)
    };
    assert_eq!(mac_key(&setup.licence, exchange), Err("E_APP_STORE_NO_PRO"));
    entitled(
        &setup,
        vec![
            transaction(Product::Trial, 1, START),
            StoreTransaction {
                ownership: Ownership::FamilyShared,
                ..transaction(Product::Pro, 2, START)
            },
        ],
    );
    assert_eq!(mac_key(&setup.licence, exchange), Err("E_APP_STORE_NO_PRO"));
    assert!(asked.lock().expect("asked").is_empty());

    let pro = transaction(Product::Pro, 3, START);
    entitled(&setup, vec![pro.clone()]);
    let key = mac_key(&setup.licence, exchange).expect("key");
    assert_eq!(key.key, format!("key-for-{}", pro.jws));
    assert_eq!(*asked.lock().expect("asked"), vec![pro.jws.clone()]);
    assert_eq!(
        setup.licence.snapshot().id,
        None,
        "the key is never added here"
    );

    setup.licence.take_transaction(refunded(pro, START));
    assert_eq!(mac_key(&setup.licence, exchange), Err("E_APP_STORE_NO_PRO"));
}

#[test]
fn a_mac_key_refusal_is_the_workers_code_and_other_builds_have_none() {
    let setup = app_store();
    entitled(&setup, vec![transaction(Product::Pro, 1, START)]);
    assert_eq!(
        mac_key(&setup.licence, |_| Err("E_LICENCE_REVOKED")),
        Err("E_LICENCE_REVOKED")
    );
    let direct = build(true, true, Arc::new(MemoryKey::default()));
    assert_eq!(
        mac_key(&direct.licence, issued),
        Err("E_APP_STORE_UNAVAILABLE")
    );
}

#[test]
fn a_purchase_logs_its_outcome_by_product_and_code() {
    assert_eq!(
        purchase_line(Product::Trial, &Ok(Bought::Purchased)),
        "I_APP_STORE_PURCHASE trial purchased"
    );
    assert_eq!(
        purchase_line(Product::Pro, &Ok(Bought::Cancelled)),
        "I_APP_STORE_PURCHASE pro cancelled"
    );
    assert_eq!(
        purchase_line(Product::Trial, &Err(StoreError::UNAVAILABLE)),
        "W_APP_STORE_PURCHASE trial E_APP_STORE_UNAVAILABLE"
    );
}

#[test]
fn a_refund_is_requested_for_the_held_pro_purchase_alone() {
    let setup = app_store();
    setup.store().set_refund_request(Ok(Refund::Requested));
    assert_eq!(
        block_on(setup.shop.request_refund()),
        Err(StoreError::NO_PRO)
    );
    entitled(
        &setup,
        vec![
            transaction(Product::Trial, 1, START),
            StoreTransaction {
                ownership: Ownership::FamilyShared,
                ..transaction(Product::Pro, 2, START)
            },
        ],
    );
    assert_eq!(
        block_on(setup.shop.request_refund()),
        Err(StoreError::NO_PRO)
    );
    assert!(setup.store().refund_requests().is_empty());

    let pro = transaction(Product::Pro, 3, START);
    entitled(
        &setup,
        vec![transaction(Product::Trial, 1, START), pro.clone()],
    );
    assert_eq!(block_on(setup.shop.request_refund()), Ok(Refund::Requested));
    assert_eq!(setup.store().refund_requests(), vec![3]);

    setup.licence.take_transaction(refunded(pro, START));
    assert_eq!(
        block_on(setup.shop.request_refund()),
        Err(StoreError::NO_PRO)
    );
    assert_eq!(setup.store().refund_requests(), vec![3]);
}

#[test]
fn a_cancelled_or_failed_refund_request_changes_nothing_held() {
    let setup = app_store();
    entitled(&setup, vec![transaction(Product::Pro, 3, START)]);
    setup.store().set_refund_request(Ok(Refund::Cancelled));
    assert_eq!(block_on(setup.shop.request_refund()), Ok(Refund::Cancelled));
    let failed = StoreError::from_code("E_APP_STORE_REFUND_DUPLICATE");
    setup.store().set_refund_request(Err(failed));
    assert_eq!(block_on(setup.shop.request_refund()), Err(failed));
    assert!(setup.writes(), "Devot Pro stays until Apple decides");
    assert_eq!(setup.store().refund_requests(), vec![3, 3]);
}

#[test]
fn only_an_app_store_build_requests_a_refund() {
    let direct = build(true, true, Arc::new(MemoryKey::default()));
    direct.store().set_refund_request(Ok(Refund::Requested));
    assert_eq!(
        block_on(direct.shop.request_refund()),
        Err(StoreError::UNAVAILABLE)
    );
    assert!(direct.store().refund_requests().is_empty());
}

#[test]
fn a_refund_request_logs_its_outcome_as_a_code() {
    assert_eq!(
        refund_line(&Ok(Refund::Requested)),
        "I_APP_STORE_REFUND_REQUESTED"
    );
    assert_eq!(
        refund_line(&Ok(Refund::Cancelled)),
        "I_APP_STORE_REFUND_CANCELLED"
    );
    assert_eq!(
        refund_line(&Err(StoreError::from_code("E_APP_STORE_NETWORK"))),
        "W_APP_STORE_REFUND E_APP_STORE_NETWORK"
    );
}
