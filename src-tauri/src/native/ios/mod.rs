//! iOS's native code: UIKit calls through objc2, one keychain call and the StoreKit bridge; and
//! CloudKit (`cloudkit`), which macOS compiles from here too, so that it is written once. Every
//! call runs inside `guarded`, which catches an Objective-C exception as well as a Rust panic, and
//! every object the system may withhold is checked for nil; a failure gives the caller's fallback.
//! The exception is building zone and record IDs, from names the transport has already checked.

#[cfg(target_os = "ios")]
mod icloud;
#[cfg(target_os = "ios")]
mod keychain;
#[cfg(target_os = "ios")]
mod store;
#[cfg(target_os = "ios")]
mod uikit;

/// CloudKit through objc2 (`sync::cloudkit::kit`), the same on macOS and iOS, so macOS compiles it
/// from here as well; each platform says whether the build holds the container (`macos::cloudkit`,
/// `cloudkit::from_info_plist`). Every call runs inside `guarded`, and every operation's answer is
/// awaited off the main thread with a time limit, after which the operation is cancelled.
pub(crate) mod cloudkit;

/// Synchronizable generic password items (`sync::keychain::SyncedKeychain`), the same on macOS and
/// iOS, so macOS compiles them from here too: in the data protection keychain and an access group,
/// readable after the first unlock, carried to the owner's other devices by the iCloud Keychain.
/// A failure gives its `OSStatus`.
pub(crate) mod synced_keychain;

#[cfg(target_os = "ios")]
pub(crate) use icloud::receive_icloud_notices;
#[cfg(target_os = "ios")]
pub use keychain::add_device_only_password;
#[cfg(target_os = "ios")]
pub use store::{
    store_entitlements, store_finish, store_listen, store_products, store_purchase, store_refund,
    store_restore,
};
#[cfg(target_os = "ios")]
pub use uikit::{haptic, open_url, set_interface_style, symbol_png};
