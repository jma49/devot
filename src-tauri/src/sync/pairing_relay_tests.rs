//! Pairing, joining and removing devices against the Node relay (docs/adr/0008-sync-device-pairing.md),
//! some through a proxy that plays a relay which reads, swaps, replays or forges messages.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use super::Vault;
use super::client::{self, Connection};
use super::pairing::{Pairing, TTL_MS};
use super::relay_tests::{NodeRelay, RECORD, SECRET, Secrets};
use super::service::{PushDto, SettingsPatch, SyncService};
use super::settings::{DeviceCredentials, FILE, SettingsStore};
use super::tests::to_hex;
use crate::licence::Gate;

type Tamper = Box<dyn Fn(&str, u16, Value) -> (u16, Value) + Send>;

/// An HTTP relay in front of the real one: it forwards every request, keeps what passed, and may
/// change an answer on its way back.
struct Proxy {
    url: String,
    seen: Arc<Mutex<Vec<(String, String, String)>>>,
    tamper: Arc<Mutex<Option<Tamper>>>,
    stop: Arc<AtomicBool>,
}

impl Proxy {
    fn start(upstream: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let proxy = Self {
            url,
            seen: Arc::default(),
            tamper: Arc::default(),
            stop: Arc::default(),
        };
        let (seen, tamper, stop) = (
            Arc::clone(&proxy.seen),
            Arc::clone(&proxy.tamper),
            Arc::clone(&proxy.stop),
        );
        let upstream = upstream.to_string();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if let Ok(stream) = stream {
                    forward(stream, &upstream, &seen, &tamper);
                }
            }
        });
        proxy
    }

    fn tamper(&self, change: impl Fn(&str, u16, Value) -> (u16, Value) + Send + 'static) {
        *self.tamper.lock().unwrap() = Some(Box::new(change));
    }

    fn honest(&self) {
        *self.tamper.lock().unwrap() = None;
    }

    /// Everything that passed, request and answer, as text.
    fn everything(&self) -> String {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|(path, request, answer)| format!("{path}\n{request}\n{answer}\n"))
            .collect()
    }

    /// The offer of the last pairing a device opened, as the relay got it.
    fn last_offer(&self) -> String {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find_map(|(_, request, _)| {
                let body: Value = serde_json::from_str(request).ok()?;
                (body["type"] == "pair").then(|| body["offer"].as_str().unwrap().to_string())
            })
            .unwrap()
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.url.trim_start_matches("http://"));
    }
}

fn forward(
    stream: TcpStream,
    upstream: &str,
    seen: &Mutex<Vec<(String, String, String)>>,
    tamper: &Mutex<Option<Tamper>>,
) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let (mut length, mut authorization) = (0, None);
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').unwrap();
        match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().unwrap(),
            "authorization" => authorization = Some(value.trim().to_string()),
            _ => {}
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut call = agent
        .post(format!("{upstream}{path}"))
        .header("Content-Type", "application/json");
    if let Some(value) = &authorization {
        call = call.header("Authorization", value);
    }
    let mut response = call.send(&body[..]).unwrap();
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap();
    let request = String::from_utf8_lossy(&body).into_owned();
    seen.lock()
        .unwrap()
        .push((path.clone(), request, text.clone()));
    let value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let (status, value) = match tamper.lock().unwrap().as_ref() {
        Some(change) => change(&path, status, value),
        None => (status, value),
    };
    let answer = value.to_string();
    let mut stream = stream;
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
        answer.len()
    );
}

struct Device {
    service: SyncService,
    secrets: Arc<Secrets>,
    _dir: tempfile::TempDir,
}

impl Device {
    fn at(relay: &str) -> Self {
        Self::licensed(relay, Gate::open())
    }

