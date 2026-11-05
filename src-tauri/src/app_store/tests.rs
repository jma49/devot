use serde_json::{Value, json};

use super::fake::{FakeAppStore, transaction};
use super::payload;
use super::platform;
use super::{
    AppStore, Entitlements, Finish, Ownership, Product, Purchase, Restore, RevocationReason,
    StoreEnvironment, StoreError, StoreProduct, StoreTransaction, Update,
};

const JWS: &str = "eyJhbGciOiJFUzI1NiJ9.eyJ0cmFuc2FjdGlvbklkIjoiMSJ9.c2lnbmF0dXJl";

fn transaction_json() -> Value {
    json!({
        "productId": "io.github.jma49.devot.pro",
        "transactionId": 2_000_000_123_456_789u64,
        "originalTransactionId": 2_000_000_123_456_700u64,
        "bundleId": "io.github.jma49.devot",
        "purchaseDate": 1_767_225_600_000i64,
        "originalPurchaseDate": 1_767_139_200_000i64,
        "ownershipType": "PURCHASED",
        "environment": "Production",
        "jwsRepresentation": JWS,
    })
}

fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("json")
}

fn parsed_transaction() -> StoreTransaction {
    match payload::purchase(&bytes(
        &json!({"status": "purchased", "transaction": transaction_json()}),
    )) {
        Ok(Purchase::Purchased(transaction)) => transaction,
        other => panic!("not a purchase: {other:?}"),
    }
}

#[test]
fn a_verified_transaction_keeps_every_field_storekit_reports() {
    let transaction = parsed_transaction();
    assert_eq!(transaction.product_id, "io.github.jma49.devot.pro");
    assert_eq!(transaction.product(), Some(Product::Pro));
    assert_eq!(transaction.transaction_id, 2_000_000_123_456_789);
    assert_eq!(transaction.original_transaction_id, 2_000_000_123_456_700);
    assert_eq!(transaction.bundle_id, "io.github.jma49.devot");
    assert_eq!(transaction.purchase_date_ms, 1_767_225_600_000);
    assert_eq!(transaction.original_purchase_date_ms, 1_767_139_200_000);
    assert_eq!(transaction.revocation_date_ms, None);
    assert_eq!(transaction.revocation_reason, None);
    assert_eq!(transaction.ownership, Ownership::Purchased);
    assert_eq!(transaction.environment, StoreEnvironment::Production);
    assert_eq!(transaction.jws, JWS);
}

#[test]
fn a_revoked_family_shared_sandbox_transaction_is_read_as_such() {
    let mut value = transaction_json();
    value["revocationDate"] = json!(1_767_312_000_000i64);
    value["revocationReason"] = json!("developerIssue");
    value["ownershipType"] = json!("FAMILY_SHARED");
    value["environment"] = json!("Sandbox");
    let Ok(Update::Transaction(transaction)) = payload::update(&bytes(
        &json!({"status": "transaction", "transaction": value}),
    )) else {
        panic!("not a transaction update");
    };
    assert_eq!(transaction.revocation_date_ms, Some(1_767_312_000_000));
    assert_eq!(
        transaction.revocation_reason,
        Some(RevocationReason::DeveloperIssue)
    );
    assert_eq!(transaction.ownership, Ownership::FamilyShared);
    assert_eq!(transaction.environment, StoreEnvironment::Sandbox);
}

#[test]
fn unknown_fields_are_ignored_and_unknown_enum_values_kept_as_unknown() {
    let mut value = transaction_json();
    value["webOrderLineItemId"] = json!("1");
    value["ownershipType"] = json!("SOMETHING_NEW");
    value["environment"] = json!("Staging");
    value["revocationReason"] = json!("anotherReason");
    let reply = json!({"status": "purchased", "transaction": value, "storefront": "USA"});
    let Ok(Purchase::Purchased(transaction)) = payload::purchase(&bytes(&reply)) else {
        panic!("not a purchase");
    };
    assert_eq!(transaction.ownership, Ownership::Unknown);
    assert_eq!(transaction.environment, StoreEnvironment::Unknown);
    assert_eq!(
        transaction.revocation_reason,
        Some(RevocationReason::Unknown)
    );
    assert_eq!(
        payload::purchase(&bytes(&json!({"status": "pending", "extra": true}))),
        Ok(Purchase::Pending)
    );
}

