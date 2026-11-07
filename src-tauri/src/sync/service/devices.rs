#[cfg(test)]
use std::sync::atomic::Ordering;

use super::super::client::{self, Connection, DeviceInfo, RelayUrl, RelayUsage};
use super::super::cloudkit;
use super::super::cloudkit::current;
use super::super::settings::{DeviceCredentials, RelayDevice, Unseen};
use super::SyncService;

impl SyncService {
    /// The vault's devices. Not gated by the licence: seeing and removing access never is. On a
    /// relay, after a rotation this device made, the retired vault's devices that have not joined
    /// follow. On iCloud they are its device rows, each with the day it was last seen in `created`,
    /// then the relay's devices not seen there since this device moved the vault, which leave once
    /// seen.
    pub(crate) fn devices(&self) -> Result<Vec<DeviceInfo>, &'static str> {
        let vault = self.held_vault()?;
        let id = vault.id().to_string();
        let settings = self.settings.get();
        let Some(state) = settings.icloud_for(&id) else {
            let mut devices = self.with_connection(client::devices)?;
            devices.extend(self.not_joined(&id));
            return Ok(devices);
        };
        current::ready(self.kit.as_ref())?;
        let rows = cloudkit::devices(self.kit.as_ref(), &vault, &state.device)?;
        let unseen = self.still_unseen(&id, &rows);
        let mut devices: Vec<DeviceInfo> = rows.into_iter().map(|row| row.info).collect();
        devices.extend(unseen.into_iter().map(|device| DeviceInfo {
            id: device.id,
            label: device.label,
            created: device.created,
            current: false,
            unseen: true,
        }));
        Ok(devices)
    }

    /// The relay devices kept for `vault` that no row of `rows` names, kept again without the rest.
    fn still_unseen(&self, vault: &str, rows: &[cloudkit::DeviceRow]) -> Vec<RelayDevice> {
        let not_seen = |device: &RelayDevice| !rows.iter().any(|row| row.relay == device.id);
        let kept = self.settings.get().unseen.filter(|u| u.vault == vault);
        let Some(kept) = kept else {
            return Vec::new();
        };
        let count = kept.devices.len();
        let left: Vec<RelayDevice> = kept.devices.into_iter().filter(not_seen).collect();
        if left.len() != count {
            let saved = self.settings.update(|settings| {
                if let Some(unseen) = settings.unseen.as_mut().filter(|u| u.vault == vault) {
                    unseen.devices.retain(not_seen);
                    if unseen.devices.is_empty() {
                        settings.unseen = None;
                    }
                }
            });
            if let Err(code) = saved {
                log::warn!("W_SYNC_UNSEEN_SAVE {code} vault={vault}");
            }
        }
        left
    }

    /// Keeps the relay's other devices as `connection` lists them, before the moved marker stops
    /// them, so Settings can name those not seen on iCloud yet. A list the relay does not give
    /// keeps none and does not stop the move.
    pub(super) fn keep_unseen(&self, connection: &Connection, vault: &str) {
        let listed = client::devices(connection);
        #[cfg(test)]
        let listed = if self.fails_device_list.swap(false, Ordering::Relaxed) {
            Err("E_TEST_DEVICES")
        } else {
            listed
        };
        let devices = match listed {
            Ok(devices) => devices
                .into_iter()
                .filter(|device| !device.current)
                .map(|device| RelayDevice {
                    id: device.id,
                    label: device.label,
                    created: device.created,
                })
                .collect::<Vec<_>>(),
            Err(code) => {
                log::warn!("W_SYNC_MOVE_DEVICES {code} vault={vault}");
                Vec::new()
            }
        };
        let saved = self.settings.update(|settings| {
            settings.unseen = (!devices.is_empty()).then(|| Unseen {
                vault: vault.to_string(),
                devices,
            });
        });
        if let Err(code) = saved {
            log::warn!("W_SYNC_UNSEEN_SAVE {code} vault={vault}");
        }
    }

    /// What the relay holds and may hold. Read-only and not gated by the licence, like the devices.
    pub(crate) fn usage(&self) -> Result<RelayUsage, &'static str> {
        self.with_connection(client::usage)
    }

    /// Removes a device from the vault: the relay revokes its token and closes its sockets. A device
    /// of the vault this device retired that has not joined is removed from that vault, so it leaves
    /// the list. This device cannot remove itself.
    pub(crate) fn remove_device(&self, device: &str) -> Result<Vec<DeviceInfo>, &'static str> {
        let secrets = self.secrets.as_ref();
        let own = DeviceCredentials::load(secrets)
            .map_err(|e| e.code())?
            .map(|c| c.device);
        let retired = self.retired_credentials();
        if own.as_deref() == Some(device) || retired.as_ref().is_some_and(|c| c.device == device) {
            return Err("E_SYNC_DEVICE_SELF");
        }
        match (self.with_connection(|c| client::revoke(c, device)), retired) {
            (Err(NO_DEVICE), Some(retired)) => {
                with_retired(&retired, |c| client::revoke(c, device))?;
                log::info!(
                    "I_SYNC_RETIRED_DEVICE_REMOVED vault={} device={device}",
                    retired.vault
                );
            }
            (removed, _) => {
                removed?;
                log::info!("I_SYNC_DEVICE_REMOVED device={device}");
            }
        }
        self.devices()
    }

    /// The token this device kept for the vault it retired, while that vault is the one the held
    /// vault succeeded on this relay.
    fn retired_credentials(&self) -> Option<DeviceCredentials> {
        let relay = self.relay().ok()?;
        let held = self.held_vault().ok()?.id().to_string();
        DeviceCredentials::load_retired(self.secrets.as_ref())
            .ok()
            .flatten()
            .filter(|c| c.relay == relay.as_str() && c.vault != held)
    }

    /// The devices of the vault this device retired, other than this one, that have not joined the
    /// successor: a device that joins removes itself there. The token goes once none is left, or
    /// once the relay no longer takes it; a relay that cannot be reached lists none this time.
    fn not_joined(&self, held: &str) -> Vec<DeviceInfo> {
        let Some(retired) = self.retired_credentials() else {
            return Vec::new();
        };
        let listed = with_retired(&retired, client::devices);
        let left: Vec<DeviceInfo> = match listed {
            Ok(devices) => devices
                .into_iter()
                .filter(|device| !device.current)
                .map(|device| DeviceInfo {
                    unseen: true,
                    ..device
                })
                .collect(),
            Err(code @ ("E_SYNC_REVOKED" | "E_SYNC_UNAUTHORIZED" | "E_SYNC_NO_VAULT")) => {
                log::info!("I_SYNC_RETIRED_GONE {code} vault={}", retired.vault);
                Vec::new()
            }
            Err(code) => {
                log::warn!("W_SYNC_RETIRED_DEVICES {code} vault={}", retired.vault);
                return Vec::new();
            }
        };
        if left.is_empty() {
            match DeviceCredentials::forget_retired(self.secrets.as_ref()) {
                Ok(()) => log::info!(
                    "I_SYNC_RETIRED_FORGOTTEN vault={} successor={held}",
                    retired.vault
                ),
                Err(e) => log::warn!("W_SYNC_RETIRED_FORGET {e} vault={}", retired.vault),
            }
        }
        left
    }

    /// After this device joined a vault in place of a retired one: removes this device from the
    /// retired vault with its old token, so the rotating device no longer lists it as not joined.
    pub(super) fn leave_retired(&self, old: &DeviceCredentials) {
        match with_retired(old, |c| client::revoke(c, &old.device)) {
            Ok(()) | Err(NO_DEVICE) => {
                log::info!(
                    "I_SYNC_RETIRED_LEFT vault={} device={}",
                    old.vault,
                    old.device
                );
            }
            Err(code) => log::warn!("W_SYNC_RETIRED_LEAVE {code} vault={}", old.vault),
        }
    }
}

const NO_DEVICE: &str = "E_SYNC_NO_DEVICE";

/// Runs `work` on a connection of its own to the retired vault `credentials` names.
fn with_retired<T>(
    credentials: &DeviceCredentials,
    work: impl FnOnce(&Connection) -> Result<T, &'static str>,
) -> Result<T, &'static str> {
    let relay = RelayUrl::parse(&credentials.relay)?;
    let (connection, _) = Connection::open(
        &relay,
        &credentials.vault,
        &credentials.token,
        Box::new(|_| {}),
    )?;
    let result = work(&connection);
    connection.close();
    result
}
