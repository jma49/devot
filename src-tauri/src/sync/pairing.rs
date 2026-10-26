//! Device pairing (docs/adr/0008-sync-device-pairing.md). A pairing code is `version (1) || secret
//! (16) || checksum (3)` in Crockford base32: 32 characters in groups of four. From the secret both
//! devices derive the pairing ID the relay files the pairing under, and a key the relay never
//! sees, which seals the offer (the vault) and the joining device's confirmation.

use std::fmt;

use aes_gcm::aead::AeadInOut;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, Tag};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use tauri::Url;
use zeroize::Zeroizing;

use super::client::RelayUrl;
use super::crockford;
use super::vault::{ID_BYTES, KEY_BYTES, VaultId, random};
use super::{SyncError, Vault};

/// How long an offer can be taken (`PAIRING.ttlMs` in src/core/sync/protocol.ts).
pub(crate) const TTL_MS: i64 = 10 * 60_000;
/// How long past its expiry the relay keeps a pairing (`PAIRING.graceMs`), so a device that took
/// the offer in time can still confirm.
pub(crate) const GRACE_MS: i64 = 60_000;
/// The clock difference the engine allows (`E_SYNC_CLOCK_SKEW`), allowed on an offer's expiry too.
const SKEW_MS: i64 = 5 * 60_000;

const SECRET_BYTES: usize = 16;
const ID_BYTES_DERIVED: usize = 16;
const VERSION: u8 = 1;
const CHECKSUM_BYTES: usize = 3;
const CODE_BYTES: usize = 1 + SECRET_BYTES + CHECKSUM_BYTES;
const CODE_CHARS: usize = (CODE_BYTES * 8).div_ceil(5);
const GROUP: usize = 4;

const FORMAT: u8 = 1;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const OFFER_BYTES: usize = 1 + 8 + ID_BYTES + KEY_BYTES;
const MAX_DEVICE_BYTES: usize = 64;

const SALT: &[u8] = b"devot/sync/pairing/v1";
const ID_INFO: &[u8] = b"devot/sync/pairing/id/v1";
const KEY_INFO: &[u8] = b"devot/sync/pairing/key/v1";
const OFFER_AD: &[u8] = b"devot/sync/pairing/offer/v1";
const CONFIRM_AD: &[u8] = b"devot/sync/pairing/confirm/v1";
const CHECKSUM_LABEL: &[u8] = b"devot/sync/pairing/code/v1";

const LINK_SCHEME: &str = "devot";
const LINK_HOST: &str = "pair";

/// One pairing's secret and what derives from it. `Debug` shows the pairing ID only.
pub(crate) struct Pairing {
    secret: Zeroizing<[u8; SECRET_BYTES]>,
    id: String,
    cipher: Aes256Gcm,
}

impl fmt::Debug for Pairing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pairing")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// What the joining device typed, pasted or scanned: the pairing, and the relay a link named.
#[derive(Debug)]
pub(crate) struct Entered {
    pub pairing: Pairing,
    pub relay: Option<RelayUrl>,
}

impl Pairing {
    pub(crate) fn generate() -> Result<Self, SyncError> {
        let mut secret = Zeroizing::new([0; SECRET_BYTES]);
        random(secret.as_mut())?;
        Ok(Self::from_secret(secret))
    }

    fn from_secret(secret: Zeroizing<[u8; SECRET_BYTES]>) -> Self {
        let hkdf = Hkdf::<Sha256>::new(Some(SALT), secret.as_ref());
        let mut id = [0; ID_BYTES_DERIVED];
        hkdf.expand(ID_INFO, &mut id)
            .expect("16 bytes is within HKDF-SHA256's output limit");
        let mut key = Zeroizing::new([0; KEY_BYTES]);
        hkdf.expand(KEY_INFO, key.as_mut())
            .expect("32 bytes is within HKDF-SHA256's output limit");
        let cipher = Aes256Gcm::new_from_slice(key.as_ref())
            .expect("an HKDF output of 32 bytes is an AES-256 key");
        Self {
            secret,
            id: URL_SAFE_NO_PAD.encode(id),
            cipher,
        }
    }

