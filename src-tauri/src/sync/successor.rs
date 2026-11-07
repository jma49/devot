//! What names a rotated iCloud vault's successor (docs/adr/0017-sync-key-rotation.md, On iCloud):
//! the successor's ID sealed under the old vault's key, so only a device holding that key reads it,
//! and a MAC over both IDs under a key of the successor's, so a device takes the vault the handover
//! item brings only when it is the one the rotating device made.

use hmac::{Hmac, Mac};
use sha2::Sha256;

use super::record::MAX_CHUNK_PLAINTEXT;
use super::vault::{ID_BYTES, VaultId};
use super::{SyncError, Vault};

const SEAL_LABEL: &[u8] = b"devot/sync/successor/v1";
const MAC_LABEL: &[u8] = b"devot/sync/successor-mac/v1";
const VERSION: u64 = 1;

/// `next`'s ID sealed under `old`'s key, as the record of `next`.
pub(crate) fn seal(old: &Vault, next: &Vault) -> Result<Vec<u8>, SyncError> {
    old.seal_pieces(
        SEAL_LABEL,
        &next.id().to_string(),
        VERSION,
        next.id().as_bytes(),
        MAX_CHUNK_PLAINTEXT,
    )?
    .pop()
    .ok_or(SyncError::NoChunks)
}

/// The successor `sealed` names, when it opens under `old`'s key as the record of `to`.
pub(crate) fn open(old: &Vault, to: &str, sealed: &[u8]) -> Result<VaultId, SyncError> {
    let bytes = old.open_pieces(SEAL_LABEL, to, VERSION, &[sealed])?;
    let id: [u8; ID_BYTES] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| SyncError::ChunkFormat)?;
    Ok(VaultId::from_bytes(id))
}

fn keyed(next: &Vault, from: VaultId) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(next.successor_mac_key().as_ref())
        .expect("HMAC takes a key of any length");
    mac.update(MAC_LABEL);
    mac.update(from.as_bytes());
    mac.update(next.id().as_bytes());
    mac
}

/// The MAC under `next`'s key over the IDs of `from` and `next`.
pub(crate) fn mac(next: &Vault, from: VaultId) -> Vec<u8> {
    keyed(next, from).finalize().into_bytes().to_vec()
}

/// Whether `mac` is `next`'s over `from`, compared in constant time.
pub(crate) fn verify(next: &Vault, from: VaultId, mac: &[u8]) -> bool {
    keyed(next, from).verify_slice(mac).is_ok()
}

#[cfg(test)]
mod tests {
    use super::super::tests::fixed_vault;
    use super::*;

    #[test]
    fn the_successor_opens_under_the_old_key_only_and_as_its_own_record() {
        let old = fixed_vault();
        let next = Vault::generate().unwrap();
        let sealed = seal(&old, &next).unwrap();
        let to = next.id().to_string();
        assert_eq!(open(&old, &to, &sealed), Ok(next.id()));
        let stranger = Vault::generate().unwrap();
        assert_eq!(open(&stranger, &to, &sealed), Err(SyncError::ChunkAuth));
        let other = Vault::generate().unwrap().id().to_string();
        assert_eq!(open(&old, &other, &sealed), Err(SyncError::ChunkAuth));
        assert_eq!(open(&next, &to, &sealed), Err(SyncError::ChunkAuth));
        assert!(!sealed.windows(16).any(|w| w == next.id().as_bytes()));
    }

    #[test]
    fn the_mac_holds_under_the_successor_s_key_for_these_two_vaults_only() {
        let old = fixed_vault();
        let next = Vault::generate().unwrap();
        let tag = mac(&next, old.id());
        assert_eq!(tag.len(), 32);
        assert!(verify(&next, old.id(), &tag));
        assert!(!verify(&next, next.id(), &tag), "another vault it succeeds");
        let forged = Vault::from_parts(next.id(), zeroize::Zeroizing::new([7; 32]));
        assert!(
            !verify(&forged, old.id(), &tag),
            "the same ID under another key"
        );
        assert!(!verify(&next, old.id(), &tag[..31]));
        assert!(!verify(&next, old.id(), &[]));
    }
}