#[test]
fn a_missing_or_mistyped_required_field_is_the_payload_code() {
    for field in [
        "productId",
        "transactionId",
        "originalTransactionId",
        "bundleId",
        "purchaseDate",
        "originalPurchaseDate",
        "ownershipType",
        "environment",
        "jwsRepresentation",
    ] {
        let mut value = transaction_json();
        value.as_object_mut().expect("object").remove(field);
        let reply = json!({"status": "purchased", "transaction": value});
        assert_eq!(
            payload::purchase(&bytes(&reply)),
            Err(StoreError::PAYLOAD),
            "{field}"
        );
    }
    let mut value = transaction_json();
    value["transactionId"] = json!("2000000123456789");
    let reply = json!({"status": "purchased", "transaction": value});
    assert_eq!(payload::purchase(&bytes(&reply)), Err(StoreError::PAYLOAD));
    let mut value = transaction_json();
    value["transactionId"] = json!(-1);
    let reply = json!({"status": "purchased", "transaction": value});
    assert_eq!(payload::purchase(&bytes(&reply)), Err(StoreError::PAYLOAD));
}

#[test]
fn malformed_replies_are_the_payload_code_never_a_panic() {
    let replies: [&[u8]; 7] = [
        b"",
        b"not json",
        b"[]",
        b"{}",
        b"{\"status\":\"purchased\"}",
        b"{\"status\":\"somethingElse\"}",
        &[0xff, 0xfe, 0x00],
    ];
    for reply in replies {
        assert_eq!(payload::purchase(reply), Err(StoreError::PAYLOAD));
        assert_eq!(payload::products(reply), Err(StoreError::PAYLOAD));
        assert_eq!(payload::restore(reply), Err(StoreError::PAYLOAD));
        assert_eq!(payload::entitlements(reply), Err(StoreError::PAYLOAD));
        assert_eq!(payload::finish(reply), Err(StoreError::PAYLOAD));
        assert_eq!(payload::update(reply), Err(StoreError::PAYLOAD));
    }
}

#[test]
fn a_reply_meant_for_another_call_is_the_payload_code() {
    let synced = bytes(&json!({"status": "synced"}));
    assert_eq!(payload::purchase(&synced), Err(StoreError::PAYLOAD));
    assert_eq!(payload::products(&synced), Err(StoreError::PAYLOAD));
    let purchased = bytes(&json!({"status": "purchased", "transaction": transaction_json()}));
    assert_eq!(payload::update(&purchased), Err(StoreError::PAYLOAD));
    assert_eq!(payload::restore(&purchased), Err(StoreError::PAYLOAD));
}

#[test]
fn an_unverified_result_is_only_its_code() {
    let reply = json!({"status": "unverified", "code": "E_APP_STORE_UNVERIFIED_SIGNATURE"});
    assert_eq!(
        payload::purchase(&bytes(&reply)),
        Ok(Purchase::Unverified("E_APP_STORE_UNVERIFIED_SIGNATURE"))
    );
    assert_eq!(
        payload::update(&bytes(&reply)),
        Ok(Update::Unverified("E_APP_STORE_UNVERIFIED_SIGNATURE"))
    );
    let unknown = json!({"status": "unverified", "code": "anything Swift made up"});
    assert_eq!(
        payload::purchase(&bytes(&unknown)),
        Ok(Purchase::Unverified("E_APP_STORE_UNVERIFIED"))
    );
}

#[test]
fn swift_error_codes_map_to_the_known_codes_and_anything_else_to_unknown() {
    for code in [
        "E_APP_STORE_NETWORK",
        "E_APP_STORE_SYSTEM",
        "E_APP_STORE_NOT_AVAILABLE",
        "E_APP_STORE_NOT_ENTITLED",
        "E_APP_STORE_PRODUCT_UNAVAILABLE",
        "E_APP_STORE_PURCHASE_NOT_ALLOWED",
        "E_APP_STORE_PURCHASE_FAILED",
        "E_APP_STORE_PRODUCT_NOT_FOUND",
        "E_APP_STORE_UNKNOWN_PRODUCT",
        "E_APP_STORE_UNKNOWN",
    ] {
        let reply = bytes(&json!({"status": "error", "code": code}));
        assert_eq!(payload::purchase(&reply).map_err(|e| e.code()), Err(code));
    }
    let made_up = bytes(&json!({"status": "error", "code": "a description with data in it"}));
    assert_eq!(payload::products(&made_up), Err(StoreError::UNKNOWN));
}

#[test]
fn purchase_outcomes_are_read() {
    assert_eq!(
        payload::purchase(&bytes(&json!({"status": "pending"}))),
        Ok(Purchase::Pending)
    );
    assert_eq!(
        payload::purchase(&bytes(&json!({"status": "cancelled"}))),
        Ok(Purchase::Cancelled)
    );
}

