//! Sync's keys, record encryption and the relay's client (docs/adr/0002-sync-latest-state-per-record.md, Records;
//! docs/adr/0004-sync-without-accounts.md). A vault is a random ID and a 256-bit key, kept in the
//! keychain only; records are sealed here with AES-256-GCM in chunks a relay row can hold. Nothing
//! in this module is reachable from the web view: the core hands plaintext to Rust and gets
//! plaintext back, and no key, secret, device token or recovery key ever leaves Rust through a
//! command.

pub(crate) mod client;
pub(crate) mod commands;
mod error;
mod keychain;
mod record;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the recovery key's sheet and pairing (#336) are its callers"
    )
)]
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
mod relay_tests;
#[cfg(test)]
mod tests;
