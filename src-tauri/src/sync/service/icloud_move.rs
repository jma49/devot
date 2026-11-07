#[cfg(test)]
use std::sync::atomic::Ordering;

use super::super::cloudkit::current::{self, Claim, Unclaimed};
use super::super::cloudkit::{self, ICloudState};
use super::super::settings::{DeviceCredentials, SyncSettings};
use super::super::{Vault, handover, moved};
use super::{
    MAX_RECOVERY_KEY, NO_VAULT, OTHER_VAULT, RECOVERY_OTHER_VAULT, Snapshot, StatusView,
    SyncService, VAULT_MOVED,
};

impl SyncService {
    /// Syncs this device's vault through iCloud from its next connect, and turns sync on, once
    /// `current` names it. With no vault here it makes one, or restores it from `recovery_key`; a
    /// key for another vault than the one held is refused. A new vault is kept before its `current`
    /// is saved; one that lost to another device's is removed again, and this device looks for the
    /// winner as at launch, with `notes` in its library. A vault this device syncs through a relay
    /// claims `current`, records the move, then leaves the moved marker there unless it is following
    /// one, so the relay's other devices stop rather than drift apart; a device that quits before it
    /// switches finishes the move when its engine finds that marker while `current` names the vault.
    /// A refused marker keeps this device on the relay with `current` still claimed, which a retry
    /// reuses; iCloud's own epoch makes the first connect upload all.
    pub(crate) fn use_icloud(
        &self,
        recovery_key: Option<&str>,
        notes: u64,
    ) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        if !self.kit.available() {
            return Err(cloudkit::error::UNAVAILABLE);
        }
        if recovery_key.is_some_and(|key| key.len() > MAX_RECOVERY_KEY) {
            return Err("E_SYNC_RECOVERY_FORMAT");
        }
        let named = recovery_key
            .map(Vault::from_recovery_key)
            .transpose()
            .map_err(|e| e.code())?;
        let held = Vault::load(self.secrets.as_ref()).map_err(|e| e.code())?;
        let succeeds = match (&held, &named) {
            (Some(held), Some(named)) if !held.same(named) => {
                if self.icloud_successor_of(held).as_deref() != Some(&named.id().to_string()) {
                    return Err("E_SYNC_VAULT_EXISTS");
                }
                true
            }
            _ => false,
        };
        current::ready(self.kit.as_ref())?;
        let _switching = self.switching.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        let vault = match (held, named) {
            (Some(held), Some(named)) if succeeds => {
                let vault = self.join_successor(&held, named)?;
                log::info!("I_SYNC_SUCCESSOR_JOINED vault={} via=recovery", vault.id());
                return Ok(self.changed());
            }
            (Some(held), _) => {
                self.claim(&held)?;
                self.leave_relay(&held)?;
                held
            }
            (None, Some(named)) => {
                self.belongs(&named)?;
                named
            }
            (None, None) => match self.claim_new(Vault::generate().map_err(|e| e.code())?)? {
                Some(vault) => vault,
                None => return self.icloud_look(notes),
            },
        };
        let vault = self.keep_icloud(vault, recovery_key.is_some())?;
        log::info!("I_SYNC_ICLOUD_USED vault={}", vault.id());
        Ok(self.changed())
    }

    /// Leaves the moved marker on the relay this device is enrolled on for `vault`. Nothing to leave
    /// when the vault is on iCloud already, the device is not enrolled, or it follows a marker.
    fn leave_relay(&self, vault: &Vault) -> Result<(), &'static str> {
        let following = self
            .status
            .lock()
            .is_ok_and(|s| s.code.as_deref() == Some(VAULT_MOVED));
        if self.on_icloud() || following {
            return Ok(());
        }
        let Ok(relay) = self.relay() else {
            return Ok(());
        };
        match self.credentials(&relay, vault) {
            Err("E_SYNC_NOT_ENROLLED") => return Ok(()),
            other => other?,
        };
        let id = vault.id().to_string();
        self.record_move(&id)?;
        self.with_connection(|connection| {
            self.keep_unseen(connection, &id);
            #[cfg(test)]
            if self.fails_marker.swap(false, Ordering::Relaxed) {
                return Err("E_TEST_MARKER");
            }
            moved::leave_relay(connection, vault)
        })
        .inspect_err(|code| {
            log::warn!("W_SYNC_MOVED_MARKER {code} vault={}", vault.id());
            if self.settings.update(SyncSettings::call_off_move).is_err() {
                log::warn!("W_SYNC_MOVE_RECORD vault={}", vault.id());
            }
        })?;
        log::info!("I_SYNC_MOVED_MARKER vault={} to=icloud", vault.id());
        Ok(())
    }

    /// Records that this device started moving `vault` to iCloud; '' records none.
    fn record_move(&self, vault: &str) -> Result<(), &'static str> {
        let mut settings = self.settings.get();
        if settings.moving == vault {
            return Ok(());
        }
        settings.moving = vault.to_string();
        self.settings.set(&settings)
    }

    /// The engine stopped on a moved marker. When this device started the move and quit before it
    /// switched, it switches now, as `use_icloud` would have, if `current` still names the vault.
    /// Otherwise (iCloud signed out, another Apple ID, a restored backup) it stays stopped, and
    /// Settings says the move started here so the owner finishes it.
    pub(super) fn finish_started_move(&self) {
        let Ok(_switching) = self.switching.lock() else {
            log::warn!("W_SYNC_MOVE_UNFINISHED E_SYNC_INTERNAL");
            return;
        };
        let settings = self.settings.get();
        let Ok(vault) = self.held_vault() else {
            return;
        };
        let id = vault.id().to_string();
        if settings.moving != id || settings.icloud_for(&id).is_some() {
            return;
        }
        let finished = current::ready(self.kit.as_ref())
            .and_then(|()| self.named(&id))
            .and_then(|()| self.keep_icloud(vault, false));
        match finished {
            Ok(_) => {
                log::info!("I_SYNC_MOVE_FINISHED vault={id}");
                if let Ok(mut status) = self.status.lock() {
                    *status = StatusView {
                        state: "connecting".into(),
                        ..StatusView::default()
                    };
                }
            }
            Err(code) => log::warn!("W_SYNC_MOVE_UNFINISHED {code} vault={id}"),
        }
    }

    /// Whether `current` names `vault`; never saves it, so no vault goes to an Apple ID unasked.
    fn named(&self, vault: &str) -> Result<(), &'static str> {
        match current::read(self.kit.as_ref())? {
            Some(current) if current == vault => Ok(()),
            Some(_) => Err(OTHER_VAULT),
            None => Err(NO_VAULT),
        }
    }

    /// Saves `current` naming `vault` unless it names another, which this device never replaces.
    fn claim(&self, vault: &Vault) -> Result<(), &'static str> {
        match current::claim(self.kit.as_ref(), &vault.id().to_string())? {
            Claim::Won => Ok(()),
            Claim::Lost(_) => Err(OTHER_VAULT),
        }
    }

    /// Keeps a new `vault` in this device's own item, then saves `current` naming it, so `current`
    /// never names a vault no device holds. `None` when another vault won; the key is removed again.
    fn claim_new(&self, vault: Vault) -> Result<Option<Vault>, &'static str> {
        let kit = self.kit.as_ref();
        let vault = Vault::join(self.secrets.as_ref(), vault).map_err(|e| e.code())?;
        let id = vault.id().to_string();
        let failed = match current::claim(kit, &id) {
            Ok(Claim::Won) => return Ok(Some(vault)),
            Ok(Claim::Lost(_)) => None,
            // A save reported as failed may have been applied: the key goes only once `current`
            // is known to name another vault or none.
            Err(code) => match current::read(kit) {
                Ok(Some(current)) if current == id => return Ok(Some(vault)),
                Ok(_) => Some(code),
                Err(_) => return Err(code),
            },
        };
        Vault::delete(self.secrets.as_ref()).map_err(|e| {
            log::warn!("W_SYNC_VAULT_REMOVE {e} vault={id}");
            e.code()
        })?;
        failed.map_or(Ok(None), Err)
    }

    /// Whether this Apple ID syncs `vault`: `current` names it, or its zone is there from before
    /// `current` and it claims it now. Any other vault would start a second copy that never meets
    /// the first; with no `current` and no zone it is not on this Apple ID's iCloud, and a zone
    /// without zone `devot` belongs to a leave that stopped part way, so it is treated as left.
    pub(super) fn belongs(&self, vault: &Vault) -> Result<(), &'static str> {
        let kit = self.kit.as_ref();
        let id = vault.id().to_string();
        match current::read(kit)? {
            Some(current) if current == id => Ok(()),
            Some(_) => Err(OTHER_VAULT),
            None => match current::unclaimed(kit, &id)? {
                Unclaimed::There => self.claim(vault),
                Unclaimed::BeingLeft => {
                    log::warn!("W_SYNC_ICLOUD_BEING_LEFT vault={id}");
                    Err(cloudkit::error::LEAVING)
                }
                Unclaimed::Absent => Err(NO_VAULT),
            },
        }
    }

    /// Keeps `vault` in this device's own item (never replacing another), syncs it through iCloud,
    /// turns sync on and leaves it in the handover item. A vault `joined`, not made here, never
    /// shows its recovery key.
    pub(super) fn keep_icloud(&self, vault: Vault, joined: bool) -> Result<Vault, &'static str> {
        #[cfg(test)]
        if self.quits_before_switch.swap(false, Ordering::Relaxed) {
            return Err("E_TEST_QUIT");
        }
        let vault = Vault::join(self.secrets.as_ref(), vault).map_err(|e| e.code())?;
        let vault_id = vault.id().to_string();
        self.disconnect();
        let mut settings = self.settings.get();
        if settings.icloud_for(&vault_id).is_none() {
            let mut state = ICloudState::new(&vault_id);
            state.relay_device = DeviceCredentials::load(self.secrets.as_ref())
                .ok()
                .flatten()
                .filter(|c| c.vault == vault_id)
                .map(|c| c.device)
                .unwrap_or_default();
            settings.icloud = Some(state);
        }
        settings.enabled = true;
        settings.icloud_declined.clear();
        settings.moving.clear();
        if joined {
            settings.recovery_shown = vault_id;
        }
        self.settings.set(&settings)?;
        self.hand_over(&vault);
        Ok(vault)
    }

    /// The successor recorded for `held` when it syncs through iCloud: the one vault a join may put
    /// in its place there.
    pub(super) fn icloud_successor_of(&self, held: &Vault) -> Option<String> {
        let settings = self.settings.get();
        let id = held.id().to_string();
        settings.icloud_for(&id)?;
        settings.successor_of(&id).map(str::to_string)
    }

    /// Puts `next`, the recorded successor of the iCloud vault `held`, in its place, once `current`
    /// names it, and leaves it in the handover item.
    pub(super) fn join_successor(&self, held: &Vault, next: Vault) -> Result<Vault, &'static str> {
        if self.icloud_successor_of(held).as_deref() != Some(&next.id().to_string()) {
            return Err("E_SYNC_VAULT_EXISTS");
        }
        self.named(&next.id().to_string())?;
        self.switch_icloud(&next, &held.id().to_string(), true)?;
        self.hand_over(&next);
        Ok(next)
    }

    /// When the owner chose to upload again after `E_SYNC_ICLOUD_DELETED`, or to move the vault
    /// into the Apple ID now signed in after `E_SYNC_ICLOUD_ACCOUNT_CHANGED`: `current` there names
    /// the vault (never replacing another), and the next connect makes its zone under a new epoch,
    /// so this device uploads everything.
    pub(crate) fn icloud_upload_again(&self) -> Result<Snapshot, &'static str> {
        self.licence.require()?;
        let vault = self.held_vault()?;
        let mut settings = self.settings.get();
        let state = settings
            .icloud
            .as_mut()
            .filter(|state| state.vault == vault.id().to_string())
            .ok_or("E_SYNC_ICLOUD_NOT_USED")?;
        current::ready(self.kit.as_ref())?;
        let account = cloudkit::account_of(self.kit.as_ref())?;
        let moved = !state.account.is_empty() && state.account != account;
        self.claim(&vault)?;
        state.account = account;
        state.zone_seen = false;
        state.subscribed = false;
        state.device_day = 0;
        self.settings.set(&settings)?;
        self.hand_over(&vault);
        self.disconnect();
        if moved {
            log::info!("I_SYNC_ICLOUD_MOVED_ACCOUNT vault={}", vault.id());
        } else {
            log::info!("I_SYNC_ICLOUD_UPLOAD_AGAIN vault={}", vault.id());
        }
        Ok(self.changed())
    }

    /// Leave This Vault (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md, Leaving
    /// the vault): removes the vault from this Apple ID, which is its membership. The vault's own
    /// recovery key confirms it; any other key, or the Apple ID not the one the vault syncs with,
    /// deletes nothing. Sync turns off, then the zones go, then the handover item, then this
    /// device's own item, so a failure part way keeps the key here and a retry ends the same. Notes
    /// stay on every device; the others find the zone gone and ask before uploading again.
    pub(crate) fn icloud_leave(&self, recovery_key: &str) -> Result<Snapshot, &'static str> {
        if recovery_key.len() > MAX_RECOVERY_KEY {
            return Err("E_SYNC_RECOVERY_FORMAT");
        }
        let vault = self.held_vault()?;
        let id = vault.id().to_string();
        let mut settings = self.settings.get();
        let account = settings
            .icloud_for(&id)
            .ok_or("E_SYNC_ICLOUD_NOT_USED")?
            .account
            .clone();
        let named = Vault::from_recovery_key(recovery_key).map_err(|e| e.code())?;
        if !named.same(&vault) {
            return Err(RECOVERY_OTHER_VAULT);
        }
        let kit = self.kit.as_ref();
        current::ready(kit)?;
        let signed_in = cloudkit::account_of(kit)?;
        if account.is_empty() {
            // Never connected, so no Apple ID is kept: `current` here must name the vault. This
            // Apple ID is kept now, so a retry after a failure part way is checked as any other.
            if current::read(kit)?.as_deref() != Some(id.as_str()) {
                return Err(NO_VAULT);
            }
            if let Some(state) = settings.icloud.as_mut().filter(|s| s.vault == id) {
                state.account = signed_in;
                self.settings.set(&settings)?;
            }
        } else if account != signed_in {
            return Err(cloudkit::error::ACCOUNT_CHANGED);
        }
        self.pairing_cancel();
        self.disconnect();
        if settings.enabled {
            settings.enabled = false;
            self.settings.set(&settings)?;
        }
        current::leave(kit, &id)?;
        handover::remove(self.handover.as_ref(), &vault).map_err(|e| {
            log::warn!("W_SYNC_HANDOVER_REMOVE {e} vault={id}");
            e.code()
        })?;
        Vault::delete(self.secrets.as_ref()).map_err(|e| {
            log::warn!("W_SYNC_VAULT_REMOVE {e} vault={id}");
            e.code()
        })?;
        Self::forget_next_items(self.secrets.as_ref());
        let mut settings = self.settings.get();
        settings.icloud = None;
        settings.icloud_declined.clear();
        settings.unseen = None;
        settings.rotating = None;
        settings.rotated = None;
        self.settings.set(&settings)?;
        if let Ok(mut look) = self.look.lock() {
            *look = None;
        }
        log::info!("I_SYNC_ICLOUD_LEFT vault={id}");
        Ok(self.changed())
    }
}
