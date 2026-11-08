use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use zeroize::Zeroizing;

use super::super::Vault;
use super::super::client::PairingState;
use super::super::cloudkit::current;
use super::super::cloudkit::pairing::ICloudPairing;
use super::super::pairing::{self, Pairing, PairingChannel, RelayPairing};
use super::{OTHER_ACCOUNT, PairingCheck, PairingView, Snapshot, SyncService, VAULT_ROTATED};

/// The pairing this device shows. Only one at a time: a new code closes the last.
pub(super) struct Hosting {
    pairing: Pairing,
    channel: Box<dyn PairingChannel>,
    vault: String,
    expires: i64,
    taken: AtomicBool,
    pub(super) icloud: bool,
}

impl SyncService {
    /// Shows a new pairing code: seals the vault under it and leaves the offer on the relay
    /// (docs/adr/0008-sync-device-pairing.md), or for a vault on iCloud in zone `devot`. A code
    /// shown before is closed.
    pub(crate) fn pairing_open(&self) -> Result<PairingView, &'static str> {
        self.licence.require()?;
        if self.on_icloud() {
            return self.pairing_open_icloud();
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
        self.pairing_cancel();
        let pairing = Pairing::generate().map_err(|e| e.code())?;
        let expires = self.now().saturating_add(pairing::TTL_MS);
        let offer = pairing.seal_offer(&vault, expires).map_err(|e| e.code())?;
        let vault_id = vault.id().to_string();
        let token = Zeroizing::new(credentials.token);
        let channel = RelayPairing::host(relay.clone(), vault_id.clone(), token);
        channel.open(pairing.id(), &offer)?;
        let link = pairing.link(&relay);
        self.show(pairing, Box::new(channel), vault_id, expires, &link, false)
    }

