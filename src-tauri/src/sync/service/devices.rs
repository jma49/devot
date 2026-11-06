#[cfg(test)]
use std::sync::atomic::Ordering;

use super::super::client::{self, Connection, DeviceInfo, RelayUsage};
use super::super::cloudkit;
use super::super::cloudkit::current;
use super::super::settings::{DeviceCredentials, RelayDevice, Unseen};
use super::SyncService;

impl SyncService {
    /// The vault's devices. Not gated by the licence: seeing and removing access never is. On
    /// iCloud they are its device rows, each with the day it was last seen in `created`, then the
    /// relay's devices not seen there since this device moved the vault, which leave once seen.
    pub(crate) fn devices(&self) -> Result<Vec<DeviceInfo>, &'static str> {
        let vault = self.held_vault()?;
        let id = vault.id().to_string();
        let settings = self.settings.get();
        let Some(state) = settings.icloud_for(&id) else {
            return self.with_connection(client::devices);
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

    /// Removes a device from the vault: the relay revokes its token and closes its sockets. This
    /// device cannot remove itself.
    pub(crate) fn remove_device(&self, device: &str) -> Result<Vec<DeviceInfo>, &'static str> {
        let own = DeviceCredentials::load(self.secrets.as_ref())
            .map_err(|e| e.code())?
            .map(|c| c.device);
        if own.as_deref() == Some(device) {
            return Err("E_SYNC_DEVICE_SELF");
        }
        self.with_connection(|connection| {
            client::revoke(connection, device)?;
            log::info!("I_SYNC_DEVICE_REMOVED device={device}");
            client::devices(connection)
        })
    }
}
