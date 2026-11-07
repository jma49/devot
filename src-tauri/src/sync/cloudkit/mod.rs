//! Sync through the owner's iCloud (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md):
//! the transport logic in safe Rust over a small set of CloudKit primitives ([`kit::CloudKit`]),
//! which `native::macos` and `native::ios` implement through objc2-cloud-kit and a fake implements
//! in tests. CloudKit stores records sealed under the vault key, never plaintext or the key.

mod batch;
pub(crate) mod current;
mod encoding;
pub(crate) mod error;
pub(crate) mod kit;
pub(crate) mod pairing;
pub(crate) mod rotation;
pub(crate) mod staging;
mod transport;

pub(crate) use kit::CloudKit;
pub(crate) use staging::Staging;
pub(crate) use transport::{
    DeviceRow, ICloud, ICloudState, Item, PushAnswer, Welcome, account_of, devices,
};

/// The CloudKit this build has: the platform's, or none off Apple's platforms.
pub(crate) fn platform() -> std::sync::Arc<dyn CloudKit> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        crate::native::cloudkit()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        std::sync::Arc::new(kit::Unavailable)
    }
}

#[cfg(test)]
pub(crate) mod fake;
#[cfg(test)]
mod tests;