#[test]
fn products_keep_only_the_two_known_products_with_their_price() {
    let reply = json!({"status": "products", "products": [
        {"id": "io.github.jma49.devot.pro", "displayName": "Devot Pro", "displayPrice": "$29.99", "type": "nonConsumable"},
        {"id": "io.github.jma49.devot.trial", "displayName": "30-day Trial", "displayPrice": "Free"},
        {"id": "io.github.jma49.devot.other", "displayName": "Other", "displayPrice": "$1.00"},
    ]});
    assert_eq!(
        payload::products(&bytes(&reply)),
        Ok(vec![
            StoreProduct {
                product: Product::Pro,
                display_name: "Devot Pro".into(),
                display_price: "$29.99".into(),
            },
            StoreProduct {
                product: Product::Trial,
                display_name: "30-day Trial".into(),
                display_price: "Free".into(),
            },
        ])
    );
    let missing_price = json!({"status": "products", "products": [
        {"id": "io.github.jma49.devot.pro", "displayName": "Devot Pro"},
    ]});
    assert_eq!(
        payload::products(&bytes(&missing_price)),
        Err(StoreError::PAYLOAD)
    );
    assert_eq!(
        payload::products(&bytes(&json!({"status": "products", "products": []}))),
        Ok(vec![])
    );
}

#[test]
fn entitlements_carry_verified_transactions_and_unverified_codes() {
    let reply = json!({
        "status": "entitlements",
        "transactions": [transaction_json()],
        "unverified": ["E_APP_STORE_UNVERIFIED_CERTIFICATE_CHAIN", "made up"],
    });
    let entitlements = payload::entitlements(&bytes(&reply)).expect("entitlements");
    assert_eq!(entitlements.transactions, vec![parsed_transaction()]);
    assert_eq!(
        entitlements.unverified,
        vec![
            "E_APP_STORE_UNVERIFIED_CERTIFICATE_CHAIN",
            "E_APP_STORE_UNVERIFIED"
        ]
    );
    let none = json!({"status": "entitlements", "transactions": []});
    assert_eq!(
        payload::entitlements(&bytes(&none)),
        Ok(Entitlements::default())
    );
}

#[test]
fn restore_and_finish_outcomes_are_read() {
    assert_eq!(
        payload::restore(&bytes(&json!({"status": "synced"}))),
        Ok(Restore::Synced)
    );
    assert_eq!(
        payload::restore(&bytes(&json!({"status": "cancelled"}))),
        Ok(Restore::Cancelled)
    );
    assert_eq!(
        payload::restore(&bytes(
            &json!({"status": "error", "code": "E_APP_STORE_NETWORK"})
        )),
        Err(StoreError::from_code("E_APP_STORE_NETWORK"))
    );
    assert_eq!(
        payload::finish(&bytes(&json!({"status": "finished"}))),
        Ok(Finish::Finished)
    );
    assert_eq!(
        payload::finish(&bytes(&json!({"status": "notFound"}))),
        Ok(Finish::NotFound)
    );
}

#[test]
fn a_transaction_debug_print_leaves_out_the_jws() {
    let printed = format!("{:?}", parsed_transaction());
    assert!(!printed.contains(JWS), "{printed}");
    assert!(!printed.contains("eyJ"), "{printed}");
    assert!(printed.contains("2000000123456789"), "{printed}");
    let purchase = format!("{:?}", Purchase::Purchased(parsed_transaction()));
    assert!(!purchase.contains("eyJ"), "{purchase}");
}

#[test]
fn product_ids_are_the_app_store_ids() {
    assert_eq!(Product::Pro.id(), "io.github.jma49.devot.pro");
    assert_eq!(Product::Trial.id(), "io.github.jma49.devot.trial");
    assert_eq!(
        Product::from_id("io.github.jma49.devot.trial"),
        Some(Product::Trial)
    );
    assert_eq!(Product::from_id("io.github.jma49.devot"), None);
}

