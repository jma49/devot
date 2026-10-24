use zeroize::Zeroizing;

use super::SyncError;

/// Where sync keeps its secrets, by account name. The app's store is the [`Keychain`].
pub(crate) trait SecretStore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError>;
    /// Adds a new item; `false` when the account already holds one, which stays as it is. The check
    /// and the add are one step, so concurrent callers (also in other processes) cannot both add.
    fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError>;
    /// `false` when there was nothing to remove.
    fn remove(&self, account: &str) -> Result<bool, SyncError>;
}

/// Generic password items of the Security framework (the same API on macOS and iOS), under the
/// service `<folder identifier>.sync`, so a debug build (`.dev`) never reads the installed app's
/// vault. Items never sync through iCloud; on iOS they open after the first unlock and stay on the
/// device (never in a backup). Elsewhere the keychain is unavailable.
pub(crate) struct Keychain {
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
    use security_framework::passwords::{
        PasswordOptions, delete_generic_password_options, generic_password,
    };
    use zeroize::Zeroizing;

    use super::{Keychain, SecretStore, SyncError};

    // errSecItemNotFound, errSecDuplicateItem
    const NOT_FOUND: i32 = -25300;
    const DUPLICATE: i32 = -25299;

    fn options(keychain: &Keychain, account: &str) -> PasswordOptions {
        PasswordOptions::new_generic_password(&keychain.service, account)
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
            match generic_password(options(self, account)) {
                Ok(secret) => Ok(Some(Zeroizing::new(secret))),
                Err(error) if error.code() == NOT_FOUND => Ok(None),
                Err(error) => Err(SyncError::Keychain(error.code())),
            }
        }

        fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError> {
            match add_item(self, account, secret) {
                Ok(()) => Ok(true),
                Err(DUPLICATE) => Ok(false),
                Err(status) => Err(SyncError::Keychain(status)),
            }
        }

        fn remove(&self, account: &str) -> Result<bool, SyncError> {
            match delete_generic_password_options(options(self, account)) {
                Ok(()) => Ok(true),
                Err(error) if error.code() == NOT_FOUND => Ok(false),
                Err(error) => Err(SyncError::Keychain(error.code())),
            }
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

    fn remove(&self, _: &str) -> Result<bool, SyncError> {
        Err(SyncError::KeychainUnavailable)
    }
}
