use zeroize::Zeroizing;

use super::SyncError;

/// Where sync keeps its secrets, by account name. The app's store is the [`Keychain`].
pub(crate) trait SecretStore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError>;
    fn add(&self, account: &str, secret: &[u8]) -> Result<(), SyncError>;
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

    pub(crate) fn service(&self) -> &str {
        &self.service
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use security_framework::passwords::{
        PasswordOptions, delete_generic_password_options, generic_password,
        set_generic_password_options,
    };
    use zeroize::Zeroizing;

    use super::{Keychain, SecretStore, SyncError};

    // errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    fn options(keychain: &Keychain, account: &str) -> PasswordOptions {
        PasswordOptions::new_generic_password(&keychain.service, account)
    }

    impl SecretStore for Keychain {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
            match generic_password(options(self, account)) {
                Ok(secret) => Ok(Some(Zeroizing::new(secret))),
                Err(error) if error.code() == NOT_FOUND => Ok(None),
                Err(error) => Err(SyncError::Keychain(error.code())),
            }
        }

        fn add(&self, account: &str, secret: &[u8]) -> Result<(), SyncError> {
            #[allow(unused_mut)]
            let mut options = options(self, account);
            // The data protection class needs no entitlement on iOS; on macOS an access control
            // would move the item to the data protection keychain, which unsigned builds cannot use.
            #[cfg(target_os = "ios")]
            {
                use security_framework::access_control::{ProtectionMode, SecAccessControl};
                let access = SecAccessControl::create_with_protection(
                    Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                    0,
                )
                .map_err(|error| SyncError::Keychain(error.code()))?;
                options.set_access_control(access);
            }
            set_generic_password_options(secret, options)
                .map_err(|error| SyncError::Keychain(error.code()))
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

    fn add(&self, _: &str, _: &[u8]) -> Result<(), SyncError> {
        Err(SyncError::KeychainUnavailable)
    }

    fn remove(&self, _: &str) -> Result<bool, SyncError> {
        Err(SyncError::KeychainUnavailable)
    }
}