    /// The pairing's ID on the relay: base64url of 16 bytes derived from the secret.
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// The code to show, in groups of four.
    pub(crate) fn code(&self) -> Zeroizing<String> {
        let mut bytes = Zeroizing::new(Vec::with_capacity(CODE_BYTES));
        bytes.push(VERSION);
        bytes.extend_from_slice(self.secret.as_ref());
        let sum = checksum(&bytes);
        bytes.extend_from_slice(&sum);
        crockford::encode(&bytes, GROUP)
    }

    /// What the QR code holds: `devot://pair?relay=<relay>&code=<code without hyphens>`.
    pub(crate) fn link(&self, relay: &RelayUrl) -> Zeroizing<String> {
        let code = Zeroizing::new(self.code().replace('-', ""));
        let mut url =
            Url::parse(&format!("{LINK_SCHEME}://{LINK_HOST}")).expect("a fixed link parses");
        url.query_pairs_mut()
            .append_pair("relay", relay.as_str())
            .append_pair("code", &code);
        Zeroizing::new(url.into())
    }

    /// Seals the vault for whoever holds this code, until `expires` (ms, this device's clock).
    pub(crate) fn seal_offer(&self, vault: &Vault, expires: i64) -> Result<Vec<u8>, SyncError> {
        let mut plain = Zeroizing::new(Vec::with_capacity(OFFER_BYTES));
        plain.push(VERSION);
        plain.extend_from_slice(&expires.to_be_bytes());
        plain.extend_from_slice(vault.id().as_bytes());
        plain.extend_from_slice(vault.key());
        self.seal(OFFER_AD, &plain)
    }

    /// The vault an offer holds. Anything that does not open under this code's key fails with
    /// `E_SYNC_PAIRING_AUTH` (a relay's substitute, another pairing's offer, a confirmation), and
    /// an offer past its expiry by more than the allowed clock difference with
    /// `E_SYNC_PAIRING_EXPIRED`.
    pub(crate) fn open_offer(&self, sealed: &[u8], now: i64) -> Result<Vault, SyncError> {
        let plain = self.open(OFFER_AD, sealed)?;
        if plain.len() != OFFER_BYTES || plain[0] != VERSION {
            return Err(SyncError::PairingAuth);
        }
        let expires =
            i64::from_be_bytes(plain[1..9].try_into().map_err(|_| SyncError::PairingAuth)?);
        if now > expires.saturating_add(SKEW_MS) {
            return Err(SyncError::PairingExpired);
        }
        let (id, key_bytes) = plain[9..].split_at(ID_BYTES);
        let id = VaultId::from_bytes(id.try_into().map_err(|_| SyncError::PairingAuth)?);
        let mut key = Zeroizing::new([0; KEY_BYTES]);
        key.copy_from_slice(key_bytes);
        Ok(Vault::from_parts(id, key))
    }

    /// The joining device's word that it holds the vault, with the device ID the relay gave it.
    pub(crate) fn seal_confirmation(&self, device: &str) -> Result<Vec<u8>, SyncError> {
        if device.is_empty() || device.len() > MAX_DEVICE_BYTES {
            return Err(SyncError::PairingAuth);
        }
        self.seal(CONFIRM_AD, device.as_bytes())
    }

    pub(crate) fn open_confirmation(&self, sealed: &[u8]) -> Result<String, SyncError> {
        let plain = self.open(CONFIRM_AD, sealed)?;
        let device = std::str::from_utf8(&plain).map_err(|_| SyncError::PairingAuth)?;
        let valid = (1..=MAX_DEVICE_BYTES).contains(&device.len())
            && device
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        valid
            .then(|| device.to_string())
            .ok_or(SyncError::PairingAuth)
    }

    fn associated_data(&self, label: &[u8]) -> Vec<u8> {
        let mut ad = Vec::with_capacity(label.len() + self.id.len());
        ad.extend_from_slice(label);
        ad.extend_from_slice(self.id.as_bytes());
        ad
    }

