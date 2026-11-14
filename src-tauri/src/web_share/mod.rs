//! Share on Web (ADR 0019, docs/specs/share-on-web.md): Rust fills in the page's images, seals it
//! under the share's key and uploads only the envelope. Each share's ID, token and key stay in the
//! Keychain of the device that made it. Errors and logs carry codes and note IDs only.

mod client;
mod seal;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::notes::valid_note_id;
use crate::export::PageImage;
use crate::storage::Db;
use client::Sender;

pub const HOST: &str = "https://share.devot.online";
const MAX_TITLE_CHARS: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub token: String,
    pub key: String,
    pub expires_at: i64,
}

impl Record {
    fn valid(&self) -> bool {
        client::valid_id(&self.id)
            && client::valid_token(&self.token)
            && seal::key_from_text(&self.key).is_ok()
    }
}

/// What the window shows of a share: never the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    pub url: String,
    pub expires_at: i64,
}

pub trait ShareStore: Send + Sync {
    fn get(&self, note_id: &str) -> Result<Option<Record>, &'static str>;
    fn set(&self, note_id: &str, record: &Record) -> Result<(), &'static str>;
    /// Clearing a record that is not there is not an error.
    fn clear(&self, note_id: &str) -> Result<(), &'static str>;
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub struct Keychain {
    service: String,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl Keychain {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    fn with<T>(&self, note_id: &str, work: impl FnOnce(crate::keychain::Item) -> T) -> T {
        let account = format!("web-share-{note_id}");
        work(crate::keychain::Item {
            service: &self.service,
            account: &account,
        })
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl ShareStore for Keychain {
    fn get(&self, note_id: &str) -> Result<Option<Record>, &'static str> {
        match self.with(note_id, |item| item.get()) {
            Ok(Some(bytes)) => Ok(serde_json::from_slice::<Record>(&bytes).ok()),
            Ok(None) => Ok(None),
            Err(_) => Err("E_SHARE_KEYCHAIN_FAILED"),
        }
    }

    fn set(&self, note_id: &str, record: &Record) -> Result<(), &'static str> {
        let bytes = serde_json::to_vec(record).map_err(|_| "E_SHARE_KEYCHAIN_FAILED")?;
        self.with(note_id, |item| item.set(&bytes))
            .map_err(|_| "E_SHARE_KEYCHAIN_FAILED")
    }

    fn clear(&self, note_id: &str) -> Result<(), &'static str> {
        self.with(note_id, |item| item.delete())
            .map(|_| ())
            .map_err(|_| "E_SHARE_KEYCHAIN_FAILED")
    }
}

/// Where there is no Keychain (tests, other platforms): kept for the run only.
#[cfg(any(test, not(any(target_os = "macos", target_os = "ios"))))]
#[derive(Default)]
pub struct MemoryStore(Mutex<std::collections::HashMap<String, Record>>);

#[cfg(any(test, not(any(target_os = "macos", target_os = "ios"))))]
impl ShareStore for MemoryStore {
    fn get(&self, note_id: &str) -> Result<Option<Record>, &'static str> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "E_SHARE_STORE_FAILED")?
            .get(note_id)
            .cloned())
    }

    fn set(&self, note_id: &str, record: &Record) -> Result<(), &'static str> {
        self.0
            .lock()
            .map_err(|_| "E_SHARE_STORE_FAILED")?
            .insert(note_id.to_string(), record.clone());
        Ok(())
    }

    fn clear(&self, note_id: &str) -> Result<(), &'static str> {
        self.0
            .lock()
            .map_err(|_| "E_SHARE_STORE_FAILED")?
            .remove(note_id);
        Ok(())
    }
}

/// The store, and the notes with a share call running: a second call for the same note is
/// refused (`E_SHARE_BUSY`) rather than raced, so a record is never written by two calls at once.
pub struct WebShares {
    store: Arc<dyn ShareStore>,
    host: String,
    busy: Mutex<HashSet<String>>,
}

