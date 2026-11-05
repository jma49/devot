//! The handover item (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md, Devices on
//! one Apple ID join without a code): an iCloud vault's ID and key in a synchronizable keychain
//! item, which the iCloud Keychain carries to the owner's other devices. Beside the device-only
//! item it is the one place the key is kept; a vault on a relay never writes it.
//!
//! `version (1) || vault ID (16) || vault key (32) || transport (1)`, the transport `1` for iCloud.

use zeroize::Zeroizing;

use super::keychain::SyncedKeychain;
use super::vault::{ID_BYTES, KEY_BYTES, VaultId};
use super::{SecretStore, SyncError, Vault};

pub(crate) const SERVICE: &str = "io.github.jma49.devot.sync.icloud";
pub(crate) const ACCOUNT: &str = "vault";
const VERSION: u8 = 1;
const ICLOUD: u8 = 1;
const BYTES: usize = 1 + ID_BYTES + KEY_BYTES + 1;

/// The iCloud Keychain of this build: usable only with Devot's iCloud entitlements, which carry the
/// keychain group as well as the container.
pub(crate) fn platform() -> SyncedKeychain {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let available = crate::native::holds_icloud_container();
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let available = false;
    SyncedKeychain::new(SERVICE, available)
}

pub(crate) fn encode(vault: &Vault) -> Zeroizing<Vec<u8>> {
    let mut item = Zeroizing::new(Vec::with_capacity(BYTES));
    item.push(VERSION);
    item.extend_from_slice(vault.id().as_bytes());
    item.extend_from_slice(vault.key());
    item.push(ICLOUD);
    item
}

/// The vault an item holds. A version this build does not know is refused before anything else
/// is read, so a later format is never misread as this one.
pub(crate) fn decode(item: &[u8]) -> Result<Vault, SyncError> {
    match item.first() {
        None => return Err(SyncError::HandoverCorrupt),
        Some(&VERSION) => {}
        Some(_) => return Err(SyncError::HandoverVersion),
    }
    if item.len() != BYTES || item[BYTES - 1] != ICLOUD {
        return Err(SyncError::HandoverCorrupt);
    }
    let (id, key_bytes) = item[1..BYTES - 1].split_at(ID_BYTES);
    let id = VaultId::from_bytes(id.try_into().map_err(|_| SyncError::HandoverCorrupt)?);
    let mut key = Zeroizing::new([0; KEY_BYTES]);
    key.copy_from_slice(key_bytes);
    Ok(Vault::from_parts(id, key))
}

pub(crate) fn read(store: &dyn SecretStore) -> Result<Option<Vault>, SyncError> {
    store.read(ACCOUNT)?.map(|item| decode(&item)).transpose()
}

/// Sets the item to `vault`, replacing one that names another vault.
pub(crate) fn write(store: &dyn SecretStore, vault: &Vault) -> Result<(), SyncError> {
    store.replace(ACCOUNT, &encode(vault))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{MemoryStore, fixed_vault, to_hex};
    use super::*;

    #[test]
    fn an_item_holds_its_version_the_vault_and_the_transport() {
        let vault = fixed_vault();
        let item = encode(&vault);
        assert_eq!(item.len(), 50);
        assert_eq!(item[0], 1, "the version");
        assert_eq!(&item[1..17], vault.id().as_bytes());
        assert_eq!(&item[17..49], vault.key());
        assert_eq!(item[49], 1, "iCloud");
        assert!(decode(&item).unwrap().same(&vault));
    }

    #[test]
    fn an_unknown_version_or_a_damaged_item_is_refused() {
        let item = encode(&fixed_vault());
        let refused = |bytes: &[u8]| decode(bytes).map(|_| ()).unwrap_err();
        for version in [0, 2, 255] {
            let mut later = item.to_vec();
            later[0] = version;
            assert_eq!(refused(&later), SyncError::HandoverVersion, "{version}");
        }
        let mut longer_later = item.to_vec();
        longer_later[0] = 2;
        longer_later.push(9);
        assert_eq!(refused(&longer_later), SyncError::HandoverVersion);
        let mut relay = item.to_vec();
        relay[49] = 0;
        assert_eq!(refused(&relay), SyncError::HandoverCorrupt);
        assert_eq!(refused(&item[..49]), SyncError::HandoverCorrupt);
        assert_eq!(
            refused(&[item.as_slice(), &[0]].concat()),
            SyncError::HandoverCorrupt
        );
        assert_eq!(refused(&[]), SyncError::HandoverCorrupt);
        assert_eq!(refused(&[1]), SyncError::HandoverCorrupt);
    }

    #[test]
    fn writes_reads_and_replaces_the_item() {
        let store = MemoryStore::default();
        assert!(read(&store).unwrap().is_none());
        let vault = fixed_vault();
        write(&store, &vault).unwrap();
        assert!(read(&store).unwrap().unwrap().same(&vault));
        let other = Vault::generate().unwrap();
        write(&store, &other).unwrap();
        assert!(read(&store).unwrap().unwrap().same(&other));
    }

    #[test]
    fn no_key_reaches_an_error() {
        let item = encode(&fixed_vault());
        let mut later = item.to_vec();
        later[0] = 2;
        let seen = format!(
            "{} {:?}",
            decode(&later).unwrap_err(),
            decode(&item[..40]).unwrap_err()
        );
        assert!(!seen.contains(&to_hex(fixed_vault().key())), "{seen}");
    }
}
