//! Store names (docs/adr/0016-store-names-hide-record-ids.md). A relay or iCloud files each record
//! under an HMAC of its ID, keyed from the vault key, since the IDs are UUIDv7 and carry their
//! creation times. The sealed payload starts with the record ID and every chunk's associated data
//! binds the name, so a pulled record opens to its ID, which must give back the name it came under.
//! The moved marker keeps its reserved ID as its name: it carries no time, and builds from before
//! store names look for it there.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::moved::MOVED_ID;
use super::record::{MAX_CHUNK_PLAINTEXT, check_record_id};
use super::{SyncError, Vault};

const LABEL: &[u8] = b"devot/sync/record/v2";
const PREFIX: u8 = b'r';
/// The prefix and 32 bytes of HMAC-SHA256 in base64url: within the relay's 64 characters, and
/// never starting with the underscore CloudKit refuses.
const NAME_BYTES: usize = 44;
const EPOCH_MARK: &str = "+names";

/// The ID reported for a record whose name is neither a store name nor the marker's, so the
/// store's text never reaches the log or the web view.
pub(crate) const UNREADABLE_ID: &str = "00000000-0000-0000-0000-000000000000";

/// The epoch the engine sees: the store's, marked, so a device that comes from a build before store
/// names starts a new epoch and uploads everything again under them.
pub(crate) fn epoch(store_epoch: &str) -> String {
    format!("{store_epoch}{EPOCH_MARK}")
}

