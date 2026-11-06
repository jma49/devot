//! Generic password items of the Security framework, the same API on macOS and iOS. A failure is
//! the keychain's status, which each caller turns into its own error code.

use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
use security_framework::passwords::{
    PasswordOptions, delete_generic_password_options, generic_password,
    set_generic_password_options,
};

/// `errSecItemNotFound`.
pub const ITEM_NOT_FOUND: i32 = -25300;
/// `errSecDuplicateItem`.
pub const DUPLICATE_ITEM: i32 = -25299;

#[derive(Debug, Clone, Copy)]
pub struct Item<'a> {
    pub service: &'a str,
    pub account: &'a str,
}

impl Item<'_> {
    fn options(&self) -> PasswordOptions {
        PasswordOptions::new_generic_password(self.service, self.account)
    }

    /// Whether the item exists, without reading its secret: no secret in memory and no access
    /// prompt.
    pub fn has(&self) -> Result<bool, i32> {
        match ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(self.service)
            .account(self.account)
            .load_attributes(true)
            .limit(Limit::Max(1))
            .search()
        {
            Ok(found) => Ok(!found.is_empty()),
            Err(e) if e.code() == ITEM_NOT_FOUND => Ok(false),
            Err(e) => Err(e.code()),
        }
    }

    pub fn get(&self) -> Result<Option<Vec<u8>>, i32> {
        match generic_password(self.options()) {
            Ok(secret) => Ok(Some(secret)),
            Err(e) if e.code() == ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(e.code()),
        }
    }

    /// Adds the item, or updates the one that exists.
    pub fn set(&self, secret: &[u8]) -> Result<(), i32> {
        set_generic_password_options(secret, self.options()).map_err(|e| e.code())
    }

    /// `false` when there was nothing to remove.
    pub fn delete(&self) -> Result<bool, i32> {
        match delete_generic_password_options(self.options()) {
            Ok(()) => Ok(true),
            Err(e) if e.code() == ITEM_NOT_FOUND => Ok(false),
            Err(e) => Err(e.code()),
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Touches the real login keychain, so it runs only when asked: `cargo test -- --ignored keychain`.
    #[test]
    #[ignore = "uses the login keychain"]
    fn keychain_round_trip() {
        let service = format!("io.github.jma49.devot.test-{}", uuid::Uuid::new_v4());
        let item = Item {
            service: &service,
            account: "round-trip",
        };
        struct Cleanup<'a>(Item<'a>);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete();
            }
        }
        let _cleanup = Cleanup(item);
        assert_eq!(item.get(), Ok(None));
        assert_eq!(item.has(), Ok(false));
        item.set(b"first").unwrap();
        assert_eq!(item.has(), Ok(true));
        item.set(b"second").unwrap();
        assert_eq!(item.get(), Ok(Some(b"second".to_vec())));
        assert_eq!(item.delete(), Ok(true));
        assert_eq!(item.delete(), Ok(false));
        assert_eq!(item.get(), Ok(None));
        assert_eq!(item.has(), Ok(false));
    }
}
