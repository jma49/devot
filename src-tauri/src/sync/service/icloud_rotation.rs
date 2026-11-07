//! Rotating an iCloud vault's key (docs/adr/0017-sync-key-rotation.md, On iCloud). The rotating
//! device makes the successor's zone and epoch, names the successor to the old key's holders in
//! zone `devot`, moves `current` to it against the `current` that named the old vault, leaves it in
//! the handover item, switches, and deletes what is left of the old vault. Each step is kept before
//! the next and needs no secret, so a rotation that stops part way carries on at the next connect.
//! The other devices follow on their own when the successor record and the handover item agree.

use super::super::cloudkit::current::{self, Claim};
use super::super::cloudkit::{self, ICloudState, rotation};
use super::super::settings::{Rotation, SyncSettings};
use super::super::{Vault, handover, successor};
use super::{Created, NO_VAULT, OTHER_VAULT, SyncService, VAULT_ROTATED};

impl SyncService {
    /// Change Vault Key on iCloud. Not gated by the licence: taking access away never is. A device
    /// still on the Apple ID with the iCloud Keychain reads the new handover item, so it must be
    /// off the Apple ID first; Settings says so. The new recovery key comes back to show. A
    /// rotation that lost to another one comes back without it once this device follows the
    /// winner, so Settings never offers to rotate the winner's vault again as a retry.
    pub(crate) fn rotate_icloud(&self) -> Result<Created, &'static str> {
        let _membership = self.membership.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        let vault = self.held_vault()?;
        let id = vault.id().to_string();
        match self.rotate_held_icloud(vault) {
            Err(VAULT_ROTATED) if self.held_vault()?.id().to_string() != id => Ok(Created {
                snapshot: self.changed(),
                recovery_key: None,
            }),
            Err(VAULT_ROTATED) => {
                self.changed();
                Err(VAULT_ROTATED)
            }
            rotated => rotated,
        }
    }

    fn rotate_held_icloud(&self, vault: Vault) -> Result<Created, &'static str> {
        let id = vault.id().to_string();
        let settings = self.settings.get();
        let account = settings
            .icloud_for(&id)
            .ok_or("E_SYNC_ICLOUD_NOT_USED")?
            .account
            .clone();
        if settings.successor_of(&id).is_some() {
            return Err(VAULT_ROTATED);
        }
        let kit = self.kit.as_ref();
        current::ready(kit)?;
        if !account.is_empty() && cloudkit::account_of(kit)? != account {
            return Err(cloudkit::error::ACCOUNT_CHANGED);
        }
        self.pairing_cancel();
        self.disconnect();
        let started = settings
            .rotating
            .clone()
            .filter(|rotating| rotating.from == id);
        let vault = match started {
            Some(rotating) => {
                let resumed = self.resume_icloud_rotation(vault, &rotating)?;
                if resumed.id().to_string() != id {
                    return self.rotated_here();
                }
                resumed
            }
            None => vault,
        };
        match current::read(kit)? {
            Some(named) if named == id => {}
            Some(named) if rotation::successor(kit, &vault, &named)?.is_some() => {
                self.found_retired(&vault, &named)?;
                return Err(VAULT_ROTATED);
            }
            Some(_) => return Err(OTHER_VAULT),
            None => return Err(NO_VAULT),
        }
        let next = self.next_key(&vault)?;
        self.quit_at("key")?;
        self.carry_on(&vault, next)?;
        self.rotated_here()
    }

    fn rotated_here(&self) -> Result<Created, &'static str> {
        Ok(Created {
            snapshot: self.changed(),
            recovery_key: self.recovery_key()?.map(|key| key.to_string()),
        })
    }

    /// The steps from the successor's zone on; each saves what an earlier try saved again.
    fn carry_on(&self, old: &Vault, next: Vault) -> Result<Vault, &'static str> {
        let kit = self.kit.as_ref();
        let (from, to) = (old.id().to_string(), next.id().to_string());
        self.quit_at("zone")?;
        rotation::make_successor(kit, &next)?;
        self.quit_at("successor")?;
        rotation::save_successor(kit, old, &next)?;
        self.quit_at("current")?;
        match current::replace(kit, &from, &to)? {
            Some(Claim::Won) => {}
            Some(Claim::Lost(winner)) => {
                self.lost_icloud_race(old, &to, &winner);
                return Err(VAULT_ROTATED);
            }
            None => {
                self.abandon_icloud_rotation(&from, &to);
                return Err(NO_VAULT);
            }
        }
        self.finish_icloud_rotation(&from, next)
    }

    /// Once `current` names the successor: the handover item, the switch, and the old vault's
    /// zone and rows.
    fn finish_icloud_rotation(&self, from: &str, next: Vault) -> Result<Vault, &'static str> {
        self.quit_at("handover")?;
        self.write_handover(&next);
        self.quit_at("switch")?;
        self.switch_icloud(&next, from, false)?;
        self.clear_retired();
        log::info!("I_SYNC_ROTATED vault={from} successor={}", next.id());
        Ok(next)
    }

    /// Another device's rotation moved `current` first: this rotation's key and what it made go,
    /// and this device follows the winner as any other device does.
    fn lost_icloud_race(&self, old: &Vault, to: &str, winner: &str) {
        let from = old.id().to_string();
        self.abandon_icloud_rotation(&from, to);
        log::info!("I_SYNC_ROTATION_LOST vault={from} successor={winner}");
        if let Err(code) = self.follow_icloud(old) {
            log::warn!("W_SYNC_ROTATION_FOLLOW {code} vault={from}");
        }
    }

    fn abandon_icloud_rotation(&self, from: &str, to: &str) {
        self.drop_rotation();
        if let Err(code) = rotation::abandon(self.kit.as_ref(), from, to) {
            log::warn!("W_SYNC_ICLOUD_SUCCESSOR_ABANDON {code} vault={from} successor={to}");
        }
    }

    /// Before a connect, a rotation of this device's iCloud vault recorded as started: carried on
    /// from where it stopped, or dropped when it cannot finish. Returns the vault to connect with.
    pub(super) fn resume_icloud_rotation(
        &self,
        vault: Vault,
        rotating: &Rotation,
    ) -> Result<Vault, &'static str> {
        let next = Vault::load_next(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .filter(|next| next.id().to_string() == rotating.to);
        let named = current::read(self.kit.as_ref())?;
        match (named, next) {
            (Some(named), Some(next)) if named == rotating.from => self.carry_on(&vault, next),
            (Some(named), Some(next)) if named == rotating.to => {
                self.finish_icloud_rotation(&rotating.from, next)
            }
            (Some(named), None) if named == rotating.to => {
                self.drop_rotation();
                log::warn!(
                    "W_SYNC_ROTATION_KEY_LOST vault={} successor={}",
                    rotating.from,
                    rotating.to
                );
                Ok(vault)
            }
            (Some(winner), Some(_)) if winner != rotating.from => {
                self.lost_icloud_race(&vault, &rotating.to, &winner);
                Err(VAULT_ROTATED)
            }
            _ => {
                self.abandon_icloud_rotation(&rotating.from, &rotating.to);
                log::info!("I_SYNC_ROTATION_DROPPED vault={}", rotating.from);
                Ok(vault)
            }
        }
    }

    /// A switch that stopped between the vault item and the settings: the vault held is the
    /// successor recorded for the vault the settings sync through iCloud. Finished here.
    pub(super) fn finish_icloud_switch(&self, held: &Vault) -> Result<(), &'static str> {
        let settings = self.settings.get();
        let id = held.id().to_string();
        let pending = |rotation: &Option<Rotation>| {
            rotation
                .as_ref()
                .filter(|r| r.to == id && settings.icloud_for(&r.from).is_some())
                .map(|r| r.from.clone())
        };
        if let Some(from) = pending(&settings.rotating) {
            self.switch_icloud(held, &from, false)?;
            self.clear_retired();
        } else if let Some(from) = pending(&settings.rotated) {
            self.switch_icloud(held, &from, true)?;
        }
        Ok(())
    }

    /// The other devices: when `current` names another vault and the successor record of the vault
    /// held opens and names it, the successor is recorded; when the handover item holds that vault
    /// and the record's MAC holds under its key, this device switches to it on its own and the
    /// next connect uploads. Returns the successor once switched.
    pub(super) fn follow_icloud(&self, held: &Vault) -> Result<Option<Vault>, &'static str> {
        let kit = self.kit.as_ref();
        let from = held.id().to_string();
        let Some(to) = current::read(kit)?.filter(|named| *named != from) else {
            return Ok(None);
        };
        let Some(mac) = rotation::successor(kit, held, &to)? else {
            return Ok(None);
        };
        self.found_retired(held, &to)?;
        match handover::read(self.handover.as_ref()) {
            Ok(Some(next)) if next.id().to_string() == to => {
                if !successor::verify(&next, held.id(), &mac) {
                    log::warn!("W_SYNC_ICLOUD_SUCCESSOR_MAC vault={from} successor={to}");
                    return Ok(None);
                }
                self.switch_icloud(&next, &from, true)?;
                self.hand_over(&next);
                log::info!("I_SYNC_ROTATION_FOLLOWED vault={from} successor={to}");
                Ok(Some(next))
            }
            Ok(_) => {
                log::info!("I_SYNC_ROTATION_WAITS vault={from} successor={to}");
                Ok(None)
            }
            Err(e) => {
                log::warn!("W_SYNC_HANDOVER_UNREADABLE {e}");
                Ok(None)
            }
        }
    }

    /// Puts `next`, the successor of `from`, in place of the vault held and syncs it through iCloud
    /// from the next connect, which finds a new epoch and uploads the whole library. The vault item
    /// goes first, so a switch that stops part way is finished from what the keychain holds. A
    /// device that `joined` the successor never shows its recovery key; the one that made it shows
    /// it and deletes the old vault's zone and rows.
    pub(super) fn switch_icloud(
        &self,
        next: &Vault,
        from: &str,
        joined: bool,
    ) -> Result<(), &'static str> {
        let secrets = self.secrets.as_ref();
        self.disconnect();
        Vault::replace(secrets, next).map_err(|e| e.code())?;
        self.quit_at("settings")?;
        let to = next.id().to_string();
        self.settings.update(|settings| {
            let account = settings
                .icloud_for(from)
                .map(|state| state.account.clone())
                .unwrap_or_default();
            let mut state = ICloudState::new(&to);
            state.account = account;
            if !joined {
                state.retired = from.to_string();
            }
            settings.icloud = Some(state);
            settings.rotating = None;
            settings.rotated = None;
            settings.icloud_declined.clear();
            if settings.unseen.as_ref().is_some_and(|u| u.vault == from) {
                settings.unseen = None;
            }
            if joined {
                settings.enabled = true;
                settings.recovery_shown.clone_from(&to);
            }
        })?;
        Self::forget_next_items(secrets);
        log::info!("I_SYNC_ICLOUD_SWITCHED vault={from} successor={to}");
        Ok(())
    }

    /// Deletes what is left of the vault this device rotated away from; a failure waits for the
    /// next connect.
    pub(super) fn clear_retired(&self) {
        let settings = self.settings.get();
        let Some((vault, retired)) = settings
            .icloud
            .as_ref()
            .filter(|state| !state.retired.is_empty())
            .map(|state| (state.vault.clone(), state.retired.clone()))
        else {
            return;
        };
        if let Err(code) = rotation::clear(self.kit.as_ref(), &retired) {
            log::warn!("W_SYNC_ICLOUD_RETIRED_CLEAR {code} vault={retired}");
            return;
        }
        let forgot = self.settings.update(|settings: &mut SyncSettings| {
            if let Some(state) = settings.icloud.as_mut().filter(|s| s.vault == vault) {
                state.retired.clear();
            }
        });
        if forgot.is_err() {
            log::warn!("W_SYNC_ICLOUD_RETIRED_FORGET vault={retired}");
        }
    }

    #[cfg(test)]
    fn quit_at(&self, step: &'static str) -> Result<(), &'static str> {
        let quits = self
            .quits_at
            .lock()
            .map_err(|_| "E_SYNC_INTERNAL")?
            .take_if(|at| *at == step);
        quits.map_or(Ok(()), |_| Err("E_TEST_QUIT"))
    }

    #[cfg(not(test))]
    fn quit_at(&self, _: &'static str) -> Result<(), &'static str> {
        Ok(())
    }
}
