//! Sync as the windows see it: Settings > Sync (the relay's URL, on or off, creating the vault on
//! the first device, the status) and the main window's core worker, whose engine (src/core/sync)
//! connects, pulls and pushes through these commands. Keys, the device token and the socket stay
//! here; plaintext records cross as base64.
//!
//! Pairing a second device (#336) only has to put the vault in the keychain: a device that holds
//! the vault key and no token for the relay enrolls on its own when it connects.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::client::{self, Connection, Event, RelayUrl, Welcome};
use super::settings::{DeviceCredentials, SettingsStore};
use super::{MAX_RECORD_BYTES, SecretStore, Vault};

pub(crate) const CHANGED_EVENT: &str = "devot://sync-changed";
pub(crate) const SOCKET_EVENT: &str = "devot://sync-event";
const MAX_RELAY_SECRET: usize = 1024;
const STATES: [&str; 7] = [
    "off",
    "connecting",
    "syncing",
    "idle",
    "offline",
    "paused",
    "stopped",
];
/// A token marked so stays unused: the device was revoked, and joins again only when the user
/// creates or pairs the vault again.
const REVOKED: &str = "";

#[cfg(target_os = "ios")]
const DEVICE_LABEL: &str = "Devot for iOS";
#[cfg(not(target_os = "ios"))]
const DEVICE_LABEL: &str = "Devot for macOS";

/// What the engine reports, shown in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StatusView {
    pub state: String,
    pub last_sync: Option<i64>,
    pub code: Option<String>,
    #[serde(default)]
    pub too_large: u32,
}

impl Default for StatusView {
    fn default() -> Self {
        Self {
            state: "off".into(),
            last_sync: None,
            code: None,
            too_large: 0,
        }
    }
}

