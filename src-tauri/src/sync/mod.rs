//! Sync's keys and record encryption (docs/adr/0002-sync-latest-state-per-record.md, Records;
//! docs/adr/0004-sync-without-accounts.md). A vault is a random ID and a 256-bit key, kept in the
//! keychain only; records are sealed here with AES-256-GCM in chunks a relay row can hold. Nothing
//! in this module is reachable from the web view: the core hands plaintext to Rust and gets
//! plaintext back, and no key, secret or recovery key ever leaves Rust through a command.

mod error;
mod keychain;
mod record;
mod recovery;
mod vault;

pub(crate) use error::SyncError;
pub(crate) use keychain::{Keychain, SecretStore};
pub(crate) use record::{MAX_CHUNK_BYTES, MAX_RECORD_BYTES};
pub(crate) use vault::{Vault, VaultId, enrollment_verifier};

#[cfg(test)]
mod tests;
