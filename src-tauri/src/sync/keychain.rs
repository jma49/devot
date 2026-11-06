use zeroize::Zeroizing;

use super::SyncError;

/// Where sync keeps its secrets, by account name. The app's store is the [`Keychain`].
pub(crate) trait SecretStore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError>;
    /// Adds a new item; `false` when the account already holds one, which stays as it is. The check
    /// and the add are one step, so concurrent callers (also in other processes) cannot both add.
    fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError>;
    /// Sets the account's item, updating one that exists in place, so a failure leaves the old item.
    fn replace(&self, account: &str, secret: &[u8]) -> Result<(), SyncError>;
    /// `false` when there was nothing to remove.
    fn remove(&self, account: &str) -> Result<bool, SyncError>;
}

/// Generic password items of the Security framework (the same API on macOS and iOS), under the
/// service `<folder identifier>.sync`, so a debug build (`.dev`) never reads the installed app's
/// vault. Items never sync through iCloud; on iOS they open after the first unlock and stay on the
/// device (never in a backup). Elsewhere the keychain is unavailable.
pub(crate) struct Keychain {
    #[cfg_attr(
        all(not(test), not(any(target_os = "macos", target_os = "ios"))),
        expect(dead_code, reason = "only the Security framework reads it")
    )]
    service: String,
}

impl Keychain {
    pub(crate) fn for_app(folder_identifier: &str) -> Self {
        Self {
            service: format!("{folder_identifier}.sync"),
        }
    }

    #[cfg(test)]
    pub(crate) fn service(&self) -> &str {
        &self.service
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use zeroize::Zeroizing;

    use super::{Keychain, SecretStore, SyncError};
    use crate::keychain::{DUPLICATE_ITEM as DUPLICATE, Item};

    fn item<'a>(keychain: &'a Keychain, account: &'a str) -> Item<'a> {
        Item {
            service: &keychain.service,
            account,
        }
    }

    // The password API's setter updates an existing item, so the add calls `SecItemAdd` itself. An
    // access control on macOS would move the item to the data protection keychain, which unsigned
    // builds cannot use, so it keeps the default keychain's access.
    #[cfg(target_os = "macos")]
    fn add_item(keychain: &Keychain, account: &str, secret: &[u8]) -> Result<(), i32> {
        use security_framework::item::{ItemAddOptions, ItemAddValue, ItemClass};
        ItemAddOptions::new(ItemAddValue::Data {
            class: ItemClass::generic_password(),
            data: core_foundation::data::CFData::from_buffer(secret),
        })
        .set_service(&keychain.service)
        .set_account_name(account)
        .add()
        .map_err(|error| error.code())
    }

    #[cfg(target_os = "ios")]
    fn add_item(keychain: &Keychain, account: &str, secret: &[u8]) -> Result<(), i32> {
        crate::native::ios::add_device_only_password(&keychain.service, account, secret)
    }

    impl SecretStore for Keychain {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
            item(self, account)
                .get()
                .map(|secret| secret.map(Zeroizing::new))
                .map_err(SyncError::Keychain)
        }

        fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError> {
            match add_item(self, account, secret) {
                Ok(()) => Ok(true),
                Err(DUPLICATE) => Ok(false),
                Err(status) => Err(SyncError::Keychain(status)),
            }
        }

        fn replace(&self, account: &str, secret: &[u8]) -> Result<(), SyncError> {
            match add_item(self, account, secret) {
                Ok(()) => Ok(()),
                Err(DUPLICATE) => item(self, account).set(secret).map_err(SyncError::Keychain),
                Err(status) => Err(SyncError::Keychain(status)),
            }
        }

        fn remove(&self, account: &str) -> Result<bool, SyncError> {
            item(self, account).delete().map_err(SyncError::Keychain)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
impl SecretStore for Keychain {
    fn read(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
        Err(SyncError::KeychainUnavailable)
    }

    fn add(&self, _: &str, _: &[u8]) -> Result<bool, SyncError> {
        Err(SyncError::KeychainUnavailable)
    }

    fn replace(&self, _: &str, _: &[u8]) -> Result<(), SyncError> {
        Err(SyncError::KeychainUnavailable)
    }

    fn remove(&self, _: &str) -> Result<bool, SyncError> {
        Err(SyncError::KeychainUnavailable)
    }
}

/// The keychain group the Mac and the iPhone app share (`keychain-access-groups`).
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ACCESS_GROUP: &str = "WMG3HG38DV.io.github.jma49.devot";
/// `errSecMissingEntitlement`: what a build without the access group would get from the keychain.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const MISSING_ENTITLEMENT: i32 = -34018;

/// The iCloud Keychain's handover item (`sync::handover`): a synchronizable generic password in the
/// access group the Mac and the iPhone app share, in the data protection keychain, readable after
/// the first unlock, under `service`. Only a build with Devot's iCloud entitlements may use it; any
/// other reads nothing and writes nothing.
pub(crate) struct SyncedKeychain {
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "ios")),
        expect(dead_code, reason = "only the Security framework reads them")
    )]
    service: &'static str,
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "ios")),
        expect(dead_code, reason = "only the Security framework reads them")
    )]
    available: bool,
}

impl SyncedKeychain {
    /// `available` is whether this build carries the iCloud entitlements, the access group among them.
    pub(crate) fn new(service: &'static str, available: bool) -> Self {
        Self { service, available }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl SecretStore for SyncedKeychain {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
        if !self.available {
            return Ok(None);
        }
        crate::native::ios::synced_keychain::read(self.service, account, ACCESS_GROUP)
            .map(|item| item.map(Zeroizing::new))
            .map_err(SyncError::Keychain)
    }

    fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError> {
        if !self.available {
            return Err(SyncError::Keychain(MISSING_ENTITLEMENT));
        }
        crate::native::ios::synced_keychain::add(self.service, account, ACCESS_GROUP, secret)
            .map_err(SyncError::Keychain)
    }

    fn replace(&self, account: &str, secret: &[u8]) -> Result<(), SyncError> {
        if !self.add(account, secret)? {
            crate::native::ios::synced_keychain::update(
                self.service,
                account,
                ACCESS_GROUP,
                secret,
            )
            .map_err(SyncError::Keychain)?;
        }
        Ok(())
    }

    fn remove(&self, account: &str) -> Result<bool, SyncError> {
        if !self.available {
            return Ok(false);
        }
        crate::native::ios::synced_keychain::delete(self.service, account, ACCESS_GROUP)
            .map_err(SyncError::Keychain)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
impl SecretStore for SyncedKeychain {
    fn read(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
        Ok(None)
    }

    fn add(&self, _: &str, _: &[u8]) -> Result<bool, SyncError> {
        Err(SyncError::KeychainUnavailable)
    }

    fn replace(&self, _: &str, _: &[u8]) -> Result<(), SyncError> {
        Err(SyncError::KeychainUnavailable)
    }

    fn remove(&self, _: &str) -> Result<bool, SyncError> {
        Ok(false)
    }
}
