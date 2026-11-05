//! Rotating a relay vault's key (docs/adr/0017-sync-key-rotation.md): the device makes a new vault,
//! the successor, on the same relay, retires the old one for it and switches. Every step is kept
//! before the next, so a rotation that stops part way is finished or dropped at the next connect,
//! and the old vault stays as it was until the relay retires it.

use super::super::client::{self, Connection, Enrollment, RelayUrl, Retire, Welcome};
use super::super::settings::{DeviceCredentials, Rotation};
use super::super::{SecretStore, Vault};
use super::{Created, DEVICE_LABEL, SyncService, checked_relay_secret};

pub(super) const VAULT_ROTATED: &str = "E_SYNC_VAULT_ROTATED";
const ROTATION_ICLOUD: &str = "E_SYNC_ROTATION_ICLOUD";

impl SyncService {
    /// Rotates the vault's key: makes the successor with the relay's secret, which is used for that
    /// one request and dropped, retires the vault this device holds and switches to the successor.
    /// Not gated by the licence: taking access away never is. The new recovery key comes back to
    /// show until it is saved.
    pub(crate) fn rotate_vault(&self, relay_secret: &str) -> Result<Created, &'static str> {
        let relay_secret = checked_relay_secret(relay_secret)?;
        if self.on_icloud() {
            return Err(ROTATION_ICLOUD);
        }
        let relay = self.relay()?;
        let vault = self.held_vault()?;
        let credentials = self.credentials(&relay, &vault)?;
        if self
            .settings
            .get()
            .successor_of(&vault.id().to_string())
            .is_some()
        {
            return Err(VAULT_ROTATED);
        }
        self.disconnect();
        let (connection, welcome) = Connection::open(
            &relay,
            &vault.id().to_string(),
            &credentials.token,
            Box::new(|_| {}),
        )
        .inspect_err(|code| Self::refused(self.secrets.as_ref(), code))?;
        let rotated = self.rotate_on(&relay, &relay_secret, &vault, &connection, &welcome);
        connection.close();
        rotated?;
        Ok(Created {
            snapshot: self.changed(),
            recovery_key: self.recovery_key()?.map(|key| key.to_string()),
        })
    }

    fn rotate_on(
        &self,
        relay: &RelayUrl,
        relay_secret: &str,
        vault: &Vault,
        connection: &Connection,
        welcome: &Welcome,
    ) -> Result<(), &'static str> {
        if let Some(successor) = &welcome.retired {
            self.found_retired(vault, successor)?;
            return Err(VAULT_ROTATED);
        }
        if !welcome.rotation {
            return Err("E_SYNC_RELAY_OUTDATED");
        }
        let secrets = self.secrets.as_ref();
        let next = self.next_key(vault)?;
        let next_id = next.id().to_string();
        let waiting = DeviceCredentials::load_next(secrets).map_err(|e| e.code())?;
        if !waiting.is_some_and(|c| c.fits(relay.as_str(), &next_id)) {
            let enrolled = match client::create_vault(relay, relay_secret, &next, DEVICE_LABEL) {
                Err("E_SYNC_VAULT_EXISTS") => client::enroll(relay, &next, DEVICE_LABEL)?,
                other => other?,
            };
            DeviceCredentials {
                relay: relay.as_str().to_string(),
                vault: next_id.clone(),
                device: enrolled.device,
                token: enrolled.token,
            }
            .save_next(secrets)
            .map_err(|e| e.code())?;
            log::info!(
                "I_SYNC_SUCCESSOR_READY vault={} successor={next_id}",
                vault.id()
            );
        }
        self.retire_and_switch(vault, &next, connection)
    }

    /// The rotation's new key: the one waiting for this vault, or a new one, recorded before
    /// anything outside this device changes.
    fn next_key(&self, vault: &Vault) -> Result<Vault, &'static str> {
        let secrets = self.secrets.as_ref();
        let from = vault.id().to_string();
        let mut settings = self.settings.get();
        if let Some(next) = Vault::load_next(secrets).map_err(|e| e.code())?
            && settings
                .rotating
                .as_ref()
                .is_some_and(|r| r.from == from && r.to == next.id().to_string())
        {
            return Ok(next);
        }
        DeviceCredentials::forget_next(secrets).map_err(|e| e.code())?;
        let next = Vault::create_next(secrets).map_err(|e| e.code())?;
        settings.rotating = Some(Rotation {
            from,
            to: next.id().to_string(),
        });
        self.settings.set(&settings)?;
        Ok(next)
    }

    fn retire_and_switch(
        &self,
        vault: &Vault,
        next: &Vault,
        connection: &Connection,
    ) -> Result<(), &'static str> {
        let from = vault.id();
        #[cfg(test)]
        if self
            .quits_before_retire
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return Err("E_SYNC_OFFLINE");
        }
        match client::retire(connection, &next.id().to_string()) {
            Ok(Retire::Done) => {}
            Ok(Retire::Taken(winner)) => {
                self.drop_rotation();
                self.found_retired(vault, &winner)?;
                log::info!("I_SYNC_ROTATION_LOST vault={from} successor={winner}");
                return Err(VAULT_ROTATED);
            }
            Err("E_SYNC_BAD_MESSAGE") => return Err("E_SYNC_RELAY_OUTDATED"),
            Err(code) => return Err(code),
        }
        log::info!("I_SYNC_RETIRED vault={from} successor={}", next.id());
        self.switch_to(next)
    }

    /// The local end of a rotation, once the old vault is retired. The vault item takes the new key
    /// first, so a switch that stops part way is finished from what the keychain holds.
    fn switch_to(&self, next: &Vault) -> Result<(), &'static str> {
        let secrets = self.secrets.as_ref();
        Vault::replace(secrets, next).map_err(|e| e.code())?;
        if let Some(waiting) = DeviceCredentials::load_next(secrets).map_err(|e| e.code())?
            && waiting.vault == next.id().to_string()
        {
            waiting.save(secrets).map_err(|e| e.code())?;
        }
        let mut settings = self.settings.get();
        settings.rotating = None;
        settings.rotated = None;
        self.settings.set(&settings)?;
        Self::forget_next_items(secrets);
        log::info!("I_SYNC_ROTATED vault={}", next.id());
        Ok(())
    }

    /// Finishes a rotation this device started, or drops one that never reached the relay, before
    /// it connects. Returns the vault to connect with.
    pub(super) fn resume_rotation(
        &self,
        relay: &RelayUrl,
        vault: Vault,
    ) -> Result<Vault, &'static str> {
        let Some(rotating) = self.settings.get().rotating else {
            return Ok(vault);
        };
        let secrets = self.secrets.as_ref();
        let held = vault.id().to_string();
        if held == rotating.to {
            self.switch_to(&vault)?;
            return Ok(vault);
        }
        let next = Vault::load_next(secrets)
            .map_err(|e| e.code())?
            .filter(|next| next.id().to_string() == rotating.to);
        let token_waits = DeviceCredentials::load_next(secrets)
            .map_err(|e| e.code())?
            .is_some_and(|c| c.fits(relay.as_str(), &rotating.to));
        match next {
            Some(next) if held == rotating.from && token_waits => {
                let credentials = self.credentials(relay, &vault)?;
                let (connection, _) =
                    Connection::open(relay, &held, &credentials.token, Box::new(|_| {}))
                        .inspect_err(|code| Self::refused(secrets, code))?;
                let switched = self.retire_and_switch(&vault, &next, &connection);
                connection.close();
                switched?;
                Ok(next)
            }
            _ => {
                self.drop_rotation();
                log::info!("I_SYNC_ROTATION_DROPPED vault={held}");
                Ok(vault)
            }
        }
    }

    fn drop_rotation(&self) {
        Self::forget_next_items(self.secrets.as_ref());
        let mut settings = self.settings.get();
        settings.rotating = None;
        if self.settings.set(&settings).is_err() {
            log::warn!("W_SYNC_ROTATION_FORGET_FAILED");
        }
    }

    fn forget_next_items(secrets: &dyn SecretStore) {
        if Vault::delete_next(secrets).is_err() || DeviceCredentials::forget_next(secrets).is_err()
        {
            log::warn!("W_SYNC_ROTATION_FORGET_FAILED");
        }
    }

    /// Records that `vault` is retired for `successor`, the one vault a join may put in its place.
    pub(super) fn found_retired(&self, vault: &Vault, successor: &str) -> Result<(), &'static str> {
        let from = vault.id().to_string();
        let mut settings = self.settings.get();
        if settings.successor_of(&from) != Some(successor) {
            settings.rotated = Some(Rotation {
                from: from.clone(),
                to: successor.to_string(),
            });
            self.settings.set(&settings)?;
            log::info!("I_SYNC_VAULT_ROTATED vault={from} successor={successor}");
        }
        Ok(())
    }

    /// The successor of `held` when it is retired: as recorded, or as its relay's welcome says.
    pub(super) fn successor_of(
        &self,
        relay: &RelayUrl,
        held: &Vault,
    ) -> Result<Option<String>, &'static str> {
        let id = held.id().to_string();
        if let Some(successor) = self.settings.get().successor_of(&id) {
            return Ok(Some(successor.to_string()));
        }
        let Ok(credentials) = self.credentials(relay, held) else {
            return Ok(None);
        };
        let (connection, welcome) =
            match Connection::open(relay, &id, &credentials.token, Box::new(|_| {})) {
                Ok(opened) => opened,
                Err("E_SYNC_OFFLINE") => return Err("E_SYNC_OFFLINE"),
                Err(_) => return Ok(None),
            };
        connection.close();
        match welcome.retired {
            Some(successor) => {
                self.found_retired(held, &successor)?;
                Ok(Some(successor))
            }
            None => Ok(None),
        }
    }

    /// Enrolls this device in `vault` and keeps the token, or records the successor of a vault the
    /// relay retired.
    pub(super) fn enroll_or_retired(
        &self,
        relay: &RelayUrl,
        vault: &Vault,
    ) -> Result<DeviceCredentials, &'static str> {
        match client::enroll_or_retired(relay, vault, DEVICE_LABEL)? {
            Enrollment::Enrolled(enrolled) => {
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
            Enrollment::Retired(successor) => {
                self.found_retired(vault, &successor)?;
                Err(VAULT_ROTATED)
            }
        }
    }
}
