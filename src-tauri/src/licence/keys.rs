//! The public keys this build trusts (docs/licensing.md, The app).

use ed25519_dalek::VerifyingKey;

use super::format::{KeyRing, from_base64url};

/// `kid` and the raw 32-byte Ed25519 public key, base64url without padding, as
/// `pnpm --filter @devot/licence keygen` prints it. A new key ships here in a release before the
/// Worker signs anything with it. While this is empty nothing is gated.
pub(crate) const PRODUCTION: &[(&str, &str)] = &[];

/// licence/test-vectors.json's key: never trusted by a release build.
#[cfg(any(test, debug_assertions))]
pub(crate) const TEST: (&str, &str) = ("test", "PTmNJOA_L5AmygfZpMDMXVj1zAjUq6SfCpKwYt_taa0");

pub(crate) struct PublicKeys {
    keys: Vec<(String, VerifyingKey)>,
    gated: bool,
}

pub(crate) fn decode_key(raw: &str) -> Option<VerifyingKey> {
    let bytes: [u8; 32] = from_base64url(raw)?.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

impl PublicKeys {
    pub(crate) fn built_in() -> Self {
        #[cfg(any(test, debug_assertions))]
        let entries: Vec<(&str, &str)> = PRODUCTION.iter().copied().chain([TEST]).collect();
        #[cfg(not(any(test, debug_assertions)))]
        let entries: Vec<(&str, &str)> = PRODUCTION.to_vec();
        Self::new(&entries, !PRODUCTION.is_empty())
    }

    /// `gated`: whether editing, sync and AI need a licence or the trial at all.
    pub(crate) fn new(entries: &[(&str, &str)], gated: bool) -> Self {
        let keys = entries
            .iter()
            .filter_map(|(kid, raw)| match decode_key(raw) {
                Some(key) => Some(((*kid).to_owned(), key)),
                None => {
                    log::warn!("W_LICENCE_PUBLIC_KEY_INVALID kid={kid}");
                    None
                }
            })
            .collect();
        Self { keys, gated }
    }

    pub(crate) fn gated(&self) -> bool {
        self.gated
    }
}

impl KeyRing for PublicKeys {
    fn key(&self, kid: &str) -> Option<&VerifyingKey> {
        self.keys.iter().find(|(k, _)| k == kid).map(|(_, key)| key)
    }
}
