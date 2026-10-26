//! Sync's keys, record encryption, pairing and the relay's client
//! (docs/adr/0002-sync-latest-state-per-record.md, Records; docs/adr/0004-sync-without-accounts.md;
//! docs/adr/0008-sync-device-pairing.md). A vault is a random ID and a 256-bit key, kept in the
//! keychain only; records are sealed here with AES-256-GCM in chunks a relay row can hold. The core
//! hands plaintext to Rust and gets plaintext back. No key, derived secret or device token ever
//! leaves Rust through a command; the page sees a pairing code while it is shown, and the recovery
//! key once, when turning sync on makes the vault.

pub(crate) mod client;
pub(crate) mod commands;
mod crockford;
mod error;
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

#[cfg(test)]
mod pairing_relay_tests;
#[cfg(test)]
mod pairing_tests;
#[cfg(test)]
mod relay_tests;
#[cfg(test)]
mod tests;
