//! The client against the Node relay (relay/src/node/main.ts), started for each test on a free
//! port with its data in a temporary folder: Node 24 and the relay's dependencies (`pnpm install`)
//! must be there, as they are in CI.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use zeroize::Zeroizing;

use super::client::{self, Connection, Event, Pushed, RelayUrl};
use super::service::{SettingsPatch, SyncService};
use super::settings::{DeviceCredentials, SettingsStore};
use super::{SecretStore, SyncError, Vault};
use crate::licence::Gate;

const SECRET: &str = "test-relay-secret-0123456789abcdef";
const RECORD: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789ab";

struct NodeRelay {
    child: Child,
    url: RelayUrl,
    _data: tempfile::TempDir,
}

impl NodeRelay {
    fn start() -> Self {
        Self::spawn(tempfile::tempdir().unwrap(), "0")
    }

    fn spawn(data: tempfile::TempDir, port: &str) -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut child = Command::new("node")
            .arg("relay/src/node/main.ts")
            .current_dir(root)
            .env("RELAY_SECRET", SECRET)
            .env("RELAY_DATA", data.path())
            .env("PORT", port)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("Node 24 must be on PATH to run the relay");
        let stdout = child.stdout.take().unwrap();
        let (found, url) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(url) = line.strip_prefix("I_RELAY_LISTENING ") {
                    let _ = found.send(url.to_string());
                }
            }
        });
        let url = url
            .recv_timeout(Duration::from_secs(30))
            .expect("the relay starts and says where it listens");
        Self {
            child,
            url: RelayUrl::parse(&url).unwrap(),
            _data: data,
        }
    }

    /// The same address with every vault gone, as after the relay lost its data.
    fn restart_empty(self) -> Self {
        let port = self.url.as_str().rsplit(':').next().unwrap().to_string();
        drop(self);
        Self::spawn(tempfile::tempdir().unwrap(), &port)
    }
}

impl Drop for NodeRelay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Secrets(Mutex<std::collections::HashMap<String, Vec<u8>>>);

impl SecretStore for Secrets {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(Zeroizing::new))
    }

    fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError> {
        let mut items = self.0.lock().unwrap();
        if items.contains_key(account) {
            return Ok(false);
        }
        items.insert(account.into(), secret.to_vec());
        Ok(true)
    }

    fn remove(&self, account: &str) -> Result<bool, SyncError> {
        Ok(self.0.lock().unwrap().remove(account).is_some())
    }
}

fn events() -> (Box<dyn Fn(Event) + Send>, mpsc::Receiver<Event>) {
    let (send, receive) = mpsc::channel();
    (
        Box::new(move |event| {
            let _ = send.send(event);
        }),
        receive,
    )
}

fn vault() -> Vault {
    Vault::create(&Secrets::default()).unwrap()
}

