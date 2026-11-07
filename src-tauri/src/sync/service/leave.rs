//! Leaving a relay vault: the way out for a device stuck on a vault it cannot use, such as one
//! removed before a rotation or one whose relay is gone (docs/adr/0008-sync-device-pairing.md,
//! Leaving a relay vault). Only this device changes: the relay and the other devices keep the vault.

use super::super::settings::DeviceCredentials;
use super::super::{SyncError, Vault};
use super::{Snapshot, SyncService};

const LEAVE_ICLOUD: &str = "E_SYNC_LEAVE_ICLOUD";

impl SyncService {
    /// Forgets the vault key, this device's token and a rotation's waiting items here, and turns
    /// sync off; the notes stay. Not gated by the licence. Waits for a connect or a move to iCloud
    /// under way. Sync turns off first and the vault item goes last, so a failure part way keeps the
    /// key and a retry ends the same. The next connect shows the engine a new epoch, so a join
    /// afterwards uploads the whole library, even into the vault left.
    pub(crate) fn leave_vault(&self) -> Result<Snapshot, &'static str> {
        let _membership = self.membership.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        let _switching = self.switching.lock().map_err(|_| "E_SYNC_INTERNAL")?;
        let vault = self.held_vault()?;
        let id = vault.id().to_string();
        let mut settings = self.settings.get();
        if settings.icloud_for(&id).is_some() {
            return Err(LEAVE_ICLOUD);
        }
        self.pairing_cancel();
        self.disconnect();
        settings.enabled = false;
        settings.call_off_move();
        settings.leaves = settings.leaves.saturating_add(1);
        self.settings.set(&settings)?;
        self.forget_here(&id).inspect_err(|_| {
            self.changed();
        })?;
        log::info!("I_SYNC_LEFT vault={id}");
        Ok(self.changed())
    }

    fn forget_here(&self, id: &str) -> Result<(), &'static str> {
        let secrets = self.secrets.as_ref();
        let forgotten = |step: Result<(), SyncError>| {
            step.map_err(|e| {
                log::warn!("W_SYNC_LEAVE_FORGET {e} vault={id}");
                e.code()
            })
        };
        forgotten(Vault::delete_next(secrets).map(drop))?;
        forgotten(DeviceCredentials::forget_next(secrets))?;
        forgotten(DeviceCredentials::forget(secrets))?;
        forgotten(Vault::delete(secrets).map(drop))?;
        self.settings.update(|settings| {
            settings.rotating = None;
            settings.rotated = None;
            if settings.recovery_shown == id {
                settings.recovery_shown.clear();
            }
        })
    }
}