    fn licensed(relay: &str, licence: Gate) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let secrets: Arc<Secrets> = Arc::default();
        let service = SyncService::new(
            SettingsStore::new(&dir.path().join(FILE)),
            secrets.clone(),
            Arc::new(|_, _| ()),
            licence,
        );
        service
            .set(SettingsPatch {
                relay_url: Some(relay.to_string()),
                enabled: None,
            })
            .unwrap();
        Self {
            service,
            secrets,
            _dir: dir,
        }
    }

    /// A device that turned sync on: it made the vault and is enrolled.
    fn first(relay: &str) -> Self {
        let device = Self::at(relay);
        device.service.create_vault(SECRET).unwrap();
        device
    }

    fn holds_nothing(&self) -> bool {
        self.secrets.0.lock().unwrap().is_empty()
    }

    fn device_id(&self) -> String {
        DeviceCredentials::load(self.secrets.as_ref())
            .unwrap()
            .unwrap()
            .device
    }

    fn vault(&self) -> Vault {
        Vault::load(self.secrets.as_ref()).unwrap().unwrap()
    }
}

fn record_data() -> String {
    STANDARD.encode(b"a note's record")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[test]
fn pairs_a_new_device_by_code_and_both_read_the_same_records() {
    let relay = NodeRelay::start();
    let url = relay.url.as_str();
    let mac = Device::first(url);
    mac.service.connect().unwrap();
    assert!(matches!(
        mac.service.push(RECORD, 0, &record_data()),
        Ok(PushDto::Pushed { version: 1, .. })
    ));

    let shown = mac.service.pairing_open().unwrap();
    assert_eq!(shown.code.len(), 39);
    assert!(shown.link.starts_with("devot://pair?relay="));
    assert_eq!(shown.qr.modules.len(), shown.qr.size * shown.qr.size);
    assert!((shown.expires - now() - TTL_MS).abs() < 60_000);
    assert_eq!(mac.service.pairing_check().unwrap().state, "waiting");

    let phone = Device::at(url);
    let joined = phone.service.join_with_code(&shown.code).unwrap();
    assert!(joined.vault && joined.enrolled && joined.enabled);
    assert_eq!(phone.vault().id(), mac.vault().id());
    let check = mac.service.pairing_check().unwrap();
    assert_eq!(check.state, "paired");
    assert_eq!(check.device, Some(phone.device_id()));
    assert_eq!(
        mac.service.pairing_check().err(),
        Some("E_SYNC_PAIRING_NONE")
    );

    phone.service.connect().unwrap();
    let page = phone.service.pull(0).unwrap();
    assert_eq!(
        page.records[0].data.as_deref(),
        Some(record_data().as_str())
    );
    let devices = mac.service.devices().unwrap();
    assert_eq!(devices.len(), 2);
    assert!(
        devices
            .iter()
            .any(|d| d.id == phone.device_id() && !d.current && d.label == "Devot for macOS")
    );
    assert!(devices.iter().any(|d| d.id == mac.device_id() && d.current));

    // The QR code's link brings the relay to a device that has none set.
    let tablet = Device::at("");
    let link = mac.service.pairing_open().unwrap().link;
    tablet.service.join_with_code(&link).unwrap();
    assert_eq!(tablet.service.snapshot().relay_url, url);
    assert_eq!(phone.service.devices().unwrap().len(), 3);
    mac.service.disconnect();
    phone.service.disconnect();
}

#[test]
fn a_used_cancelled_replaced_or_expired_code_fails() {
    let relay = NodeRelay::start();
    let url = relay.url.as_str();
    let mac = Device::first(url);
    let late = Device::at(url);

    let used = mac.service.pairing_open().unwrap();
    Device::at(url).service.join_with_code(&used.code).unwrap();
    assert_eq!(
        late.service.join_with_code(&used.code).err(),
        Some("E_SYNC_PAIRING_GONE")
    );

    let cancelled = mac.service.pairing_open().unwrap();
    mac.service.pairing_cancel();
    assert_eq!(
        late.service.join_with_code(&cancelled.code).err(),
        Some("E_SYNC_PAIRING_GONE")
    );

    let replaced = mac.service.pairing_open().unwrap();
    let current = mac.service.pairing_open().unwrap();
    assert_eq!(
        late.service.join_with_code(&replaced.code).err(),
        Some("E_SYNC_PAIRING_GONE")
    );

    mac.service.shift_clock(TTL_MS + 1);
    assert_eq!(mac.service.pairing_check().unwrap().state, "expired");
    assert_eq!(
        late.service.join_with_code(&current.code).err(),
        Some("E_SYNC_PAIRING_GONE")
    );
    assert!(late.holds_nothing());
    assert!(!late.service.snapshot().enabled);

    assert_eq!(
        late.service.join_with_code("0400-0000").err(),
        Some("E_SYNC_PAIRING_CODE")
    );
    let other = Device::at("https://other.example.com");
    let link = mac.service.pairing_open().unwrap().link;
    assert_eq!(
        other.service.join_with_code(&link).err(),
        Some("E_SYNC_PAIRING_RELAY")
    );
    // A device already in a vault does not join another.
    let elsewhere = Device::first(url);
    let code = mac.service.pairing_open().unwrap().code;
    assert_eq!(
        elsewhere.service.join_with_code(&code).err(),
        Some("E_SYNC_VAULT_EXISTS")
    );
}

#[test]
fn a_relay_that_reads_swaps_replays_or_forges_learns_no_key_and_gets_no_device_in() {
    let relay = NodeRelay::start();
    let proxy = Proxy::start(relay.url.as_str());
    let mac = Device::first(&proxy.url);
    let vault = mac.vault();

    let shown = mac.service.pairing_open().unwrap();
    let phone = Device::at(&proxy.url);
    phone.service.join_with_code(&shown.code).unwrap();
    assert_eq!(mac.service.pairing_check().unwrap().state, "paired");
    let mut legitimate = 2;

    // What passed through the relay holds the key in no form, nor the code.
    let seen = proxy.everything();
    for secret in [
        to_hex(vault.key()),
        STANDARD.encode(vault.key()),
        URL_SAFE_NO_PAD.encode(vault.key()),
        vault.recovery_key().replace('-', ""),
        shown.code.replace('-', ""),
        shown.code.clone(),
    ] {
        assert!(!seen.contains(&secret), "the relay saw a secret");
    }
    let offer = URL_SAFE_NO_PAD.decode(proxy.last_offer()).unwrap();
    assert!(!offer.windows(32).any(|w| w == vault.key()));
    // The enrollment secret goes only where it always went: enrollment.
    let enrollment = URL_SAFE_NO_PAD.encode(vault.enrollment_secret().as_ref());
    for (path, request, answer) in proxy.seen.lock().unwrap().iter() {
        if path.starts_with("/v1/pairings/") {
            assert!(!request.contains(&enrollment) && !answer.contains(&enrollment));
        }
    }

    // A substitute: the relay's own vault, sealed under a code of its own.
    let theirs = Vault::generate().unwrap();
    let substitute = URL_SAFE_NO_PAD.encode(
        Pairing::generate()
            .unwrap()
            .seal_offer(&theirs, now() + TTL_MS)
            .unwrap(),
    );
    let take = |offer: String| {
        move |path: &str, status: u16, body: Value| {
            if path.ends_with("/take") {
                (200, json!({ "v": 1, "type": "offer", "offer": offer }))
            } else {
                (status, body)
            }
        }
    };
    proxy.tamper(take(substitute));
    let victim = Device::at(&proxy.url);
    let code = mac.service.pairing_open().unwrap().code;
    assert_eq!(
        victim.service.join_with_code(&code).err(),
        Some("E_SYNC_PAIRING_AUTH")
    );

    // Another pairing's real offer.
    proxy.honest();
    mac.service.pairing_open().unwrap();
    let earlier = proxy.last_offer();
    let code = mac.service.pairing_open().unwrap().code;
    proxy.tamper(take(earlier));
    assert_eq!(
        victim.service.join_with_code(&code).err(),
        Some("E_SYNC_PAIRING_AUTH")
    );
    assert!(victim.holds_nothing());
    assert!(!victim.service.snapshot().enabled);

    // A taken offer the relay kept and replays once the code has expired.
    proxy.honest();
    let code = mac.service.pairing_open().unwrap().code;
    let kept = proxy.last_offer();
    Device::at(&proxy.url)
        .service
        .join_with_code(&code)
        .unwrap();
    legitimate += 1;
    proxy.tamper(take(kept));
    let thief = Device::at(&proxy.url);
    thief.service.shift_clock(TTL_MS + 5 * 60_000 + 1_000);
    assert_eq!(
        thief.service.join_with_code(&code).err(),
        Some("E_SYNC_PAIRING_EXPIRED")
    );
    assert!(thief.holds_nothing());

    // Forged confirmations never make the device that shows the code report a pairing.
    for forged in [
        None,
        Some(
            Pairing::generate()
                .unwrap()
                .seal_confirmation("relaydevice")
                .unwrap(),
        ),
        Some(vec![1; 40]),
    ] {
        proxy.honest();
        mac.service.pairing_open().unwrap();
        let proof = forged.unwrap_or_else(|| URL_SAFE_NO_PAD.decode(proxy.last_offer()).unwrap());
        let proof = URL_SAFE_NO_PAD.encode(proof);
        proxy.tamper(move |path, status, body| {
            if path.ends_with("/status") {
                let state = json!({ "v": 1, "type": "pairing", "state": "confirmed", "expires": 0, "time": 0, "proof": proof });
                (200, state)
            } else {
                (status, body)
            }
        });
        assert_eq!(
            mac.service.pairing_check().err(),
            Some("E_SYNC_PAIRING_AUTH")
        );
        assert_eq!(
            mac.service.pairing_check().err(),
            Some("E_SYNC_PAIRING_NONE")
        );
    }
    // The proxy speaks HTTP only: the device list goes to the relay itself.
    let credentials = DeviceCredentials::load(mac.secrets.as_ref())
        .unwrap()
        .unwrap();
    let (socket, _) = Connection::open(
        &relay.url,
        &credentials.vault,
        &credentials.token,
        Box::new(|_| {}),
    )
    .unwrap();
    assert_eq!(client::devices(&socket).unwrap().len(), legitimate);
}

#[test]
fn the_recovery_key_restores_access_on_a_fresh_device() {
    let relay = NodeRelay::start();
    let url = relay.url.as_str();
    let mac = Device::at(url);
    assert_eq!(
        mac.service.create_vault("wrong").err(),
        Some("E_SYNC_RELAY_SECRET")
    );
    let created = mac.service.create_vault(SECRET).unwrap();
    let key = created
        .recovery_key
        .clone()
        .expect("shown the first time it is ready");
    assert!(!format!("{created:?}").contains(&key[..10]));
    assert!(
        mac.service
            .create_vault(SECRET)
            .unwrap()
            .recovery_key
            .is_none()
    );
    mac.service.connect().unwrap();
    mac.service.push(RECORD, 0, &record_data()).unwrap();
    mac.service.disconnect();

    let fresh = Device::at(url);
    assert_eq!(
        fresh.service.join_with_recovery("not a key").err(),
        Some("E_SYNC_RECOVERY_FORMAT")
    );
    let typo = key.replacen(&key[3..4], if &key[3..4] == "A" { "B" } else { "A" }, 1);
    assert_eq!(
        fresh.service.join_with_recovery(&typo).err(),
        Some("E_SYNC_RECOVERY_CHECKSUM")
    );
    assert!(fresh.holds_nothing());
    let joined = fresh
        .service
        .join_with_recovery(&key.to_lowercase())
        .unwrap();
    assert!(joined.vault && joined.enrolled && joined.enabled);
    fresh.service.connect().unwrap();
    let page = fresh.service.pull(0).unwrap();
    assert_eq!(
        page.records[0].data.as_deref(),
        Some(record_data().as_str())
    );
    let devices = fresh.service.devices().unwrap().len();
    fresh.service.join_with_recovery(&key).unwrap();
    assert_eq!(
        fresh.service.devices().unwrap().len(),
        devices,
        "no second enrollment"
    );
    fresh.service.disconnect();
    assert!(
        fresh
            .service
            .create_vault(SECRET)
            .unwrap()
            .recovery_key
            .is_none()
    );

    let elsewhere = Device::first(url);
    assert_eq!(
        elsewhere.service.join_with_recovery(&key).err(),
        Some("E_SYNC_VAULT_EXISTS")
    );
    assert_eq!(
        Device::at("").service.join_with_recovery(&key).err(),
        Some("E_SYNC_NO_RELAY")
    );
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_removed_device_can_no_longer_push_or_pull_until_it_is_let_back_in() {
    let relay = NodeRelay::start();
    let url = relay.url.as_str();
    let mac = Device::first(url);
    let phone = Device::at(url);
    phone
        .service
        .join_with_code(&mac.service.pairing_open().unwrap().code)
        .unwrap();
    mac.service.connect().unwrap();
    phone.service.connect().unwrap();

    assert_eq!(
        mac.service.remove_device(&mac.device_id()).err(),
        Some("E_SYNC_DEVICE_SELF")
    );
    assert_eq!(
        mac.service.remove_device("not/a device").err(),
        Some("E_SYNC_DEVICE_INVALID")
    );
    let removed = phone.device_id();
    let left = mac.service.remove_device(&removed).unwrap();
    assert!(left.iter().all(|d| d.id != removed));
    wait_until("the close marks the phone removed", || {
        !phone.service.snapshot().enrolled
    });
    assert!(phone.service.push(RECORD, 0, &record_data()).is_err());
    assert!(phone.service.pull(0).is_err());
    assert_eq!(phone.service.connect().err(), Some("E_SYNC_REVOKED"));
    assert_eq!(phone.service.devices().err(), Some("E_SYNC_REVOKED"));

    let code = mac.service.pairing_open().unwrap().code;
    phone.service.join_with_code(&code).unwrap();
    assert!(phone.service.connect().is_ok());
    assert_eq!(mac.service.devices().unwrap().len(), 2);
    mac.service.disconnect();
    phone.service.disconnect();
}

#[test]
fn an_older_relay_is_reported_as_outdated_and_nothing_changes() {
    let relay = NodeRelay::start();
    let proxy = Proxy::start(relay.url.as_str());
    // What a relay from before pairing answers on a route it does not have (relay/src/front.ts).
    proxy.tamper(|path, status, body| {
        if path.starts_with("/v1/pairings/") {
            let missing = json!({ "v": 1, "type": "error", "code": "E_SYNC_NOT_FOUND" });
            (404, missing)
        } else {
            (status, body)
        }
    });
    let mac = Device::at(&proxy.url);
    let key = mac
        .service
        .create_vault(SECRET)
        .unwrap()
        .recovery_key
        .unwrap();
    assert_eq!(
        mac.service.pairing_open().err(),
        Some("E_SYNC_RELAY_OUTDATED")
    );
    assert!(mac.service.snapshot().enrolled);

    let phone = Device::at(&proxy.url);
    let code = Pairing::generate().unwrap().code();
    assert_eq!(
        phone.service.join_with_code(&code).err(),
        Some("E_SYNC_RELAY_OUTDATED")
    );
    assert!(phone.holds_nothing());
    assert!(!phone.service.snapshot().enabled);
    assert!(phone.service.join_with_recovery(&key).unwrap().enrolled);
}

#[test]
fn a_gated_build_pairs_and_joins_only_with_a_licence_but_always_lists_devices() {
    use crate::licence::testing;
    let relay = NodeRelay::start();
    let url = relay.url.as_str();
    let dir = tempfile::tempdir().unwrap();
    let licence = testing::licence(dir.path(), true);
    licence.set(&testing::key(testing::ID)).unwrap();
    let mac = Device::licensed(url, Gate::of(&licence));
    let key = mac
        .service
        .create_vault(SECRET)
        .unwrap()
        .recovery_key
        .unwrap();
    let code = mac.service.pairing_open().unwrap().code;
    licence.remove().unwrap();

    assert_eq!(mac.service.pairing_open().err(), Some("E_LICENCE_REQUIRED"));
    assert_eq!(mac.service.devices().unwrap().len(), 1);
    let phone = Device::licensed(url, Gate::of(&licence));
    assert_eq!(
        phone.service.join_with_code(&code).err(),
        Some("E_LICENCE_REQUIRED")
    );
    assert_eq!(
        phone.service.join_with_recovery(&key).err(),
        Some("E_LICENCE_REQUIRED")
    );
    assert!(phone.holds_nothing());
    // The code was never taken.
    Device::at(url).service.join_with_code(&code).unwrap();
}

#[test]
fn settings_keep_no_secret_and_name_the_vault_whose_key_was_shown() {
    let relay = NodeRelay::start();
    let mac = Device::first(relay.url.as_str());
    let stored = std::fs::read_to_string(mac._dir.path().join(FILE)).unwrap();
    assert!(stored.contains(&mac.vault().id().to_string()));
    assert!(!stored.contains(&mac.vault().recovery_key().replace('-', "")[..20]));
}