impl StatusView {
    fn checked(self) -> Result<Self, &'static str> {
        let code_ok = self.code.as_deref().is_none_or(crate::logs::is_code);
        let time_ok = self.last_sync.is_none_or(|t| t >= 0);
        if !STATES.contains(&self.state.as_str()) || !code_ok || !time_ok {
            return Err("E_SYNC_STATUS_INVALID");
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub relay_url: String,
    pub enabled: bool,
    /// The keychain holds a vault key.
    pub vault: bool,
    /// This device has a token for the relay set and that vault.
    pub enrolled: bool,
    pub status: StatusView,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsPatch {
    pub relay_url: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PulledDto {
    pub id: String,
    pub version: u64,
    pub seq: u64,
    pub kind: String,
    pub data: Option<String>,
    pub error: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullDto {
    pub records: Vec<PulledDto>,
    pub next: u64,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum PushDto {
    Pushed { version: u64, seq: u64 },
    Rejected { version: u64 },
}

pub(crate) type Emit = Arc<dyn Fn(&'static str, Value) + Send + Sync>;
pub(crate) type Secrets = Arc<dyn SecretStore + Send + Sync>;

struct Live {
    connection: Arc<Connection>,
    vault: Arc<Vault>,
}

pub(crate) struct SyncService {
    settings: SettingsStore,
    secrets: Secrets,
    live: Mutex<Option<Live>>,
    status: Mutex<StatusView>,
    emit: Emit,
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;

impl SyncService {
    pub(crate) fn new(settings: SettingsStore, secrets: Secrets, emit: Emit) -> Self {
        Self {
            settings,
            secrets,
            live: Mutex::new(None),
            status: Mutex::new(StatusView::default()),
            emit,
        }
    }

    fn relay(&self) -> Result<RelayUrl, &'static str> {
        RelayUrl::parse(&self.settings.get().relay_url).map_err(|_| "E_SYNC_NO_RELAY")
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let settings = self.settings.get();
        let vault = Vault::load(self.secrets.as_ref()).ok().flatten();
        let enrolled = vault.as_ref().is_some_and(|vault| {
            DeviceCredentials::load(self.secrets.as_ref())
                .ok()
                .flatten()
                .is_some_and(|c| {
                    c.token != REVOKED && c.fits(&settings.relay_url, &vault.id().to_string())
                })
        });
        Snapshot {
            relay_url: settings.relay_url,
            enabled: settings.enabled,
            vault: vault.is_some(),
            enrolled,
            status: self.status.lock().map(|s| s.clone()).unwrap_or_default(),
        }
    }

    fn changed(&self) -> Snapshot {
        let snapshot = self.snapshot();
        (self.emit)(CHANGED_EVENT, json!(snapshot));
        snapshot
    }

    pub(crate) fn set(&self, patch: SettingsPatch) -> Result<Snapshot, &'static str> {
        let mut settings = self.settings.get();
        if let Some(url) = patch.relay_url {
            let url = if url.trim().is_empty() {
                String::new()
            } else {
                RelayUrl::parse(&url)?.as_str().to_string()
            };
            if url != settings.relay_url {
                self.disconnect();
            }
            settings.relay_url = url;
        }
        if let Some(enabled) = patch.enabled {
            if !enabled {
                self.disconnect();
            }
            settings.enabled = enabled;
        }
        self.settings.set(&settings)?;
        Ok(self.changed())
    }

    /// On the first device: makes the vault key (or takes the one the keychain holds) and creates
    /// the vault on the relay, which asks for its own secret. The secret goes into that one request
    /// and is dropped. A relay that already holds this vault enrolls the device instead.
    pub(crate) fn create_vault(&self, relay_secret: &str) -> Result<Snapshot, &'static str> {
        let relay_secret = Zeroizing::new(relay_secret.trim().to_string());
        if relay_secret.is_empty()
            || relay_secret.len() > MAX_RELAY_SECRET
            || relay_secret.chars().any(char::is_control)
        {
            return Err("E_SYNC_RELAY_SECRET_INVALID");
        }
        let relay = self.relay()?;
        let vault = match Vault::load(self.secrets.as_ref()).map_err(|e| e.code())? {
            Some(vault) => vault,
            None => Vault::create(self.secrets.as_ref()).map_err(|e| e.code())?,
        };
        let enrolled = match client::create_vault(&relay, &relay_secret, &vault, DEVICE_LABEL) {
            Err("E_SYNC_VAULT_EXISTS") => client::enroll(&relay, &vault, DEVICE_LABEL)?,
            other => other?,
        };
        self.keep(&relay, &vault, &enrolled.device, &enrolled.token)?;
        let mut settings = self.settings.get();
        settings.enabled = true;
        self.settings.set(&settings)?;
        log::info!("I_SYNC_VAULT_READY vault={}", vault.id());
        Ok(self.changed())
    }

    fn keep(
        &self,
        relay: &RelayUrl,
        vault: &Vault,
        device: &str,
        token: &str,
    ) -> Result<(), &'static str> {
        DeviceCredentials {
            relay: relay.as_str().to_string(),
            vault: vault.id().to_string(),
            device: device.to_string(),
            token: token.to_string(),
        }
        .save(self.secrets.as_ref())
        .map_err(|e| e.code())
    }

    fn enroll_here(
        &self,
        relay: &RelayUrl,
        vault: &Vault,
    ) -> Result<DeviceCredentials, &'static str> {
        let enrolled = client::enroll(relay, vault, DEVICE_LABEL)?;
        self.keep(relay, vault, &enrolled.device, &enrolled.token)?;
        log::info!(
            "I_SYNC_ENROLLED vault={} device={}",
            vault.id(),
            enrolled.device
        );
        DeviceCredentials::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .ok_or("E_SYNC_NOT_ENROLLED")
    }

    /// What the relay's refusal means for the kept token. A revoked device keeps a marked token and
    /// never enrolls on its own; a relay without the vault (it lost its data) makes the token
    /// useless, so it goes and Settings asks for the relay's secret to create the vault again.
    fn refused(secrets: &dyn SecretStore, code: &str) {
        match code {
            "E_SYNC_REVOKED" | "E_SYNC_UNAUTHORIZED" => {
                if let Ok(Some(mut credentials)) = DeviceCredentials::load(secrets) {
                    credentials.token = REVOKED.to_string();
                    if credentials.save(secrets).is_err() {
                        log::warn!("W_SYNC_REVOKE_KEEP_FAILED");
                    }
                }
            }
            "E_SYNC_NO_VAULT" if DeviceCredentials::forget(secrets).is_err() => {
                log::warn!("W_SYNC_TOKEN_FORGET_FAILED");
            }
            _ => {}
        }
    }

    pub(crate) fn connect(&self) -> Result<Welcome, &'static str> {
        let settings = self.settings.get();
        if !settings.enabled {
            return Err("E_SYNC_OFF");
        }
        let relay = self.relay()?;
        let vault = Vault::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .ok_or("E_SYNC_NO_VAULT_KEY")?;
        let vault_id = vault.id().to_string();
        let credentials =
            match DeviceCredentials::load(self.secrets.as_ref()).map_err(|e| e.code())? {
                Some(c) if c.fits(relay.as_str(), &vault_id) => {
                    if c.token == REVOKED {
                        return Err("E_SYNC_REVOKED");
                    }
                    c
                }
                _ => self.enroll_here(&relay, &vault)?,
            };
        self.disconnect();
        let opened = match self.open(&relay, &vault_id, &credentials.token) {
            // The relay's own secret changed, which makes every token invalid: enroll again.
            Err("E_SYNC_TOKEN_REFUSED") => self
                .enroll_here(&relay, &vault)
                .and_then(|again| self.open(&relay, &vault_id, &again.token)),
            other => other,
        };
        let (connection, welcome) = opened.inspect_err(|code| {
            Self::refused(self.secrets.as_ref(), code);
        })?;
        log::info!(
            "I_SYNC_CONNECTED vault={vault_id} device={}",
            welcome.device
        );
        *self.live.lock().map_err(|_| "E_SYNC_INTERNAL")? = Some(Live {
            connection: Arc::new(connection),
            vault: Arc::new(vault),
        });
        Ok(welcome)
    }

    fn open(
        &self,
        relay: &RelayUrl,
        vault: &str,
        token: &str,
    ) -> Result<(Connection, Welcome), &'static str> {
        let emit = Arc::clone(&self.emit);
        let secrets = Arc::clone(&self.secrets);
        Connection::open(
            relay,
            vault,
            token,
            Box::new(move |event| match event {
                Event::Changed(seq) => emit(SOCKET_EVENT, json!({ "type": "changed", "seq": seq })),
                Event::Closed(code) => {
                    Self::refused(secrets.as_ref(), code);
                    log::info!("I_SYNC_CLOSED {code}");
                    emit(SOCKET_EVENT, json!({ "type": "closed", "code": code }));
                }
            }),
        )
    }

