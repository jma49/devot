//! Licences signed with licence/test-vectors.json's test key, for the tests of what needs one.

use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};

use super::keys::TEST;
use super::store::MemoryKey;
use super::{Gate, Licence, PublicKeys, Snapshot};
use crate::commands::notes::{NoteDto, put_note};
use crate::storage::Db;

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

pub(crate) fn licence_json(id: &str) -> Value {
    json!({
        "id": id,
        "kid": "test",
        "plan": "pro",
        "licensee": LICENSEE,
        "issuedAt": "2026-10-24T09:30:00Z",
    })
}

pub(crate) fn key(id: &str) -> String {
    sign("devot1", &licence_json(id))
}

pub(crate) fn test_keys(gated: bool) -> PublicKeys {
    PublicKeys::new(&[TEST], gated)
}

/// A trial that began at the epoch, so it is long over.
pub(crate) fn trial_over() -> Arc<MemoryKey> {
    Arc::new(MemoryKey::holding("{\"start\":0,\"seen\":0}"))
}

/// A licence that trusts the test key, in `dir`, with no key in its keychain and its trial over.
pub(crate) fn licence(dir: &Path, gated: bool) -> Arc<Licence> {
    Arc::new(Licence::new(
        test_keys(gated),
        Arc::new(MemoryKey::default()),
        trial_over(),
        dir,
        Arc::new(|_: &Snapshot| {}),
    ))
}

/// A database on a temporary file whose writes `licence` judges, as the app guards its own at launch.
pub(crate) fn gated_db(licence: &Arc<Licence>) -> (tempfile::TempDir, Db) {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = Db::spawn(&dir.path().join("devot.sqlite")).expect("database");
    let gate = Gate::of(licence);
    db.guard(Arc::new(move |what| gate.require_write(what)));
    (dir, db)
}

/// Saves note `id` as the window does, at the body version its last save left.
pub(crate) fn save_note(db: &Db, id: &str, body_version: i64) -> Result<(), String> {
    let note = NoteDto {
        id: id.into(),
        title: "Title".into(),
        title_hlc: "0001728000000000-0000-node".into(),
        body_md: "Typed".into(),
        ydoc: STANDARD.encode([1]),
        body_version,
        book_id: None,
        book_hlc: String::new(),
        status: "none".into(),
        status_hlc: String::new(),
        pinned: false,
        pinned_hlc: String::new(),
        created_at: 1,
        updated_at: 1,
        dates_hlc: String::new(),
        deleted_at: None,
        deleted_hlc: None,
    };
    tauri::async_runtime::block_on(put_note(db, note, Vec::new(), None))
}

/// Whether note `id` is stored, in the trash or not.
pub(crate) fn has_note(db: &Db, id: &str) -> bool {
    let id = id.to_owned();
    tauri::async_runtime::block_on(db.call(move |store| store.has_note(&id))).expect("read")
}