    /// The offer waits in zone `devot`, where only this Apple ID's devices see it.
    fn pairing_open_icloud(&self) -> Result<PairingView, &'static str> {
        let vault = self.held_vault()?;
        current::ready(self.kit.as_ref())?;
        self.pairing_cancel();
        let pairing = Pairing::generate().map_err(|e| e.code())?;
        let now = self.now();
        let expires = now.saturating_add(pairing::TTL_MS);
        let offer = pairing
            .seal_icloud_offer(&vault, expires)
            .map_err(|e| e.code())?;
        let channel = ICloudPairing::host(Arc::clone(&self.kit), expires, now);
        channel.open(pairing.id(), &offer)?;
        let link = pairing.icloud_link();
        let vault_id = vault.id().to_string();
        self.show(pairing, Box::new(channel), vault_id, expires, &link, true)
    }

    fn show(
        &self,
        pairing: Pairing,
        channel: Box<dyn PairingChannel>,
        vault_id: String,
        expires: i64,
        link: &str,
        icloud: bool,
    ) -> Result<PairingView, &'static str> {
        let view = PairingView {
            code: pairing.code().to_string(),
            link: link.to_string(),
            qr: pairing::qr(link)?,
            expires,
        };
        log::info!(
            "I_SYNC_PAIRING_OPEN vault={vault_id} pairing={}",
            pairing.id()
        );
        *self.hosting.lock().map_err(|_| "E_SYNC_INTERNAL")? = Some(Arc::new(Hosting {
            pairing,
            channel,
            vault: vault_id,
            expires,
            taken: AtomicBool::new(false),
            icloud,
        }));
        Ok(view)
    }

    /// Asks the relay (or zone `devot`) how the pairing on show is going. A confirmation counts only
    /// when it opens under the code's key; then the pairing is closed.
    pub(crate) fn pairing_check(&self) -> Result<PairingCheck, &'static str> {
        let hosting = self
            .hosting
            .lock()
            .map_err(|_| "E_SYNC_INTERNAL")?
            .clone()
            .ok_or("E_SYNC_PAIRING_NONE")?;
        let now = self.now();
        // A device that took the code just before expiry may confirm while the relay keeps it.
        if now > hosting.expires.saturating_add(pairing::GRACE_MS) {
            let closed = self.end_pairing(&hosting);
            return Ok(Self::ended(&hosting, closed));
        }
        let state = hosting.channel.poll(hosting.pairing.id());
        match state {
            Ok(PairingState::Open) if now > hosting.expires => {
                let closed = self.end_pairing(&hosting);
                Ok(Self::ended(&hosting, closed))
            }
            Ok(PairingState::Open) => Ok(PairingCheck::is("waiting")),
            Ok(PairingState::Taken) => {
                hosting.taken.store(true, Ordering::Relaxed);
                Ok(PairingCheck::is("taken"))
            }
            Ok(PairingState::Confirmed(proof)) => {
                let opened = hosting.pairing.open_confirmation(&proof);
                self.end_pairing(&hosting);
                let device = opened.map_err(|e| {
                    log::warn!("W_SYNC_PAIRING_PROOF pairing={}", hosting.pairing.id());
                    e.code()
                })?;
                log::info!("I_SYNC_PAIRED vault={} device={device}", hosting.vault);
                Ok(PairingCheck {
                    state: "paired",
                    device: Some(device),
                })
            }
            Err("E_SYNC_PAIRING_GONE") => {
                self.forget_pairing(&hosting);
                Ok(Self::ended(&hosting, None))
            }
            Err(code) => Err(code),
        }
    }

    /// A confirmation the channel still held when it closed was never checked: unconfirmed too.
    fn ended(hosting: &Hosting, closed: Option<PairingState>) -> PairingCheck {
        let taken = matches!(
            closed,
            Some(PairingState::Taken | PairingState::Confirmed(_))
        );
        if taken || hosting.taken.load(Ordering::Relaxed) {
            log::warn!(
                "W_SYNC_PAIRING_UNCONFIRMED pairing={}",
                hosting.pairing.id()
            );
            PairingCheck::is("unconfirmed")
        } else {
            PairingCheck::is("expired")
        }
    }

    /// Closes the pairing on show, where its offer waits too when that answers.
    pub(crate) fn pairing_cancel(&self) {
        let hosting = self.hosting.lock().ok().and_then(|mut h| h.take());
        if let Some(hosting) = hosting {
            Self::close_on_relay(&hosting);
        }
    }

    fn end_pairing(&self, hosting: &Arc<Hosting>) -> Option<PairingState> {
        self.forget_pairing(hosting);
        Self::close_on_relay(hosting)
    }

    fn forget_pairing(&self, hosting: &Arc<Hosting>) {
        if let Ok(mut held) = self.hosting.lock()
            && held.as_ref().is_some_and(|h| Arc::ptr_eq(h, hosting))
        {
            *held = None;
        }
    }

    fn close_on_relay(hosting: &Hosting) -> Option<PairingState> {
        match hosting.channel.close(hosting.pairing.id()) {
            Ok(closed) => closed,
            Err(code) => {
                if code != "E_SYNC_PAIRING_GONE" {
                    log::warn!("W_SYNC_PAIRING_CLOSE {code}");
                }
                None
            }
        }
    }

    /// Joins the vault a pairing code (or the link its QR code holds) hands over: takes the offer,
    /// enrolls this device, keeps the vault and confirms to the device that shows the code. A link
    /// must name the relay set in Settings: the page asks before it sets a relay from a link. A code
    /// alone goes through iCloud when `icloud`, the page's choice; a link names its own way.
    pub(crate) fn join_with_code_via(
        &self,
        text: &str,
        icloud: bool,
    ) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        let entered = pairing::read(text).map_err(|e| e.code())?;
        if entered.icloud || (icloud && entered.relay.is_none()) {
            return self.join_icloud_with_code(&entered.pairing);
        }
        let relay = self.relay()?;
        if entered
            .relay
            .is_some_and(|named| named.as_str() != relay.as_str())
        {
            return Err("E_SYNC_PAIRING_RELAY");
        }
        // Refused before the offer is taken, so the code still works on another device. A device
        // removed from its vault may hold it and be let back in; one whose vault was retired joins
        // the successor.
        let held = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())?;
        let successor = match &held {
            Some(held) => self.successor_of(&relay, held)?,
            None => None,
        };
        if let Some(held) = &held
            && successor.is_none()
            && !self.revoked_from(held)?
        {
            return Err("E_SYNC_VAULT_EXISTS");
        }
        let pairing = entered.pairing;
        let channel = RelayPairing::join(relay.clone());
        let offer = channel.take(pairing.id())?;
        let vault = pairing.open_offer(&offer, self.now()).map_err(|e| {
            log::warn!("W_SYNC_PAIRING_OFFER {} pairing={}", e.code(), pairing.id());
            e.code()
        })?;
        let replaces = Self::replaces(held.as_ref(), successor.as_deref(), &vault)?;
        let (vault, device) = self.join(&relay, vault, replaces)?;
        let confirmed = pairing
            .seal_confirmation(&device)
            .map_err(|e| e.code())
            .and_then(|proof| channel.confirm(pairing.id(), &proof));
        if let Err(code) = confirmed {
            log::warn!("W_SYNC_PAIRING_CONFIRM {code} pairing={}", pairing.id());
        }
        log::info!("I_SYNC_JOINED vault={} device={device}", vault.id());
        Ok(self.changed())
    }

    #[cfg(test)]
    pub(crate) fn join_with_code(&self, text: &str) -> Result<Snapshot, &'static str> {
        self.join_with_code_via(text, false)
    }

    /// Takes the offer from zone `devot`, keeps the vault it seals and confirms with this device's
    /// ID in the vault. An offer this Apple ID cannot see, when it has no vault either, was shown on
    /// another Apple ID.
    fn join_icloud_with_code(&self, pairing: &Pairing) -> Result<Snapshot, &'static str> {
        let kit = self.kit.as_ref();
        // Refused before the offer is taken, so the code still works on another device. A device
        // whose iCloud vault was rotated joins the successor.
        let held = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())?;
        if held
            .as_ref()
            .is_some_and(|held| self.icloud_successor_of(held).is_none())
        {
            return Err("E_SYNC_VAULT_EXISTS");
        }
        current::ready(kit)?;
        let channel = ICloudPairing::join(Arc::clone(&self.kit));
        let offer =
            channel
                .take(pairing.id())
                .map_err(|code| match (code, current::read(kit)) {
                    ("E_SYNC_PAIRING_GONE", Ok(None)) => OTHER_ACCOUNT,
                    _ => code,
                })?;
        let vault = pairing.open_icloud_offer(&offer, self.now()).map_err(|e| {
            log::warn!("W_SYNC_PAIRING_OFFER {} pairing={}", e.code(), pairing.id());
            e.code()
        })?;
        let vault = match &held {
            Some(held) => self.join_successor(held, vault)?,
            None => {
                self.belongs(&vault)?;
                self.keep_icloud(vault, true)?
            }
        };
        let vault_id = vault.id().to_string();
        let device = self
            .settings
            .get()
            .icloud_for(&vault_id)
            .map(|state| state.device.clone())
            .ok_or("E_SYNC_INTERNAL")?;
        let confirmed = pairing
            .seal_confirmation(&device)
            .map_err(|e| e.code())
            .and_then(|proof| channel.confirm(pairing.id(), &proof));
        if let Err(code) = confirmed {
            log::warn!("W_SYNC_PAIRING_CONFIRM {code} pairing={}", pairing.id());
        }
        log::info!("I_SYNC_JOINED vault={vault_id} device={device} via=icloud");
        Ok(self.changed())
    }
}