    fn live(&self) -> Result<(Arc<Connection>, Arc<Vault>), &'static str> {
        let live = self.live.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        let live = live.as_ref().ok_or("E_SYNC_OFFLINE")?;
        Ok((Arc::clone(&live.connection), Arc::clone(&live.vault)))
    }

    pub(crate) fn pull(&self, since: u64) -> Result<PullDto, &'static str> {
        let (connection, vault) = self.live()?;
        let page = client::pull(&connection, &vault, since)?;
        Ok(PullDto {
            records: page
                .records
                .into_iter()
                .map(|record| {
                    let (data, error) = match record.plaintext {
                        Ok(bytes) => (Some(STANDARD.encode(bytes.as_slice())), None),
                        Err(code) => {
                            if record.kind == "record" {
                                log::warn!("W_SYNC_RECORD_UNREADABLE {code} id={}", record.id);
                            }
                            (None, Some(code))
                        }
                    };
                    PulledDto {
                        id: record.id,
                        version: record.version,
                        seq: record.seq,
                        kind: record.kind,
                        data,
                        error,
                    }
                })
                .collect(),
            next: page.next,
            more: page.more,
        })
    }

    pub(crate) fn push(&self, id: &str, base: u64, data: &str) -> Result<PushDto, &'static str> {
        if !crate::commands::notes::valid_note_id(id) {
            return Err("E_SYNC_ID_INVALID");
        }
        if base >= MAX_SAFE {
            return Err("E_SYNC_VERSION_INVALID");
        }
        if data.len() > MAX_RECORD_BYTES.div_ceil(3) * 4 {
            return Err("E_SYNC_TOO_LARGE");
        }
        let plaintext = Zeroizing::new(
            STANDARD
                .decode(data.as_bytes())
                .map_err(|_| "E_SYNC_RECORD_INVALID")?,
        );
        if plaintext.is_empty() {
            return Err("E_SYNC_RECORD_INVALID");
        }
        let (connection, vault) = self.live()?;
        match client::push(&connection, &vault, id, base, &plaintext) {
            Ok(client::Pushed::Pushed { version, seq }) => Ok(PushDto::Pushed { version, seq }),
            Ok(client::Pushed::Rejected { version }) => Ok(PushDto::Rejected { version }),
            Err("E_SYNC_TOO_LARGE") => {
                log::warn!("W_SYNC_TOO_LARGE id={id}");
                Err("E_SYNC_TOO_LARGE")
            }
            Err(code) => Err(code),
        }
    }

    pub(crate) fn disconnect(&self) {
        let live = self.live.lock().ok().and_then(|mut live| live.take());
        if let Some(live) = live {
            live.connection.close();
        }
    }

    pub(crate) fn report(&self, status: StatusView) -> Result<(), &'static str> {
        let status = status.checked()?;
        let mut current = self.status.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        if *current == status {
            return Ok(());
        }
        *current = status;
        drop(current);
        self.changed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_status_only_with_a_known_state_and_a_code() {
        let ok = StatusView {
            state: "stopped".into(),
            last_sync: Some(5),
            code: Some("E_SYNC_REVOKED".into()),
            too_large: 1,
        };
        assert!(ok.clone().checked().is_ok());
        for bad in [
            StatusView {
                state: "weird".into(),
                ..ok.clone()
            },
            StatusView {
                code: Some("a note title".into()),
                ..ok.clone()
            },
            StatusView {
                last_sync: Some(-1),
                ..ok.clone()
            },
        ] {
            assert_eq!(bad.checked(), Err("E_SYNC_STATUS_INVALID"));
        }
    }
}
