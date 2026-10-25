//! The public keys this build trusts and the date it was released (docs/licensing.md, The app).

use ed25519_dalek::VerifyingKey;

use super::format::{KeyRing, from_base64url};

/// `kid` and the raw 32-byte Ed25519 public key, base64url without padding, as
/// `pnpm --filter @devot/licence keygen` prints it. A new key ships here in a release before the
/// Worker signs anything with it. While this is empty nothing is gated.
pub(crate) const PRODUCTION: &[(&str, &str)] = &[];

/// licence/test-vectors.json's key: never trusted by a release build.
#[cfg(any(test, debug_assertions))]
pub(crate) const TEST: (&str, &str) = ("test", "PTmNJOA_L5AmygfZpMDMXVj1zAjUq6SfCpKwYt_taa0");

/// The release workflow sets it (YYYY-MM-DD, UTC); local and dev builds have none.
pub(crate) const RELEASE_DATE: Option<&str> = option_env!("DEVOT_RELEASE_DATE");

const fn is_date_bytes(text: &[u8]) -> bool {
    if text.len() != 10 {
        return false;
    }
    let mut i = 0;
    while i < 10 {
        let ok = if i == 4 || i == 7 {
            text[i] == b'-'
        } else {
            text[i].is_ascii_digit()
        };
        if !ok {
            return false;
        }
        i += 1;
    }
    true
}

const _: () = if let Some(date) = RELEASE_DATE {
    assert!(
        is_date_bytes(date.as_bytes()),
        "DEVOT_RELEASE_DATE must be YYYY-MM-DD"
    );
};

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

    /// `gated`: whether sync and AI need a licence at all.
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

/// Whether a licence covers a build released on `release`; a build without a date is covered.
pub(crate) fn covers(updates_until: &str, release: Option<&str>) -> bool {
    release.is_none_or(|release| release <= updates_until)
}
