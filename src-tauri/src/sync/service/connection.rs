use std::sync::Arc;

use serde_json::{Value, json};

use super::super::Vault;
use super::super::client::{self, Connection, Event, RelayUrl, Welcome};
use super::super::cloudkit::{self, ICloud};
use super::super::settings::DeviceCredentials;
use super::{
    Connected, DEVICE_LABEL, Live, LiveRef, PAIRING_EVENT, REVOKED, SOCKET_EVENT, SyncService,
    VAULT_ROTATED,
};

impl SyncService {
    /// `has_synced` is the library's own "has synced" state (`sync_state`), which decides on
    /// iCloud whether a vault zone found gone is a deletion to ask about.
    pub(crate) fn connect(&self, has_synced: bool) -> Result<Connected, &'static str> {
        let _membership = self.membership.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        let settings = self.settings.get();
        if !settings.enabled {
            return Err("E_SYNC_OFF");
        }
        // A device that already syncs stops here, at its next connect.
        self.licence.require()?;
        let vault = Vault::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .ok_or("E_SYNC_NO_VAULT_KEY")?;
        let vault = self.rotation_on_icloud(vault)?;
        let settings = self.settings.get();
        let vault_id = vault.id().to_string();
        if settings.icloud_for(&vault_id).is_some() {
            return self.connect_icloud(vault, has_synced).map(|welcome| {
                Connected::ICloud(cloudkit::Welcome {
                    epoch: settings.engine_epoch(&welcome.epoch),
                    ..welcome
                })
            });
        }
        let relay = self.relay()?;
        let vault = self.resume_rotation(&relay, vault)?;
        let vault_id = vault.id().to_string();
        if self.settings.get().successor_of(&vault_id).is_some() {
            return Err(VAULT_ROTATED);
        }
        // A removed device stays out under any address of the relay: only a join lets it back in.
        let credentials =
            match DeviceCredentials::load(self.secrets.as_ref()).map_err(|e| e.code())? {
                Some(c) if c.vault == vault_id && c.token == REVOKED => {
                    return Err("E_SYNC_REVOKED");
                }
                Some(c) if c.fits(relay.as_str(), &vault_id) => c,
                _ => self.enroll_here(&relay, &vault)?,
            };
        #[cfg(test)]
        self.wait_if_paused();
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
        if let Some(successor) = &welcome.retired {
            connection.close();
            self.found_retired(&vault, successor)?;
            return Err(VAULT_ROTATED);
        }
        log::info!(
            "I_SYNC_CONNECTED vault={vault_id} device={}",
            welcome.device
        );
        *self.live.lock().map_err(|_| "E_SYNC_INTERNAL")? = Some(Live::Relay {
            connection: Arc::new(connection),
            vault: Arc::new(vault),
        });
        Ok(Connected::Relay(Welcome {
            epoch: settings.engine_epoch(&welcome.epoch),
            ..welcome
        }))
    }

    /// A switch or a rotation of an iCloud vault this device left part way, finished or carried on;
    /// the vault to connect with.
    fn rotation_on_icloud(&self, vault: Vault) -> Result<Vault, &'static str> {
        let settings = self.settings.get();
        let rotating = settings
            .rotating
            .as_ref()
            .filter(|r| settings.icloud_for(&r.from).is_some());
        let rotated = settings
            .rotated
            .as_ref()
            .filter(|r| settings.icloud_for(&r.from).is_some());
        let Some(rotation) = rotating.or(rotated) else {
            return Ok(vault);
        };
        if !self.kit.available() {
            return Err(cloudkit::error::UNAVAILABLE);
        }
        let held = vault.id().to_string();
        if held == rotation.to {
            self.finish_icloud_switch(&vault)?;
            return Ok(vault);
        }
        match rotating {
            Some(rotating) if held == rotating.from => {
                match self.resume_icloud_rotation(vault, rotating) {
                    Err(VAULT_ROTATED) => self.held_vault(),
                    other => other,
                }
            }
            _ => Ok(vault),
        }
    }

    /// Connects to the vault on iCloud; a vault `current` names a successor of is followed first,
    /// or refused with `E_SYNC_VAULT_ROTATED` until it can be.
    fn connect_icloud(
        &self,
        vault: Vault,
        has_synced: bool,
    ) -> Result<cloudkit::Welcome, &'static str> {
        let id = vault.id().to_string();
        let vault = if self.settings.get().successor_of(&id).is_some() {
            if !self.kit.available() {
                return Err(cloudkit::error::UNAVAILABLE);
            }
            self.follow_icloud(&vault)?.ok_or(VAULT_ROTATED)?
        } else {
            vault
        };
        match self.connect_icloud_once(vault, has_synced) {
            Err((cloudkit::error::ROTATED, held)) => {
                let next = self.follow_icloud(&held)?.ok_or(VAULT_ROTATED)?;
                self.connect_icloud_once(next, has_synced)
                    .map_err(|(code, _)| code)
            }
            other => other.map_err(|(code, _)| code),
        }
    }

    fn connect_icloud_once(
        &self,
        vault: Vault,
        has_synced: bool,
    ) -> Result<cloudkit::Welcome, (&'static str, Arc<Vault>)> {
        self.disconnect();
        let vault = Arc::new(vault);
        let id = vault.id().to_string();
        let state = self
            .settings
            .get()
            .icloud_for(&id)
            .cloned()
            .ok_or(("E_SYNC_ICLOUD_NOT_USED", Arc::clone(&vault)))?;
        let state = &state;
        let icloud = ICloud::new(
            Arc::clone(&self.kit),
            Arc::clone(&vault),
            Arc::clone(&self.staging),
        );
        let (welcome, kept) = icloud
            .connect(state, has_synced, DEVICE_LABEL, self.now())
            .map_err(|code| {
                log::info!("I_SYNC_ICLOUD_REFUSED {code}");
                if code == cloudkit::error::ACCOUNT_CHANGED {
                    self.forget_handover(&vault);
                }
                (code, Arc::clone(&vault))
            })?;
        let failed = |code| (code, Arc::clone(&vault));
        if kept != *state {
            self.settings
                .update(|settings| {
                    if settings
                        .icloud
                        .as_ref()
                        .is_some_and(|s| s.vault == kept.vault)
                    {
                        settings.icloud = Some(kept);
                    }
                })
                .map_err(failed)?;
        }
        log::info!(
            "I_SYNC_ICLOUD_CONNECTED vault={} device={}",
            state.vault,
            welcome.device
        );
        self.hand_over_at_connect(&vault);
        self.clear_retired();
        *self.live.lock().map_err(|_| failed("E_SYNC_INTERNAL"))? =
            Some(Live::ICloud(Arc::new(icloud)));
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
                Event::Changed(seq) => emit(
                    SOCKET_EVENT,
                    json!({ "type": "changed", "cursor": client::cursor_of(seq) }),
                ),
                Event::Closed(code) => {
                    Self::refused(secrets.as_ref(), code);
                    log::info!("I_SYNC_CLOSED {code}");
                    emit(SOCKET_EVENT, json!({ "type": "closed", "code": code }));
                }
            }),
        )
    }

    pub(super) fn live(&self) -> Result<LiveRef, &'static str> {
        let live = self.live.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        Ok(match live.as_ref().ok_or("E_SYNC_OFFLINE")? {
            Live::Relay { connection, vault } => {
                LiveRef::Relay(Arc::clone(connection), Arc::clone(vault))
            }
            Live::ICloud(icloud) => LiveRef::ICloud(Arc::clone(icloud)),
        })
    }

    pub(super) fn live_relay(&self) -> Result<(Arc<Connection>, Arc<Vault>), &'static str> {
        match self.live()? {
            LiveRef::Relay(connection, vault) => Ok((connection, vault)),
            LiveRef::ICloud(_) => Err("E_SYNC_OFFLINE"),
        }
    }

    pub(crate) fn disconnect(&self) {
        let live = self.live.lock().ok().and_then(|mut live| live.take());
        if let Some(Live::Relay { connection, .. }) = live {
            connection.close();
        }
    }

    /// A silent push said a watched zone changed: the engine pulls, as for a relay's `changed`.
    #[cfg_attr(
        all(not(test), not(any(target_os = "macos", target_os = "ios"))),
        expect(dead_code, reason = "only macOS, iOS and tests use it")
    )]
    pub(crate) fn icloud_changed(&self) {
        if matches!(self.live(), Ok(LiveRef::ICloud(_))) {
            (self.emit)(SOCKET_EVENT, json!({ "type": "changed", "cursor": "" }));
        }
        let hosting = self
            .hosting
            .lock()
            .ok()
            .is_some_and(|hosting| hosting.as_ref().is_some_and(|h| h.icloud));
        if hosting {
            (self.emit)(PAIRING_EVENT, Value::Null);
        }
    }

    /// `CKAccountChanged`: the engine of a vault on iCloud looks at the account again.
    #[cfg_attr(
        all(not(test), not(any(target_os = "macos", target_os = "ios"))),
        expect(dead_code, reason = "only macOS, iOS and tests use it")
    )]
    pub(crate) fn icloud_account_changed(&self) {
        let settings = self.settings.get();
        let on_icloud = Vault::load(self.secrets.as_ref())
            .ok()
            .flatten()
            .is_some_and(|vault| settings.icloud_for(&vault.id().to_string()).is_some());
        if settings.enabled && on_icloud {
            log::info!("I_SYNC_ICLOUD_ACCOUNT_CHANGED");
            self.disconnect();
            (self.emit)(SOCKET_EVENT, json!({ "type": "account" }));
        }
    }
}
