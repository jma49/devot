//! A recovery key is `version (1) || vault ID (16) || vault key (32) || checksum (4)` in Crockford
//! base32: 85 characters in groups of five. The checksum is the first four bytes of SHA-256 over a
//! label and the rest, so a mistyped key is refused before anything uses it. Reading forgives case,
//! spaces, hyphens and the look-alikes O (zero) and I, L (one).

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::SyncError;
use super::vault::{ID_BYTES, KEY_BYTES, VaultId};

const VERSION: u8 = 1;
const CHECKSUM_BYTES: usize = 4;
const PAYLOAD_BYTES: usize = 1 + ID_BYTES + KEY_BYTES;
const KEY_BYTES_TOTAL: usize = PAYLOAD_BYTES + CHECKSUM_BYTES;
const CHARS: usize = (KEY_BYTES_TOTAL * 8).div_ceil(5);
const GROUP: usize = 5;
const CHECKSUM_LABEL: &[u8] = b"devot/sync/recovery/v1";
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub(super) fn encode(id: &VaultId, key: &[u8; KEY_BYTES]) -> Zeroizing<String> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(KEY_BYTES_TOTAL));
    bytes.push(VERSION);
    bytes.extend_from_slice(id.as_bytes());
    bytes.extend_from_slice(key);
    let sum = checksum(&bytes);
    bytes.extend_from_slice(&sum);

    let mut out = Zeroizing::new(String::with_capacity(CHARS + CHARS / GROUP));
    let mut acc: u16 = 0;
    let mut bits = 0;
    let mut written = 0;
    let mut push = |value: u16, out: &mut String| {
        if written > 0 && written % GROUP == 0 {
            out.push('-');
        }
        out.push(ALPHABET[usize::from(value & 0x1f)] as char);
        written += 1;
    };
    for &byte in bytes.iter() {
        acc = (acc << 8) | u16::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            push(acc >> bits, &mut out);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        push(acc << (5 - bits), &mut out);
    }
    out
}

pub(super) fn decode(text: &str) -> Result<(VaultId, Zeroizing<[u8; KEY_BYTES]>), SyncError> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(KEY_BYTES_TOTAL));
    let mut acc: u16 = 0;
    let mut bits = 0;
    let mut chars = 0;
    for c in text.chars() {
        if c == '-' || c.is_whitespace() {
            continue;
        }
        let value = symbol(c).ok_or(SyncError::RecoveryFormat)?;
        chars += 1;
        if chars > CHARS {
            return Err(SyncError::RecoveryFormat);
        }
        acc = (acc << 5) | u16::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if chars != CHARS || bytes.len() != KEY_BYTES_TOTAL || acc != 0 {
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

fn symbol(c: char) -> Option<u8> {
    let c = match c.to_ascii_uppercase() {
        'O' => '0',
        'I' | 'L' => '1',
        c => c,
    };
    ALPHABET
        .iter()
        .position(|&a| a as char == c)
        .map(|i| i as u8)
}