    fn seal(&self, label: &[u8], plain: &[u8]) -> Result<Vec<u8>, SyncError> {
        let mut nonce = [0; NONCE_BYTES];
        random(&mut nonce)?;
        let mut sealed = Vec::with_capacity(1 + NONCE_BYTES + plain.len() + TAG_BYTES);
        sealed.push(FORMAT);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(plain);
        let tag = self
            .cipher
            .encrypt_inout_detached(
                &Nonce::from(nonce),
                &self.associated_data(label),
                sealed[1 + NONCE_BYTES..].as_mut().into(),
            )
            .map_err(|_| SyncError::PairingAuth)?;
        sealed.extend_from_slice(&tag);
        Ok(sealed)
    }

    fn open(&self, label: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SyncError> {
        if sealed.len() < 1 + NONCE_BYTES + TAG_BYTES || sealed[0] != FORMAT {
            return Err(SyncError::PairingAuth);
        }
        let (header, rest) = sealed.split_at(1 + NONCE_BYTES);
        let (ciphertext, tag) = rest.split_at(rest.len() - TAG_BYTES);
        let nonce: [u8; NONCE_BYTES] =
            header[1..].try_into().map_err(|_| SyncError::PairingAuth)?;
        let tag: [u8; TAG_BYTES] = tag.try_into().map_err(|_| SyncError::PairingAuth)?;
        let mut plain = Zeroizing::new(ciphertext.to_vec());
        self.cipher
            .decrypt_inout_detached(
                &Nonce::from(nonce),
                &self.associated_data(label),
                plain.as_mut_slice().into(),
                &Tag::from(tag),
            )
            .map_err(|_| SyncError::PairingAuth)?;
        Ok(plain)
    }
}

/// Reads a code as typed or pasted (case, spaces, hyphens and look-alikes forgiven), or the link a
/// QR code holds.
pub(crate) fn read(text: &str) -> Result<Entered, SyncError> {
    let text = text.trim();
    if text.len() > 4096 {
        return Err(SyncError::PairingFormat);
    }
    if let Ok(url) = Url::parse(text)
        && url.scheme() == LINK_SCHEME
    {
        if url.host_str() != Some(LINK_HOST) {
            return Err(SyncError::PairingFormat);
        }
        let mut relay = None;
        let mut code = None;
        for (name, value) in url.query_pairs() {
            match name.as_ref() {
                "relay" if relay.is_none() => relay = Some(Zeroizing::new(value.into_owned())),
                "code" if code.is_none() => code = Some(Zeroizing::new(value.into_owned())),
                _ => return Err(SyncError::PairingFormat),
            }
        }
        let relay = relay
            .and_then(|r| RelayUrl::parse(&r).ok())
            .ok_or(SyncError::PairingFormat)?;
        let code = code.ok_or(SyncError::PairingFormat)?;
        return Ok(Entered {
            pairing: decode(&code)?,
            relay: Some(relay),
        });
    }
    Ok(Entered {
        pairing: decode(text)?,
        relay: None,
    })
}

fn decode(text: &str) -> Result<Pairing, SyncError> {
    let bytes = crockford::decode(text, CODE_CHARS).ok_or(SyncError::PairingFormat)?;
    if bytes.len() != CODE_BYTES {
        return Err(SyncError::PairingFormat);
    }
    let (payload, sum) = bytes.split_at(1 + SECRET_BYTES);
    if checksum(payload) != sum {
        return Err(SyncError::PairingChecksum);
    }
    if payload[0] != VERSION {
        return Err(SyncError::PairingVersion);
    }
    let mut secret = Zeroizing::new([0; SECRET_BYTES]);
    secret.copy_from_slice(&payload[1..]);
    Ok(Pairing::from_secret(secret))
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

/// A QR code's modules, row by row, `1` for dark; the page draws them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct Qr {
    pub size: usize,
    pub modules: String,
}

pub(crate) fn qr(text: &str) -> Result<Qr, &'static str> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M)
        .map_err(|_| "E_SYNC_PAIRING_QR")?;
    let modules = code
        .to_colors()
        .into_iter()
        .map(|color| match color {
            qrcode::Color::Dark => '1',
            qrcode::Color::Light => '0',
        })
        .collect();
    Ok(Qr {
        size: code.width(),
        modules,
    })
}

#[cfg(test)]
pub(super) fn from_secret_for_tests(secret: [u8; SECRET_BYTES]) -> Pairing {
    Pairing::from_secret(Zeroizing::new(secret))
}