struct Busy<'a> {
    shares: &'a WebShares,
    note_id: String,
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.shares.busy.lock() {
            busy.remove(&self.note_id);
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

impl WebShares {
    pub fn new(store: Arc<dyn ShareStore>) -> Self {
        Self::with_host(store, HOST)
    }

    fn with_host(store: Arc<dyn ShareStore>, host: &str) -> Self {
        Self {
            store,
            host: host.to_string(),
            busy: Mutex::new(HashSet::new()),
        }
    }

    fn hold(&self, note_id: &str) -> Result<Busy<'_>, &'static str> {
        let mut busy = self.busy.lock().map_err(|_| "E_SHARE_STORE_FAILED")?;
        if !busy.insert(note_id.to_string()) {
            return Err("E_SHARE_BUSY");
        }
        Ok(Busy {
            shares: self,
            note_id: note_id.to_string(),
        })
    }

    fn shared(&self, record: &Record) -> Shared {
        Shared {
            url: client::link(&self.host, &record.id, &record.key),
            expires_at: record.expires_at,
        }
    }

    /// The live share of a note; an expired or unreadable one is forgotten.
    fn live(&self, note_id: &str, now: i64) -> Result<Option<Record>, &'static str> {
        match self.store.get(note_id)? {
            Some(record) if record.valid() && record.expires_at > now => Ok(Some(record)),
            Some(_) => {
                self.store.clear(note_id)?;
                Ok(None)
            }
            None => Ok(None),
        }
    }

    pub fn status(&self, note_id: &str, now: i64) -> Result<Option<Shared>, &'static str> {
        Ok(self.live(note_id, now)?.map(|record| self.shared(&record)))
    }

    /// Updates a live share in place (same link, same expiry); otherwise shares the page anew
    /// for `lifetime` days under a new key.
    pub fn publish(
        &self,
        note_id: &str,
        title: &str,
        html: &str,
        lifetime: u8,
        now: i64,
        send: Sender,
    ) -> Result<Shared, &'static str> {
        let _busy = self.hold(note_id)?;
        let plaintext = zeroize::Zeroizing::new(seal::plaintext(title, html));
        if let Some(record) = self.live(note_id, now)? {
            let key = seal::key_from_text(&record.key)?;
            let envelope = seal::seal(&plaintext, &key, seal::new_nonce()?)?;
            match client::update(&self.host, &record.id, &record.token, &envelope, send) {
                Ok(()) => {
                    log::info!("I_SHARE_UPDATED {note_id}");
                    return Ok(self.shared(&record));
                }
                Err("E_SHARE_NOT_FOUND") => self.store.clear(note_id)?,
                Err(code) => return Err(code),
            }
        }
        if !client::LIFETIMES.contains(&lifetime) {
            return Err("E_SHARE_LIFETIME_INVALID");
        }
        let key = seal::new_key()?;
        let envelope = seal::seal(&plaintext, &key, seal::new_nonce()?)?;
        let created = client::create(&self.host, &envelope, lifetime, send)?;
        let record = Record {
            id: created.id,
            token: created.token,
            key: seal::key_text(&key),
            expires_at: created.expires_at,
        };
        if let Err(code) = self.store.set(note_id, &record) {
            // Without its token nobody could stop the page early, so it is taken down again.
            let _ = client::delete(&self.host, &record.id, &record.token, send);
            return Err(code);
        }
        log::info!("I_SHARE_CREATED {note_id} {lifetime}");
        Ok(self.shared(&record))
    }

    pub fn stop(&self, note_id: &str, send: Sender) -> Result<(), &'static str> {
        let _busy = self.hold(note_id)?;
        let Some(record) = self.store.get(note_id)?.filter(Record::valid) else {
            self.store.clear(note_id)?;
            return Ok(());
        };
        client::delete(&self.host, &record.id, &record.token, send)?;
        self.store.clear(note_id)?;
        log::info!("I_SHARE_STOPPED {note_id}");
        Ok(())
    }
}

fn check_note(note_id: &str) -> Result<(), String> {
    if valid_note_id(note_id) {
        Ok(())
    } else {
        Err("E_NOTE_ID_INVALID".into())
    }
}

#[tauri::command]
pub async fn web_share_status(
    shares: State<'_, Arc<WebShares>>,
    note_id: String,
) -> Result<Option<Shared>, String> {
    check_note(&note_id)?;
    crate::task::blocking_with(&shares, "E_SHARE_FAILED", move |shares| {
        shares.status(&note_id, now_ms())
    })
    .await
}