fn is_store_name(name: &str) -> bool {
    name.len() == NAME_BYTES
        && name.as_bytes()[0] == PREFIX
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A record filed under its own ID by a build before store names. Its epoch is over: it is left
/// where it is and not handed on.
pub(crate) fn is_legacy(name: &str) -> bool {
    name != MOVED_ID && crate::commands::notes::valid_note_id(name)
}

/// Whether a name is one this build opens: a store name or the marker's.
pub(crate) fn is_readable(name: &str) -> bool {
    name == MOVED_ID || is_store_name(name)
}

/// The ID a record that does not open is reported under.
pub(crate) fn shown_id(name: &str) -> &str {
    if is_readable(name) {
        name
    } else {
        UNREADABLE_ID
    }
}

impl Vault {
    pub(crate) fn store_name(&self, record_id: &str) -> String {
        if record_id == MOVED_ID {
            return MOVED_ID.to_string();
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(self.name_key())
            .expect("HMAC-SHA256 takes a key of any length");
        mac.update(record_id.as_bytes());
        let mut name = String::with_capacity(NAME_BYTES);
        name.push(char::from(PREFIX));
        URL_SAFE_NO_PAD.encode_string(mac.finalize().into_bytes(), &mut name);
        name
    }

    /// Seals `plaintext` as `version` of record `record_id`, and the name to file it under.
    pub(crate) fn seal_stored(
        &self,
        record_id: &str,
        version: u64,
        plaintext: &[u8],
    ) -> Result<(String, Vec<Vec<u8>>), SyncError> {
        self.seal_stored_in_pieces(record_id, version, plaintext, MAX_CHUNK_PLAINTEXT)
    }

    pub(super) fn seal_stored_in_pieces(
        &self,
        record_id: &str,
        version: u64,
        plaintext: &[u8],
        piece_bytes: usize,
    ) -> Result<(String, Vec<Vec<u8>>), SyncError> {
        check_record_id(record_id)?;
        if record_id == MOVED_ID {
            let chunks = self.encrypt_in_pieces(record_id, version, plaintext, piece_bytes)?;
            return Ok((MOVED_ID.to_string(), chunks));
        }
        let name = self.store_name(record_id);
        let mut payload = Zeroizing::new(Vec::with_capacity(1 + record_id.len() + plaintext.len()));
        payload.push(record_id.len() as u8);
        payload.extend_from_slice(record_id.as_bytes());
        payload.extend_from_slice(plaintext);
        let chunks = self.seal_pieces(LABEL, &name, version, &payload, piece_bytes)?;
        Ok((name, chunks))
    }

    /// Opens `version` of the record filed under `name`: its ID and plaintext.
    pub(crate) fn open_stored<C: AsRef<[u8]>>(
        &self,
        name: &str,
        version: u64,
        chunks: &[C],
    ) -> Result<(String, Zeroizing<Vec<u8>>), SyncError> {
        if name == MOVED_ID {
            return Ok((
                name.to_string(),
                self.decrypt_record(name, version, chunks)?,
            ));
        }
        if !is_store_name(name) {
            return Err(SyncError::RecordId);
        }
        let mut payload = self.open_pieces(LABEL, name, version, chunks)?;
        let length = usize::from(*payload.first().ok_or(SyncError::RecordId)?);
        let record_id = payload
            .get(1..1 + length)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .filter(|id| check_record_id(id).is_ok() && self.store_name(id) == name)
            .ok_or(SyncError::RecordId)?
            .to_string();
        payload.drain(..1 + length);
        Ok((record_id, payload))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::VaultId;

    const NOTE: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789ab";
    const OTHER: &str = "0192f4c8-7a1b-7c3d-8e9f-0123456789ac";

    fn vault() -> Vault {
        vault_of(5, 6)
    }

    fn vault_of(id: u8, key: u8) -> Vault {
        Vault::from_parts(
            VaultId::from_bytes([id; 16]),
            Zeroizing::new([key; super::super::vault::KEY_BYTES]),
        )
    }

    #[test]
    fn a_name_shows_nothing_of_the_id_and_fits_both_stores() {
        let vault = vault();
        let name = vault.store_name(NOTE);
        assert_eq!(name, vault.store_name(NOTE));
        assert_ne!(name, vault.store_name(OTHER));
        assert_eq!(name.len(), NAME_BYTES);
        assert!(name.starts_with('r'));
        // The relay's ID rule (src/core/sync/protocol.ts) and CloudKit's: ASCII, no leading `_`.
        assert!(
            name.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert!(!name.contains("0192f4c8"));
        assert!(!crate::commands::notes::valid_note_id(&name));
    }

    #[test]
    fn names_follow_the_vault_key_and_id() {
        let name = vault_of(1, 2).store_name(NOTE);
        assert_eq!(name, vault_of(1, 2).store_name(NOTE));
        assert_ne!(name, vault_of(1, 3).store_name(NOTE));
        assert_ne!(name, vault_of(4, 2).store_name(NOTE));
    }

    /// HKDF-SHA256 (salt the vault ID, info `devot/sync/record-name-key/v1`), then HMAC-SHA256.
    #[test]
    fn names_match_known_answers() {
        assert_eq!(
            vault_of(1, 2).store_name(NOTE),
            "rxu4uJ8hTKMcEgXdgeBUXSxSjdN0wEYFePJqPmeknTl8"
        );
    }

    #[test]
    fn the_moved_marker_keeps_its_reserved_id() {
        let vault = vault();
        assert_eq!(vault.store_name(MOVED_ID), MOVED_ID);
        let (name, chunks) = vault.seal_stored(MOVED_ID, 2, b"marker").unwrap();
        assert_eq!(name, MOVED_ID);
        // Sealed as before store names, so every build that knows the marker opens it.
        assert_eq!(
            vault
                .decrypt_record(MOVED_ID, 2, &chunks)
                .unwrap()
                .as_slice(),
            b"marker"
        );
        let (id, plaintext) = vault.open_stored(MOVED_ID, 2, &chunks).unwrap();
        assert_eq!(
            (id.as_str(), plaintext.as_slice()),
            (MOVED_ID, &b"marker"[..])
        );
    }

    #[test]
    fn a_record_opens_to_its_id_and_plaintext() {
        let vault = vault();
        let (name, chunks) = vault.seal_stored(NOTE, 3, b"a note").unwrap();
        assert_eq!(name, vault.store_name(NOTE));
        let (id, plaintext) = vault.open_stored(&name, 3, &chunks).unwrap();
        assert_eq!((id.as_str(), plaintext.as_slice()), (NOTE, &b"a note"[..]));

        let (name, chunks) = vault
            .seal_stored_in_pieces(NOTE, 1, &[7; 2500], 1000)
            .unwrap();
        assert_eq!(chunks.len(), 3);
        let (_, plaintext) = vault.open_stored(&name, 1, &chunks).unwrap();
        assert_eq!(plaintext.as_slice(), &[7; 2500][..]);

        let (name, chunks) = vault.seal_stored(NOTE, 1, b"").unwrap();
        assert!(vault.open_stored(&name, 1, &chunks).unwrap().1.is_empty());
    }

    #[test]
    fn the_name_and_version_are_bound() {
        let vault = vault();
        let (name, chunks) = vault.seal_stored(NOTE, 3, b"a note").unwrap();
        let other = vault.store_name(OTHER);
        assert_eq!(
            vault.open_stored(&other, 3, &chunks),
            Err(SyncError::ChunkAuth)
        );
        assert_eq!(
            vault.open_stored(&name, 4, &chunks),
            Err(SyncError::ChunkAuth)
        );
        // Sealed under its name but not as a record of the old scheme, and the other way round.
        assert_eq!(
            vault.decrypt_record(&name, 3, &chunks),
            Err(SyncError::ChunkAuth)
        );
        let old = vault.encrypt_record(&name, 3, b"a note").unwrap();
        assert_eq!(vault.open_stored(&name, 3, &old), Err(SyncError::ChunkAuth));
        assert_eq!(
            vault_of(9, 9).open_stored(&name, 3, &chunks),
            Err(SyncError::ChunkAuth)
        );
    }

    #[test]
    fn an_id_that_does_not_give_back_its_name_is_refused() {
        let vault = vault();
        let name = vault.store_name(NOTE);
        let seal = |payload: &[u8]| vault.seal_pieces(LABEL, &name, 1, payload, 1000).unwrap();
        let mut renamed = vec![OTHER.len() as u8];
        renamed.extend_from_slice(OTHER.as_bytes());
        renamed.extend_from_slice(b"a note");
        let mut long = vec![200];
        long.extend_from_slice(NOTE.as_bytes());
        for payload in [&renamed[..], &[], &[0], &long[..], &[3, b'a', b'/', b'b']] {
            assert_eq!(
                vault.open_stored(&name, 1, &seal(payload)),
                Err(SyncError::RecordId)
            );
        }
    }

    #[test]
    fn names_are_sorted_by_form() {
        let vault = vault();
        let name = vault.store_name(NOTE);
        assert!(is_readable(&name) && !is_legacy(&name));
        assert!(is_readable(MOVED_ID) && !is_legacy(MOVED_ID));
        assert!(!is_readable(NOTE) && is_legacy(NOTE));
        for odd in ["", "x", "note/1", &name[1..], UNREADABLE_ID] {
            assert!(!is_readable(odd) && !is_legacy(odd), "{odd}");
            assert_eq!(shown_id(odd), UNREADABLE_ID);
        }
        assert_eq!(shown_id(&name), name);
        assert_eq!(shown_id(NOTE), UNREADABLE_ID);
        assert_eq!(
            vault.open_stored(NOTE, 1, &[vec![1; 40]]),
            Err(SyncError::RecordId)
        );
    }

    #[test]
    fn the_engine_sees_a_marked_epoch() {
        assert_eq!(epoch("abc"), "abc+names");
        assert_ne!(epoch("abc"), "abc");
    }
}