#[test]
fn creates_enrolls_pushes_and_pulls_sealed_records() {
    let relay = NodeRelay::start();
    let vault = vault();
    let id = vault.id().to_string();
    assert_eq!(
        client::create_vault(&relay.url, "not the secret", &vault, "mac"),
        Err("E_SYNC_RELAY_SECRET")
    );
    let mac = client::create_vault(&relay.url, SECRET, &vault, "mac").unwrap();
    assert_eq!(
        client::create_vault(&relay.url, SECRET, &vault, "mac"),
        Err("E_SYNC_VAULT_EXISTS")
    );
    let phone = client::enroll(&relay.url, &vault, "phone").unwrap();
    assert_eq!(phone.epoch, mac.epoch);
    assert_ne!(phone.device, mac.device);
    let stranger = Vault::create(&Secrets::default()).unwrap();
    assert_eq!(
        client::enroll(&relay.url, &stranger, "x"),
        Err("E_SYNC_NO_VAULT")
    );

    let (on_mac, _) = events();
    let (mac_socket, welcome) = Connection::open(&relay.url, &id, &mac.token, on_mac).unwrap();
    assert_eq!(
        (welcome.epoch.as_str(), welcome.seq),
        (mac.epoch.as_str(), 0)
    );
    assert!((welcome.time - mac.time).abs() < 60_000);
    let (on_phone, phone_events) = events();
    let (phone_socket, _) = Connection::open(&relay.url, &id, &phone.token, on_phone).unwrap();

    let first = b"a note's record, sealed before it leaves".to_vec();
    assert_eq!(
        client::push(&mac_socket, &vault, RECORD, 0, &first),
        Ok(Pushed::Pushed { version: 1, seq: 1 })
    );
    assert_eq!(
        phone_events.recv_timeout(Duration::from_secs(10)),
        Ok(Event::Changed(1))
    );
    assert_eq!(
        client::push(&phone_socket, &vault, RECORD, 0, b"based on nothing"),
        Ok(Pushed::Rejected { version: 1 })
    );
    let page = client::pull(&phone_socket, &vault, 0).unwrap();
    assert_eq!((page.next, page.more, page.records.len()), (1, false, 1));
    let pulled = &page.records[0];
    assert_eq!(
        (pulled.id.as_str(), pulled.version, pulled.kind.as_str()),
        (RECORD, 1, "record")
    );
    assert_eq!(
        pulled.plaintext.as_deref().map(|p| p.as_slice()),
        Ok(&first[..])
    );

    // A device with another key cannot read it.
    let page = client::pull(&phone_socket, &stranger, 0).unwrap();
    assert_eq!(
        page.records[0].plaintext.as_ref().err(),
        Some(&"E_SYNC_CHUNK_AUTH")
    );
    mac_socket.close();
    phone_socket.close();
}

#[test]
fn keeps_a_record_past_the_chunk_cap_here() {
    let relay = NodeRelay::start();
    let vault = vault();
    let mac = client::create_vault(&relay.url, SECRET, &vault, "mac").unwrap();
    let (on_event, _) = events();
    let (socket, _) =
        Connection::open(&relay.url, &vault.id().to_string(), &mac.token, on_event).unwrap();
    let big = vec![0; 17 * super::MAX_CHUNK_BYTES];
    assert_eq!(
        client::push(&socket, &vault, RECORD, 0, &big),
        Err("E_SYNC_TOO_LARGE")
    );
    assert_eq!(client::pull(&socket, &vault, 0).unwrap().records.len(), 0);
}

#[test]
fn says_when_the_device_is_revoked_or_unknown() {
    let relay = NodeRelay::start();
    let vault = vault();
    let id = vault.id().to_string();
    let mac = client::create_vault(&relay.url, SECRET, &vault, "mac").unwrap();
    let phone = client::enroll(&relay.url, &vault, "phone").unwrap();
    let (on_mac, _) = events();
    let (mac_socket, _) = Connection::open(&relay.url, &id, &mac.token, on_mac).unwrap();
    let (on_phone, phone_events) = events();
    let (_phone_socket, _) = Connection::open(&relay.url, &id, &phone.token, on_phone).unwrap();
    let answer = client::send_raw(
        &mac_socket,
        json!({ "type": "revoke", "device": phone.device }),
    )
    .unwrap();
    assert_eq!(answer.message["type"], "revoked");
    assert_eq!(
        phone_events.recv_timeout(Duration::from_secs(10)),
        Ok(Event::Closed("E_SYNC_REVOKED"))
    );
    let (again, _) = events();
    assert_eq!(
        Connection::open(&relay.url, &id, &phone.token, again).err(),
        Some("E_SYNC_UNAUTHORIZED")
    );
    let (forged, _) = events();
    assert_eq!(
        Connection::open(&relay.url, &id, "forged.token.value", forged).err(),
        Some("E_SYNC_TOKEN_REFUSED")
    );
}

