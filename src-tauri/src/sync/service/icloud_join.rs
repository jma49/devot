use super::super::cloudkit::current;
use super::super::{Vault, handover};
use super::{ICloudJoinView, Snapshot, SyncService};

/// What a look for the Apple ID's vault found.
enum Found {
    /// This device holds a vault, and never joins another.
    Held,
    View(ICloudJoinView),
    /// The handover item names the vault `current` names.
    Vault(Box<Vault>),
}

impl SyncService {
    /// Leaves `vault`, which `current` names, in the handover item for this Apple ID's other
    /// devices. The device-only item is this device's copy, so a failure here is only logged.
    pub(super) fn hand_over(&self, vault: &Vault) {
        let there = handover::read(self.handover.as_ref())
            .ok()
            .flatten()
            .is_some_and(|item| item.same(vault));
        if !there {
            self.write_handover(vault);
        }
    }

    /// At each connect, writes the item a first write left missing, and one naming another vault
    /// (or damaged) while `current` names this one. A later build's item is left as it is.
    pub(super) fn hand_over_at_connect(&self, vault: &Vault) {
        let named = match handover::read(self.handover.as_ref()) {
            Ok(None) => return self.write_handover(vault),
            Ok(Some(item)) if item.same(vault) => return,
            Ok(Some(item)) => Some(item.id()),
            Err(super::super::SyncError::HandoverCorrupt) => None,
            Err(_) => return,
        };
        let id = vault.id().to_string();
        if current::read(self.kit.as_ref()).is_ok_and(|current| current.as_deref() == Some(&id)) {
            match named {
                Some(other) => log::info!("I_SYNC_HANDOVER_REWRITTEN item={other} vault={id}"),
                None => log::info!("I_SYNC_HANDOVER_REWRITTEN vault={id}"),
            }
            self.write_handover(vault);
        }
    }

    /// The device now signed in to another Apple ID takes the vault's item off this device, so its
    /// copy does not stay in that Apple ID's iCloud Keychain. An Apple ID whose `current` names the
    /// vault (or that cannot be read) keeps it: the item is its own. The device-only item stays.
    pub(super) fn forget_handover(&self, vault: &Vault) {
        let id = vault.id().to_string();
        let elsewhere = current::read(self.kit.as_ref())
            .is_ok_and(|current| current.as_deref() != Some(id.as_str()));
        if !elsewhere {
            return;
        }
        match handover::remove(self.handover.as_ref(), vault) {
            Ok(true) => log::info!("I_SYNC_HANDOVER_REMOVED vault={id}"),
            Ok(false) => {}
            Err(e) => log::warn!("W_SYNC_HANDOVER_REMOVE {e} vault={id}"),
        }
    }

    pub(super) fn write_handover(&self, vault: &Vault) {
        if let Err(e) = handover::write(self.handover.as_ref(), vault) {
            log::warn!("W_SYNC_HANDOVER_WRITE {e} vault={}", vault.id());
        }
    }

    /// Looks for the Apple ID's vault, as at launch and when the account changes. A device that
    /// holds no vault joins it on its own when the handover item names it and the library holds no
    /// `notes`; with notes it asks, once. Declined, or with no item, Settings offers the fallback.
    pub(crate) fn icloud_look(&self, notes: u64) -> Result<Snapshot, &'static str> {
        let view = match self.find() {
            Found::Held => return Ok(self.snapshot()),
            Found::View(view) => view,
            Found::Vault(vault) => {
                if self.settings.get().icloud_declined == vault.id().to_string() {
                    ICloudJoinView::is("declined")
                } else if notes > 0 {
                    ICloudJoinView {
                        notes: Some(notes),
                        ..ICloudJoinView::is("ask")
                    }
                } else {
                    let vault = self.keep_icloud(*vault, true)?;
                    log::info!("I_SYNC_JOINED vault={} via=keychain", vault.id());
                    ICloudJoinView::is("joined")
                }
            }
        };
        self.set_look(view);
        Ok(self.changed())
    }

    /// The owner's answer to the question `icloud_look` asked: join, or leave sync off and the offer
    /// in Settings. The item and `current` are read again, so the answer applies to the vault they
    /// name now.
    pub(crate) fn icloud_join(&self, accept: bool) -> Result<Snapshot, &'static str> {
        let vault = match self.find() {
            Found::Held => return Err("E_SYNC_VAULT_EXISTS"),
            Found::View(view) => {
                self.set_look(view);
                return Ok(self.changed());
            }
            Found::Vault(vault) => *vault,
        };
        let view = if accept {
            let vault = self.keep_icloud(vault, true)?;
            log::info!("I_SYNC_JOINED vault={} via=keychain", vault.id());
            ICloudJoinView::is("joined")
        } else {
            let mut settings = self.settings.get();
            settings.icloud_declined = vault.id().to_string();
            self.settings.set(&settings)?;
            log::info!("I_SYNC_ICLOUD_DECLINED vault={}", vault.id());
            ICloudJoinView::is("declined")
        };
        self.set_look(view);
        Ok(self.changed())
    }

    fn find(&self) -> Found {
        match Vault::load(self.secrets.as_ref()) {
            Ok(Some(_)) => return Found::Held,
            Ok(None) => {}
            Err(e) => return Found::View(ICloudJoinView::unavailable(e.code())),
        }
        if let Err(code) = self.licence.require() {
            return Found::View(ICloudJoinView::unavailable(code));
        }
        let kit = self.kit.as_ref();
        let current = match current::ready(kit).and_then(|()| current::read(kit)) {
            Ok(Some(current)) => current,
            Ok(None) => return Found::View(ICloudJoinView::is("none")),
            Err(code) => return Found::View(ICloudJoinView::unavailable(code)),
        };
        Found::View(match handover::read(self.handover.as_ref()) {
            Ok(Some(vault)) if vault.id().to_string() == current => {
                return Found::Vault(Box::new(vault));
            }
            Ok(Some(vault)) => {
                log::info!(
                    "I_SYNC_HANDOVER_OTHER item={} current={current}",
                    vault.id()
                );
                ICloudJoinView::fallback("otherVault", None)
            }
            Ok(None) => ICloudJoinView::fallback("missing", None),
            Err(e) => {
                log::warn!("W_SYNC_HANDOVER_UNREADABLE {e}");
                ICloudJoinView::fallback("unreadable", Some(e.code()))
            }
        })
    }

    fn set_look(&self, view: ICloudJoinView) {
        if let Ok(mut look) = self.look.lock() {
            *look = Some(view);
        }
    }
}
