use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use tokio::sync::oneshot;

/// The StoreKit bridge (`src-tauri/apple/DevotStore`, `Bridge.swift`). Each call starts a Swift
/// task and returns; the task replies once, on a thread of its own, with the call's request number
/// and UTF-8 JSON that stays valid only until the callback returns, so Rust copies it and Swift
/// frees it. Numbers, not pointers, name the waiting call: a late or repeated reply finds none and
/// is dropped.
type StoreReply = extern "C" fn(request: u64, json: *const u8, len: usize);
type StoreUpdate = extern "C" fn(json: *const u8, len: usize);

// SAFETY: these are the `@_cdecl` functions of `Bridge.swift`, with the same C types; the iOS app
// links the Swift package that defines them.
unsafe extern "C" {
    fn devot_store_products(request: u64, reply: StoreReply);
    fn devot_store_purchase(
        request: u64,
        product_id: *const u8,
        product_id_len: usize,
        reply: StoreReply,
    );
    fn devot_store_restore(request: u64, reply: StoreReply);
    fn devot_store_entitlements(request: u64, reply: StoreReply);
    fn devot_store_finish(request: u64, transaction_id: u64, reply: StoreReply);
    fn devot_store_listen(update: StoreUpdate) -> bool;
}

/// Far above two products' transactions with their JWS; a reply beyond it is read as empty.
const STORE_REPLY_LIMIT: usize = 4 << 20;

type StoreCalls = BTreeMap<u64, oneshot::Sender<Vec<u8>>>;

static STORE_CALLS: Mutex<StoreCalls> = Mutex::new(BTreeMap::new());
static STORE_NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
static STORE_UPDATES: OnceLock<Box<dyn Fn(Vec<u8>) + Send + Sync>> = OnceLock::new();

fn store_calls() -> MutexGuard<'static, StoreCalls> {
    crate::locks::lock(&STORE_CALLS)
}

fn copy_store_reply(json: *const u8, len: usize) -> Vec<u8> {
    if json.is_null() || len == 0 || len > STORE_REPLY_LIMIT {
        return Vec::new();
    }
    // SAFETY: Swift passes `len` initialised bytes that stay valid and unchanged until the callback
    // that received them returns, and this copy happens inside it.
    unsafe { std::slice::from_raw_parts(json, len) }.to_vec()
}

extern "C" fn store_reply(request: u64, json: *const u8, len: usize) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let json = copy_store_reply(json, len);
        if let Some(waiting) = store_calls().remove(&request) {
            let _ = waiting.send(json);
        }
    }));
}

extern "C" fn store_update(json: *const u8, len: usize) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let json = copy_store_reply(json, len);
        if let Some(deliver) = STORE_UPDATES.get() {
            deliver(json);
        }
    }));
}

fn store_call(start: impl FnOnce(u64)) -> oneshot::Receiver<Vec<u8>> {
    let request = STORE_NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    store_calls().insert(request, sender);
    start(request);
    receiver
}

pub fn store_products() -> oneshot::Receiver<Vec<u8>> {
    // SAFETY: the bridge function only starts a task and returns; `store_reply` is a plain function
    // that lives as long as the process.
    store_call(|request| unsafe { devot_store_products(request, store_reply) })
}

pub fn store_purchase(product_id: &str) -> oneshot::Receiver<Vec<u8>> {
    // SAFETY: `product_id` is `product_id.len()` bytes of UTF-8 that outlive the call, which copies
    // them before it returns; `store_reply` lives as long as the process.
    store_call(|request| unsafe {
        devot_store_purchase(request, product_id.as_ptr(), product_id.len(), store_reply)
    })
}

pub fn store_restore() -> oneshot::Receiver<Vec<u8>> {
    // SAFETY: as in `store_products`.
    store_call(|request| unsafe { devot_store_restore(request, store_reply) })
}

pub fn store_entitlements() -> oneshot::Receiver<Vec<u8>> {
    // SAFETY: as in `store_products`.
    store_call(|request| unsafe { devot_store_entitlements(request, store_reply) })
}

pub fn store_finish(transaction_id: u64) -> oneshot::Receiver<Vec<u8>> {
    // SAFETY: as in `store_products`; the transaction ID is a plain number.
    store_call(|request| unsafe { devot_store_finish(request, transaction_id, store_reply) })
}

/// Starts StoreKit's transaction listener, which hands every update's JSON to `deliver` on a Swift
/// thread. Only the first call starts it; a later one gives `false`.
pub fn store_listen(deliver: Box<dyn Fn(Vec<u8>) + Send + Sync>) -> bool {
    if STORE_UPDATES.set(deliver).is_err() {
        return false;
    }
    // SAFETY: the bridge function only starts the listener task and returns; `store_update` lives
    // as long as the process, and `STORE_UPDATES` is set before any update can arrive.
    unsafe { devot_store_listen(store_update) }
}