#[test]
fn the_service_creates_the_vault_once_and_connects_with_the_kept_token() {
    let relay = NodeRelay::start();
    let dir = tempfile::tempdir().unwrap();
    let secrets: Arc<Secrets> = Arc::default();
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::clone(&emitted);
    let service = SyncService::new(
        SettingsStore::new(&dir.path().join(super::settings::FILE)),
        secrets.clone(),
        Arc::new(move |event, _| sent.lock().unwrap().push(event)),
        Gate::open(),
    );
    assert_eq!(service.connect().err(), Some("E_SYNC_OFF"));
    service
        .set(SettingsPatch {
            relay_url: Some(format!("{}/", relay.url.as_str())),
            enabled: None,
        })
        .unwrap();
    assert_eq!(service.snapshot().relay_url, relay.url.as_str());
    assert_eq!(
        service.create_vault("wrong").err(),
        Some("E_SYNC_RELAY_SECRET")
    );
    let ready = service.create_vault(SECRET).unwrap();
    assert!(ready.vault && ready.enrolled && ready.enabled);
    let stored = std::fs::read_to_string(dir.path().join(super::settings::FILE)).unwrap();
    assert!(
        !stored.contains(SECRET) && !stored.contains("token"),
        "{stored}"
    );
    let welcome = service.connect().unwrap();
    let data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"record");
    assert!(matches!(
        service.push(RECORD, 0, &data),
        Ok(super::service::PushDto::Pushed { version: 1, .. })
    ));
    let page = service.pull(welcome.seq).unwrap();
    assert_eq!(page.records[0].data.as_deref(), Some(data.as_str()));
    // A device that lost its token but holds the key enrolls again on its own.
    secrets.remove("device").unwrap();
    service.disconnect();
    assert!(service.connect().is_ok());
    // A new relay secret's tokens: creating again with the same key enrolls on the vault there.
    let again = service.create_vault(SECRET).unwrap();
    assert!(again.enrolled);
    assert!(
        emitted
            .lock()
            .unwrap()
            .contains(&super::service::CHANGED_EVENT)
    );
    service.disconnect();
}

fn service_on(relay: &NodeRelay, dir: &Path, secrets: Arc<Secrets>) -> SyncService {
    service_with(relay, dir, secrets, Gate::open())
}

fn service_with(
    relay: &NodeRelay,
    dir: &Path,
    secrets: Arc<Secrets>,
    licence: Gate,
) -> SyncService {
    let service = SyncService::new(
        SettingsStore::new(&dir.join(super::settings::FILE)),
        secrets,
        Arc::new(|_, _| ()),
        licence,
    );
    service
        .set(SettingsPatch {
            relay_url: Some(relay.url.as_str().to_string()),
            enabled: Some(true),
        })
        .unwrap();
    service
}

#[test]
fn a_gated_build_creates_no_vault_and_connects_no_device_without_a_licence() {
    use crate::licence::testing;
    let relay = NodeRelay::start();
    let dir = tempfile::tempdir().unwrap();
    let licence = testing::licence(dir.path(), true);
    let secrets: Arc<Secrets> = Arc::default();
    let service = service_with(&relay, dir.path(), secrets.clone(), Gate::of(&licence));
    assert_eq!(
        service.create_vault(SECRET).err(),
        Some("E_LICENCE_REQUIRED")
    );
    assert!(secrets.0.lock().unwrap().is_empty());
    licence.set(&testing::key(testing::ID)).unwrap();
    assert!(service.create_vault(SECRET).unwrap().enrolled);
    assert!(service.connect().is_ok());
    // A device that already syncs stops at its next connect.
    licence.remove().unwrap();
    assert_eq!(service.connect().err(), Some("E_LICENCE_REQUIRED"));
    service.disconnect();
}

fn device_count(socket: &Connection) -> usize {
    let answer = client::send_raw(socket, json!({ "type": "devices" })).unwrap();
    answer.message["devices"].as_array().unwrap().len()
}

