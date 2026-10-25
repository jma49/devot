//! Licences signed with licence/test-vectors.json's test key, for the tests of what needs one.

use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};

use super::keys::TEST;
use super::store::MemoryKey;
use super::{Licence, PublicKeys, Snapshot};

pub(crate) const VECTORS: &str = include_str!("../../../licence/test-vectors.json");
pub(crate) const ID: &str = "5vEvzHainWD0cA2Ht_ljHg";
pub(crate) const LICENSEE: &str = "buyer@example.com";

pub(crate) fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("test vectors are JSON")
}

fn signing_key() -> SigningKey {
    let seed = vectors()["keys"][0]["seed"]
        .as_str()
        .expect("seed")
        .to_owned();
    let raw = URL_SAFE_NO_PAD.decode(seed).expect("seed");
    SigningKey::from_bytes(&raw.try_into().expect("32 bytes"))
}

pub(crate) fn sign_raw(prefix: &str, payload: &[u8]) -> String {
    let signed = format!("{prefix}.{}", URL_SAFE_NO_PAD.encode(payload));
    let signature = signing_key().sign(signed.as_bytes());
    format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

pub(crate) fn sign(prefix: &str, payload: &Value) -> String {
    sign_raw(prefix, payload.to_string().as_bytes())
}

pub(crate) fn licence_json(id: &str, updates_until: &str) -> Value {
    json!({
        "id": id,
        "kid": "test",
        "plan": "pro",
        "licensee": LICENSEE,
        "issuedAt": "2026-10-24T09:30:00Z",
        "updatesUntil": updates_until,
    })
}

pub(crate) fn key(id: &str, updates_until: &str) -> String {
    sign("devot1", &licence_json(id, updates_until))
}

pub(crate) fn test_keys(gated: bool) -> PublicKeys {
    PublicKeys::new(&[TEST], gated)
}

/// A licence that trusts the test key, in `dir`, with nothing in its keychain.
pub(crate) fn licence(dir: &Path, gated: bool) -> Arc<Licence> {
    Arc::new(Licence::new(
        test_keys(gated),
        None,
        Arc::new(MemoryKey::default()),
        dir,
        Arc::new(|_: &Snapshot| {}),
    ))
}