#[test]
fn error_codes_are_app_store_codes() {
    for error in [
        StoreError::PAYLOAD,
        StoreError::UNAVAILABLE,
        StoreError::NO_REPLY,
        StoreError::LISTENING,
        StoreError::UNKNOWN,
    ] {
        assert!(error.code().starts_with("E_APP_STORE_"), "{error}");
        assert_eq!(error.to_string(), error.code());
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

#[test]
fn an_empty_fake_is_a_device_without_the_store() {
    runtime().block_on(async {
        let store = FakeAppStore::default();
        assert_eq!(store.products().await, Ok(vec![]));
        assert_eq!(
            store.purchase(Product::Pro).await,
            Err(StoreError::UNAVAILABLE)
        );
        assert_eq!(store.restore().await, Err(StoreError::UNAVAILABLE));
        assert_eq!(
            store.current_entitlements().await,
            Ok(Entitlements::default())
        );
        assert_eq!(store.finish(1).await, Ok(Finish::NotFound));
    });
}

#[test]
fn the_fake_records_a_purchase_as_storekit_does() {
    runtime().block_on(async {
        let store = FakeAppStore::default();
        let bought = transaction(Product::Trial, 7, 1_767_225_600_000);
        store.set_purchase(Product::Trial, Ok(Purchase::Purchased(bought.clone())));
        assert_eq!(
            store.purchase(Product::Trial).await,
            Ok(Purchase::Purchased(bought.clone()))
        );
        assert_eq!(store.purchased(), vec![Product::Trial]);
        assert_eq!(
            store.current_entitlements().await.expect("ok").transactions,
            vec![bought]
        );
        assert_eq!(store.finish(7).await, Ok(Finish::Finished));
        assert_eq!(store.finish(7).await, Ok(Finish::NotFound));
        assert_eq!(store.finished(), vec![7]);
    });
}

#[test]
fn the_fake_gives_scripted_outcomes_and_errors() {
    runtime().block_on(async {
        let store = FakeAppStore::default();
        store.set_products(Ok(vec![StoreProduct {
            product: Product::Pro,
            display_name: "Devot Pro".into(),
            display_price: "$29.99".into(),
        }]));
        assert_eq!(store.products().await.expect("ok").len(), 1);
        store.set_products(Err(StoreError::from_code("E_APP_STORE_NETWORK")));
        assert_eq!(
            store.products().await,
            Err(StoreError::from_code("E_APP_STORE_NETWORK"))
        );
        store.set_purchase(Product::Pro, Ok(Purchase::Pending));
        assert_eq!(store.purchase(Product::Pro).await, Ok(Purchase::Pending));
        assert_eq!(
            store.current_entitlements().await,
            Ok(Entitlements::default())
        );
        store.set_purchase(Product::Pro, Ok(Purchase::Cancelled));
        assert_eq!(store.purchase(Product::Pro).await, Ok(Purchase::Cancelled));
        store.set_restore(Ok(Restore::Synced));
        assert_eq!(store.restore().await, Ok(Restore::Synced));
    });
}

#[test]
fn the_fake_delivers_updates_from_before_and_after_the_listener_starts() {
    runtime().block_on(async {
        let store = FakeAppStore::default();
        let approved = transaction(Product::Pro, 9, 1_767_225_600_000);
        store.push_update(Update::Transaction(approved.clone()));
        let mut updates = store.updates().expect("first listener");
        assert_eq!(store.updates().err(), Some(StoreError::LISTENING));
        assert_eq!(
            updates.recv().await,
            Some(Update::Transaction(approved.clone()))
        );
        store.push_update(Update::Unverified("E_APP_STORE_UNVERIFIED_SIGNATURE"));
        assert_eq!(
            updates.recv().await,
            Some(Update::Unverified("E_APP_STORE_UNVERIFIED_SIGNATURE"))
        );
        assert_eq!(
            store.current_entitlements().await.expect("ok").transactions,
            vec![approved]
        );
    });
}

#[test]
fn a_refund_in_the_fake_revokes_and_reports_the_transaction() {
    runtime().block_on(async {
        let store = FakeAppStore::default();
        let bought = transaction(Product::Pro, 11, 1_767_225_600_000);
        store.set_entitlements(vec![bought.clone()]);
        let mut updates = store.updates().expect("listener");
        store.refund(11, 1_767_312_000_000);
        let Some(Update::Transaction(refunded)) = updates.recv().await else {
            panic!("no refund update");
        };
        assert_eq!(refunded.transaction_id, 11);
        assert_eq!(refunded.revocation_date_ms, Some(1_767_312_000_000));
        assert_eq!(refunded.revocation_reason, Some(RevocationReason::Other));
        assert_eq!(
            store.current_entitlements().await,
            Ok(Entitlements::default())
        );
    });
}

#[cfg(not(target_os = "ios"))]
#[test]
fn off_ios_the_store_is_the_empty_fake() {
    runtime().block_on(async {
        let store = platform();
        assert_eq!(store.products().await, Ok(vec![]));
        assert_eq!(
            store.purchase(Product::Trial).await,
            Err(StoreError::UNAVAILABLE)
        );
        assert_eq!(store.restore().await, Err(StoreError::UNAVAILABLE));
    });
}