#[test]
fn a_revoked_device_stays_out_until_the_user_joins_again() {
    let relay = NodeRelay::start();
    let dir = tempfile::tempdir().unwrap();
    let secrets: Arc<Secrets> = Arc::default();
    let service = service_on(&relay, dir.path(), secrets.clone());
    service.create_vault(SECRET).unwrap();
    let welcome = service.connect().unwrap();
    let vault = Vault::load(secrets.as_ref()).unwrap().unwrap();
    let id = vault.id().to_string();
    let phone = client::enroll(&relay.url, &vault, "phone").unwrap();
    let (on_phone, _) = events();
    let (phone_socket, _) = Connection::open(&relay.url, &id, &phone.token, on_phone).unwrap();
    let answer = client::send_raw(
        &phone_socket,
        json!({ "type": "revoke", "device": welcome.device }),
    )
    .unwrap();
    assert_eq!(answer.message["type"], "revoked");

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while service.snapshot().enrolled {
        assert!(
            std::time::Instant::now() < deadline,
            "the close marks the device revoked"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let snapshot = service.snapshot();
    assert!(snapshot.vault && !snapshot.enrolled);
    let devices = device_count(&phone_socket);
    assert_eq!(service.connect().err(), Some("E_SYNC_REVOKED"));
    assert_eq!(service.connect().err(), Some("E_SYNC_REVOKED"));
    assert_eq!(
        device_count(&phone_socket),
        devices,
        "no enrollment on its own"
    );

    assert!(service.create_vault(SECRET).unwrap().enrolled);
    assert!(service.connect().is_ok());
    assert_eq!(device_count(&phone_socket), devices + 1);
    service.disconnect();
}

#[test]
fn a_refused_token_enrolls_once_and_connects() {
    let relay = NodeRelay::start();
    let dir = tempfile::tempdir().unwrap();
    let secrets: Arc<Secrets> = Arc::default();
    let service = service_on(&relay, dir.path(), secrets.clone());
    service.create_vault(SECRET).unwrap();
    let vault = Vault::load(secrets.as_ref()).unwrap().unwrap();
    let id = vault.id().to_string();
    let phone = client::enroll(&relay.url, &vault, "phone").unwrap();
    let (on_phone, _) = events();
    let (phone_socket, _) = Connection::open(&relay.url, &id, &phone.token, on_phone).unwrap();
    let devices = device_count(&phone_socket);

    let mut kept = DeviceCredentials::load(secrets.as_ref()).unwrap().unwrap();
    kept.token = "forged.token.value".into();
    kept.save(secrets.as_ref()).unwrap();
    assert!(service.connect().is_ok());
    let token = DeviceCredentials::load(secrets.as_ref())
        .unwrap()
        .unwrap()
        .token;
    assert_ne!(token, "forged.token.value");
    assert_eq!(device_count(&phone_socket), devices + 1);
    service.disconnect();
    assert!(service.connect().is_ok());
    assert_eq!(
        device_count(&phone_socket),
        devices + 1,
        "the new token is kept"
    );
    service.disconnect();
}

#[test]
fn a_relay_that_lost_the_vault_asks_for_its_secret_and_gets_a_new_epoch() {
    let relay = NodeRelay::start();
    let dir = tempfile::tempdir().unwrap();
    let secrets: Arc<Secrets> = Arc::default();
    let service = service_on(&relay, dir.path(), secrets.clone());
    service.create_vault(SECRET).unwrap();
    let before = service.connect().unwrap();
    service.disconnect();

    let relay = relay.restart_empty();
    assert_eq!(service.snapshot().relay_url, relay.url.as_str());
    assert_eq!(service.connect().err(), Some("E_SYNC_NO_VAULT"));
    let snapshot = service.snapshot();
    assert!(
        snapshot.vault && !snapshot.enrolled,
        "Settings asks for the secret"
    );
    assert_eq!(service.connect().err(), Some("E_SYNC_NO_VAULT"));

    assert!(service.create_vault(SECRET).unwrap().enrolled);
    let after = service.connect().unwrap();
    assert_ne!(after.epoch, before.epoch);
    service.disconnect();
}
