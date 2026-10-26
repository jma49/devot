//! A recovery key is `version (1) || vault ID (16) || vault key (32) || checksum (4)` in Crockford
//! base32: 85 characters in groups of five. The checksum is the first four bytes of SHA-256 over a
//! label and the rest, so a mistyped key is refused before anything uses it.

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::SyncError;
use super::crockford;
use super::vault::{ID_BYTES, KEY_BYTES, VaultId};

const VERSION: u8 = 1;
const CHECKSUM_BYTES: usize = 4;
const PAYLOAD_BYTES: usize = 1 + ID_BYTES + KEY_BYTES;
const KEY_BYTES_TOTAL: usize = PAYLOAD_BYTES + CHECKSUM_BYTES;
const CHARS: usize = (KEY_BYTES_TOTAL * 8).div_ceil(5);
const GROUP: usize = 5;
const CHECKSUM_LABEL: &[u8] = b"devot/sync/recovery/v1";

pub(super) fn encode(id: &VaultId, key: &[u8; KEY_BYTES]) -> Zeroizing<String> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(KEY_BYTES_TOTAL));
    bytes.push(VERSION);
    bytes.extend_from_slice(id.as_bytes());
    bytes.extend_from_slice(key);
    let sum = checksum(&bytes);
    bytes.extend_from_slice(&sum);
    crockford::encode(&bytes, GROUP)
}

pub(super) fn decode(text: &str) -> Result<(VaultId, Zeroizing<[u8; KEY_BYTES]>), SyncError> {
    let bytes = crockford::decode(text, CHARS).ok_or(SyncError::RecoveryFormat)?;
    if bytes.len() != KEY_BYTES_TOTAL {
        return Err(SyncError::RecoveryFormat);
    }
    let (payload, sum) = bytes.split_at(PAYLOAD_BYTES);
    if checksum(payload) != sum {
        return Err(SyncError::RecoveryChecksum);
    }
    if payload[0] != VERSION {
        return Err(SyncError::RecoveryVersion);
    }
    let (id, key_bytes) = payload[1..].split_at(ID_BYTES);
    let id = VaultId::from_bytes(id.try_into().map_err(|_| SyncError::RecoveryFormat)?);
    let mut key = Zeroizing::new([0; KEY_BYTES]);
    key.copy_from_slice(key_bytes);
    Ok((id, key))
}

fn checksum(payload: &[u8]) -> [u8; CHECKSUM_BYTES] {
    let digest = Sha256::new()
        .chain_update(CHECKSUM_LABEL)
        .chain_update(payload)
        .finalize();
    let mut sum = [0; CHECKSUM_BYTES];
    sum.copy_from_slice(&digest[..CHECKSUM_BYTES]);
    sum
}
