use zeroize::Zeroizing;

use super::super::client::{self, RelayUrl};
use super::super::settings::DeviceCredentials;
use super::super::{SecretStore, Vault};
use super::{
    Created, DEVICE_LABEL, MAX_RECOVERY_KEY, REVOKED, Snapshot, SyncService, VAULT_ROTATED,
    checked_relay_secret,
};

impl SyncService {
    /// On the first device: makes the vault key (or takes the one the keychain holds) and creates
    /// the vault on the relay, which asks for its own secret. The secret goes into that one request
    /// and is dropped. A relay that already holds this vault enrolls the device instead. The
    /// recovery key comes back once for each vault: the first time it is ready on a relay, which
    /// may be a later call than the one that made the key when the relay refused that one.
    pub(crate) fn create_vault(&self, relay_secret: &str) -> Result<Created, &'static str> {
        self.licence.require()?;
        let relay_secret = checked_relay_secret(relay_secret)?;
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
        Ok(Created {
            snapshot: self.changed(),
            recovery_key: self.recovery_key()?.map(|key| key.to_string()),
        })
    }

    /// The recovery key while this device has not said it was saved, once the vault is ready on a
    /// relay. Kept on offer so a closed window or a lost answer does not lose it.
    pub(crate) fn recovery_key(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
        let Some(vault) = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())? else {
            return Ok(None);
        };
        let shown = self.settings.get().recovery_shown == vault.id().to_string();
        let snapshot = self.snapshot();
        let ready = snapshot.enrolled || snapshot.transport == "icloud";
        Ok((!shown && ready).then(|| vault.recovery_key()))
    }

    pub(crate) fn recovery_saved(&self) -> Result<(), &'static str> {
        let vault = self.held_vault()?;
        let mut settings = self.settings.get();
        settings.recovery_shown = vault.id().to_string();
        self.settings.set(&settings)
    }

    /// Joins with the recovery key and the relay set in Settings: restores the vault and enrolls
    /// this device. Works with a relay from before pairing, which has enrollment.
    pub(crate) fn join_with_recovery(&self, text: &str) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        if text.len() > MAX_RECOVERY_KEY {
            return Err("E_SYNC_RECOVERY_FORMAT");
        }
        let relay = self.relay()?;
        let vault = Vault::from_recovery_key(text).map_err(|e| e.code())?;
        let held = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())?;
        let successor = match &held {
            Some(held) if !held.same(&vault) => self.successor_of(&relay, held)?,
            Some(held)
                if self
                    .settings
                    .get()
                    .successor_of(&held.id().to_string())
                    .is_some() =>
            {
                return Err(VAULT_ROTATED);
            }
            Some(held) if self.credentials(&relay, held).is_ok() => return Ok(self.changed()),
            _ => None,
        };
        let replaces = Self::replaces(held.as_ref(), successor.as_deref(), &vault)?;
        let (vault, device) = self.join(&relay, vault, replaces)?;
        log::info!("I_SYNC_RECOVERED vault={} device={device}", vault.id());
        Ok(self.changed())
    }

    /// Whether this device holds a token for `vault` that the relay revoked, on any relay address.
    pub(super) fn revoked_from(&self, vault: &Vault) -> Result<bool, &'static str> {
        Ok(DeviceCredentials::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .is_some_and(|c| c.vault == vault.id().to_string() && c.token == REVOKED))
    }

    /// Whether joining `vault` puts it in place of the vault held: only for the recorded
    /// successor of a retired one. Any other vault held is never replaced.
    pub(super) fn replaces(
        held: Option<&Vault>,
        successor: Option<&str>,
        vault: &Vault,
    ) -> Result<bool, &'static str> {
        match held {
            None => Ok(false),
            Some(held) if held.same(vault) => Ok(false),
            Some(_) if successor == Some(vault.id().to_string().as_str()) => Ok(true),
            Some(_) => Err("E_SYNC_VAULT_EXISTS"),
        }
    }

    /// Enrolls this device in `vault` on `relay`, then keeps the token, the vault and sync on, in
    /// that order: a refused enrollment keeps nothing, and the engine, which needs the vault, never
    /// enrolls a second time meanwhile. `replaces` puts the vault in place of a retired one, which
    /// this device then leaves with its old token.
    pub(super) fn join(
        &self,
        relay: &RelayUrl,
        vault: Vault,
        replaces: bool,
    ) -> Result<(Vault, String), &'static str> {
        let secrets = self.secrets.as_ref();
        let retired = if replaces {
            DeviceCredentials::load(secrets)
                .map_err(|e| e.code())?
                .filter(|old| old.token != REVOKED && old.vault != vault.id().to_string())
        } else {
            None
        };
        let enrolled = client::enroll(relay, &vault, DEVICE_LABEL)?;
        self.keep(relay, &vault, &enrolled.device, &enrolled.token)?;
        let kept = if replaces {
            Vault::replace(secrets, &vault).map(|()| vault)
        } else {
            Vault::join(secrets, vault)
        };
        let vault = kept.map_err(|e| {
            if DeviceCredentials::forget(secrets).is_err() {
                log::warn!("W_SYNC_TOKEN_FORGET_FAILED");
            }
            e.code()
        })?;
        let mut settings = self.settings.get();
        settings.enabled = true;
        settings.recovery_shown = vault.id().to_string();
        if replaces {
            settings.rotated = None;
            settings.call_off_move();
            log::info!("I_SYNC_SUCCESSOR_JOINED vault={}", vault.id());
        }
        self.settings.set(&settings)?;
        if let Some(old) = retired {
            self.leave_retired(&old);
        }
        Ok((vault, enrolled.device))
    }

    pub(super) fn keep(
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

    pub(super) fn enroll_here(
        &self,
        relay: &RelayUrl,
        vault: &Vault,
    ) -> Result<DeviceCredentials, &'static str> {
        self.enroll_or_retired(relay, vault)
    }

    /// What the relay's refusal means for the kept token. A revoked device keeps a marked token and
    /// never enrolls on its own; a relay without the vault (it lost its data) makes the token
    /// useless, so it goes and Settings asks for the relay's secret to create the vault again.
    pub(super) fn refused(secrets: &dyn SecretStore, code: &str) {
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
}
