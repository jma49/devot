//! Sync's keys, record encryption, pairing and the relay's client
//! (docs/adr/0002-sync-latest-state-per-record.md, Records; docs/adr/0004-sync-without-accounts.md;
//! docs/adr/0008-sync-device-pairing.md). A vault is a random ID and a 256-bit key, kept in the
//! keychain only; records are sealed here with AES-256-GCM in chunks a relay row can hold. The core
//! hands plaintext to Rust and gets plaintext back. No key, derived secret or device token ever
//! leaves Rust through a command; the page sees a pairing code while it is shown, and the recovery
//! key until this device says it was saved.

pub(crate) mod client;
pub(crate) mod commands;
mod crockford;
mod error;
pub(crate) mod file_record;
mod keychain;
mod pairing;
mod record;
mod recovery;
pub(crate) mod service;
pub(crate) mod settings;
mod vault;

pub(crate) use error::SyncError;
pub(crate) use keychain::{Keychain, SecretStore};
pub(crate) use record::{MAX_CHUNK_BYTES, MAX_RECORD_BYTES, chunk_count};
#[cfg(test)]
pub(crate) use vault::VaultId;
pub(crate) use vault::{Vault, enrollment_verifier};

/// A pairing code on show stops working when the Settings window that shows it goes away, which
/// runs no page cleanup.
pub(crate) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    use tauri::Manager as _;
    if !ends_pairing(window.label(), event) {
        return;
    }
    if let Some(sync) = window.try_state::<std::sync::Arc<service::SyncService>>() {
        let sync = std::sync::Arc::clone(&sync);
        tauri::async_runtime::spawn_blocking(move || sync.pairing_cancel());
    }
}

fn ends_pairing(label: &str, event: &tauri::WindowEvent) -> bool {
    label == crate::settings::LABEL && matches!(event, tauri::WindowEvent::Destroyed)
}

#[cfg(test)]
mod attachment_relay_tests;
#[cfg(test)]
mod pairing_relay_tests;
#[cfg(test)]
mod pairing_tests;
#[cfg(test)]
mod relay_tests;
#[cfg(test)]
mod tests;