#[tauri::command]
pub async fn web_share_publish(
    db: State<'_, Db>,
    shares: State<'_, Arc<WebShares>>,
    note_id: String,
    title: String,
    html: String,
    images: Vec<PageImage>,
    lifetime: u8,
) -> Result<Shared, String> {
    check_note(&note_id)?;
    if title.chars().count() > MAX_TITLE_CHARS || title.contains('\0') {
        return Err("E_SHARE_TITLE_INVALID".into());
    }
    if !client::LIFETIMES.contains(&lifetime) {
        return Err("E_SHARE_LIFETIME_INVALID".into());
    }
    let html = crate::export::page_with_images(&db, html, images).await?;
    crate::task::blocking_with(&shares, "E_SHARE_FAILED", move |shares| {
        shares.publish(
            &note_id,
            &title,
            &html,
            lifetime,
            now_ms(),
            &crate::net::send,
        )
    })
    .await
}

#[tauri::command]
pub async fn web_share_stop(
    shares: State<'_, Arc<WebShares>>,
    note_id: String,
) -> Result<(), String> {
    check_note(&note_id)?;
    crate::task::blocking_with(&shares, "E_SHARE_FAILED", move |shares| {
        shares.stop(&note_id, &crate::net::send)
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::net::{Fetched, Method, Request};

    const NOTE: &str = "0190f0a0-0000-7000-8000-000000000001";
    const ID: &str = "AAAAAAAAAAAAAAAAAAAAAA";
    const TOKEN: &str = "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT";
    const NOW: i64 = 1_767_225_600_000;
    const DAY: i64 = 86_400_000;

    fn reply(status: u16, body: &str) -> Result<Fetched, &'static str> {
        Ok(Fetched {
            status,
            content_type: Some("application/json".into()),
            body: body.as_bytes().to_vec(),
            truncated: false,
        })
    }

    fn created() -> Result<Fetched, &'static str> {
        reply(
            201,
            &format!(
                r#"{{"id":"{ID}","token":"{TOKEN}","expiresAt":{}}}"#,
                NOW + 7 * DAY
            ),
        )
    }

    fn shares() -> (WebShares, Arc<MemoryStore>) {
        let store = Arc::new(MemoryStore::default());
        (
            WebShares::with_host(
                Arc::clone(&store) as Arc<dyn ShareStore>,
                "https://share.test",
            ),
            store,
        )
    }

    /// Opens what was sent with the stored key, as the viewer would.
    fn opened(envelope: &[u8], key: &str) -> serde_json::Value {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        let key = seal::key_from_text(key).unwrap();
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).unwrap();
        let nonce: [u8; 12] = envelope[4..16].try_into().unwrap();
        let plain = cipher
            .decrypt(
                &Nonce::from(nonce),
                aes_gcm::aead::Payload {
                    msg: &envelope[16..],
                    aad: b"DVS1",
                },
            )
            .unwrap();
        serde_json::from_slice(&plain).unwrap()
    }

    #[test]
    fn shares_a_page_sealed_under_a_key_only_the_link_holds() {
        let (shares, store) = shares();
        let sent = Mutex::new(Vec::new());
        let send = |request: &Request| {
            assert_eq!(request.method, Method::Post);
            sent.lock().unwrap().extend_from_slice(request.body);
            created()
        };
        let shared = shares
            .publish(NOTE, "Plans", "<p>Hi</p>", 7, NOW, &send)
            .expect("shared");
        let record = store.get(NOTE).unwrap().expect("kept");
        assert_eq!(
            shared.url,
            format!("https://share.test/s/{ID}#{}", record.key)
        );
        assert_eq!(shared.expires_at, NOW + 7 * DAY);
        let page = opened(&sent.lock().unwrap(), &record.key);
        assert_eq!(
            page,
            serde_json::json!({ "v": 1, "title": "Plans", "html": "<p>Hi</p>" })
        );
        assert!(!String::from_utf8_lossy(&sent.lock().unwrap()).contains("Hi"));
    }

    #[test]
    fn updates_a_live_share_under_the_same_link() {
        let (shares, store) = shares();
        shares
            .publish(NOTE, "A", "one", 7, NOW, &|_| created())
            .unwrap();
        let first = store.get(NOTE).unwrap().unwrap();
        let sent = Mutex::new(Vec::new());
        let send = |request: &Request| {
            assert_eq!(request.method, Method::Put);
            sent.lock().unwrap().extend_from_slice(request.body);
            reply(204, "")
        };
        let shared = shares
            .publish(NOTE, "A", "two", 30, NOW + DAY, &send)
            .unwrap();
        assert_eq!(
            shared.url,
            format!("https://share.test/s/{ID}#{}", first.key)
        );
        assert_eq!(shared.expires_at, first.expires_at);
        assert_eq!(opened(&sent.lock().unwrap(), &first.key)["html"], "two");
    }

    #[test]
    fn shares_anew_when_the_page_was_taken_down_elsewhere() {
        let (shares, store) = shares();
        shares
            .publish(NOTE, "A", "one", 7, NOW, &|_| created())
            .unwrap();
        let first = store.get(NOTE).unwrap().unwrap();
        let calls = AtomicUsize::new(0);
        let send = |request: &Request| {
            calls.fetch_add(1, Ordering::SeqCst);
            match request.method {
                Method::Put => reply(404, r#"{"error":"E_SHARE_NOT_FOUND"}"#),
                _ => created(),
            }
        };
        shares.publish(NOTE, "A", "two", 1, NOW, &send).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_ne!(store.get(NOTE).unwrap().unwrap().key, first.key);
    }

    #[test]
    fn forgets_an_expired_share() {
        let (shares, store) = shares();
        shares
            .publish(NOTE, "A", "one", 7, NOW, &|_| created())
            .unwrap();
        assert!(shares.status(NOTE, NOW + DAY).unwrap().is_some());
        assert_eq!(shares.status(NOTE, NOW + 7 * DAY).unwrap(), None);
        assert_eq!(store.get(NOTE).unwrap(), None);
    }

    #[test]
    fn stops_with_the_token_and_forgets_the_share() {
        let (shares, store) = shares();
        shares
            .publish(NOTE, "A", "one", 7, NOW, &|_| created())
            .unwrap();
        let send = |request: &Request| {
            assert_eq!(request.method, Method::Delete);
            assert!(
                request
                    .headers
                    .contains(&("Authorization", &format!("Bearer {TOKEN}")))
            );
            reply(204, "")
        };
        shares.stop(NOTE, &send).unwrap();
        assert_eq!(store.get(NOTE).unwrap(), None);
        shares.stop(NOTE, &|_| panic!("nothing to stop")).unwrap();
    }

    #[test]
    fn keeps_the_share_when_stopping_fails() {
        let (shares, store) = shares();
        shares
            .publish(NOTE, "A", "one", 7, NOW, &|_| created())
            .unwrap();
        assert_eq!(
            shares.stop(NOTE, &|_| Err("E_NET_FAILED")),
            Err("E_NET_FAILED")
        );
        assert!(store.get(NOTE).unwrap().is_some());
    }

    struct Refusing;
    impl ShareStore for Refusing {
        fn get(&self, _: &str) -> Result<Option<Record>, &'static str> {
            Ok(None)
        }
        fn set(&self, _: &str, _: &Record) -> Result<(), &'static str> {
            Err("E_SHARE_KEYCHAIN_FAILED")
        }
        fn clear(&self, _: &str) -> Result<(), &'static str> {
            Ok(())
        }
    }

    #[test]
    fn takes_the_page_down_when_its_token_cannot_be_kept() {
        let shares = WebShares::with_host(Arc::new(Refusing), "https://share.test");
        let methods = Mutex::new(Vec::new());
        let send = |request: &Request| {
            methods.lock().unwrap().push(request.method);
            if request.method == Method::Post {
                created()
            } else {
                reply(204, "")
            }
        };
        assert_eq!(
            shares.publish(NOTE, "A", "one", 7, NOW, &send).err(),
            Some("E_SHARE_KEYCHAIN_FAILED")
        );
        assert_eq!(*methods.lock().unwrap(), vec![Method::Post, Method::Delete]);
    }

    #[test]
    fn refuses_a_second_call_for_a_note_while_one_runs() {
        let (shares, _) = shares();
        let held = shares.hold(NOTE).unwrap();
        assert_eq!(
            shares
                .publish(NOTE, "A", "one", 7, NOW, &|_| created())
                .err(),
            Some("E_SHARE_BUSY")
        );
        assert_eq!(
            shares.stop(NOTE, &|_| reply(204, "")).err(),
            Some("E_SHARE_BUSY")
        );
        drop(held);
        assert!(
            shares
                .publish(NOTE, "A", "one", 7, NOW, &|_| created())
                .is_ok()
        );
    }

    #[test]
    fn refuses_a_lifetime_the_worker_does_not_offer() {
        let (shares, _) = shares();
        assert_eq!(
            shares
                .publish(NOTE, "A", "one", 3, NOW, &|_| panic!("sent"))
                .err(),
            Some("E_SHARE_LIFETIME_INVALID")
        );
    }
}
