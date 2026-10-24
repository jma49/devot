//! A sealed record is a list of chunks, each `format (1) || nonce (12) || ciphertext || tag (16)`,
//! sealed with AES-256-GCM under the vault's record key. Each chunk's associated data names the
//! vault, the record, its version, the chunk's index and the chunk count, so a relay that swaps,
//! replays, reorders, drops or adds chunks makes every affected chunk fail to open.

use aes_gcm::aead::AeadInOut;
use aes_gcm::{Nonce, Tag};
use zeroize::Zeroizing;

use super::vault::random;
use super::{SyncError, Vault};

const FORMAT: u8 = 1;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const HEADER_BYTES: usize = 1 + NONCE_BYTES;
const OVERHEAD: usize = HEADER_BYTES + TAG_BYTES;

/// A chunk's whole size, nonce and tag included, so it fits one Durable Object SQLite row (2 MB).
pub(crate) const MAX_CHUNK_BYTES: usize = 1_900_000;
const MAX_CHUNK_PLAINTEXT: usize = MAX_CHUNK_BYTES - OVERHEAD;

/// The largest plaintext record: a note's Yjs state may take 64 MiB (`note_put`), plus its fields.
pub(crate) const MAX_RECORD_BYTES: usize = 80 * 1024 * 1024;
const MAX_CHUNKS: usize = MAX_RECORD_BYTES.div_ceil(MAX_CHUNK_PLAINTEXT);

const MAX_RECORD_ID_BYTES: usize = 64;

/// How many chunks [`Vault::encrypt_record`] cuts a plaintext of `len` bytes into.
pub(crate) fn chunk_count(len: usize) -> usize {
    len.div_ceil(MAX_CHUNK_PLAINTEXT).max(1)
}
const AD_LABEL: &[u8] = b"devot/sync/record/v1";

impl Vault {
    /// Seals `plaintext` as `version` of record `record_id` (the version the relay will store it
    /// under), each chunk under a fresh random nonce.
    pub(crate) fn encrypt_record(
        &self,
        record_id: &str,
        version: u64,
        plaintext: &[u8],
    ) -> Result<Vec<Vec<u8>>, SyncError> {
        self.encrypt_in_pieces(record_id, version, plaintext, MAX_CHUNK_PLAINTEXT)
    }

    /// Opening takes chunks of any size up to [`MAX_CHUNK_BYTES`], so tests can seal small ones.
    pub(super) fn encrypt_in_pieces(
        &self,
        record_id: &str,
        version: u64,
        plaintext: &[u8],
        piece_bytes: usize,
    ) -> Result<Vec<Vec<u8>>, SyncError> {
        check_record_id(record_id)?;
        if plaintext.len() > MAX_RECORD_BYTES {
            return Err(SyncError::RecordTooLarge);
        }
        let pieces: Vec<&[u8]> = if plaintext.is_empty() {
            vec![plaintext]
        } else {
            plaintext
                .chunks(piece_bytes.clamp(1, MAX_CHUNK_PLAINTEXT))
                .collect()
        };
        let count = pieces.len() as u32;
        pieces
            .into_iter()
            .enumerate()
            .map(|(index, piece)| {
                let mut nonce = [0; NONCE_BYTES];
                random(&mut nonce)?;
                let at = ChunkAt {
                    record_id,
                    version,
                    index: index as u32,
                    count,
                };
                self.seal_chunk(nonce, &at, piece)
            })
            .collect()
    }

    /// Opens a record sealed by [`Vault::encrypt_record`] as `version` of `record_id`. Any chunk
    /// that does not belong at its place in that exact set fails with `E_SYNC_CHUNK_AUTH`.
    pub(crate) fn decrypt_record<C: AsRef<[u8]>>(
        &self,
        record_id: &str,
        version: u64,
        chunks: &[C],
    ) -> Result<Zeroizing<Vec<u8>>, SyncError> {
        check_record_id(record_id)?;
        if chunks.is_empty() {
            return Err(SyncError::NoChunks);
        }
        if chunks.len() > MAX_CHUNKS {
            return Err(SyncError::RecordTooLarge);
        }
        for chunk in chunks {
            let chunk = chunk.as_ref();
            if !(OVERHEAD..=MAX_CHUNK_BYTES).contains(&chunk.len()) {
                return Err(SyncError::ChunkSize);
            }
            if chunk[0] != FORMAT {
                return Err(SyncError::ChunkFormat);
            }
        }
        let total = chunks.iter().map(|c| c.as_ref().len() - OVERHEAD).sum();
        let mut plaintext = Zeroizing::new(Vec::with_capacity(total));
        let count = chunks.len() as u32;
        for (index, chunk) in chunks.iter().enumerate() {
            let chunk = chunk.as_ref();
            let (header, rest) = chunk.split_at(HEADER_BYTES);
            let (ciphertext, tag) = rest.split_at(rest.len() - TAG_BYTES);
            let nonce: [u8; NONCE_BYTES] =
                header[1..].try_into().map_err(|_| SyncError::ChunkSize)?;
            let tag: [u8; TAG_BYTES] = tag.try_into().map_err(|_| SyncError::ChunkSize)?;
            let at = ChunkAt {
                record_id,
                version,
                index: index as u32,
                count,
            };
            let start = plaintext.len();
            plaintext.extend_from_slice(ciphertext);
            self.cipher()
                .decrypt_inout_detached(
                    &Nonce::from(nonce),
                    &at.associated_data(self),
                    plaintext[start..].as_mut().into(),
                    &Tag::from(tag),
                )
                .map_err(|_| SyncError::ChunkAuth)?;
        }
        Ok(plaintext)
    }

    pub(super) fn seal_chunk(
        &self,
        nonce: [u8; NONCE_BYTES],
        at: &ChunkAt,
        piece: &[u8],
    ) -> Result<Vec<u8>, SyncError> {
        let mut chunk = Vec::with_capacity(OVERHEAD + piece.len());
        chunk.push(FORMAT);
        chunk.extend_from_slice(&nonce);
        chunk.extend_from_slice(piece);
        let tag = self
            .cipher()
            .encrypt_inout_detached(
                &Nonce::from(nonce),
                &at.associated_data(self),
                chunk[HEADER_BYTES..].as_mut().into(),
            )
            .map_err(|_| SyncError::RecordTooLarge)?;
        chunk.extend_from_slice(&tag);
        Ok(chunk)
    }
}

pub(super) struct ChunkAt<'a> {
    pub(super) record_id: &'a str,
    pub(super) version: u64,
    pub(super) index: u32,
    pub(super) count: u32,
}

impl ChunkAt<'_> {
    /// `label || vault ID (16) || record ID length (u16) || record ID || version (u64) || index
    /// (u32) || count (u32)`, integers big-endian.
    fn associated_data(&self, vault: &Vault) -> Vec<u8> {
        let id = self.record_id.as_bytes();
        let mut ad = Vec::with_capacity(AD_LABEL.len() + 16 + 2 + id.len() + 8 + 4 + 4);
        ad.extend_from_slice(AD_LABEL);
        ad.extend_from_slice(vault.id().as_bytes());
        ad.extend_from_slice(&(id.len() as u16).to_be_bytes());
        ad.extend_from_slice(id);
        ad.extend_from_slice(&self.version.to_be_bytes());
        ad.extend_from_slice(&self.index.to_be_bytes());
        ad.extend_from_slice(&self.count.to_be_bytes());
        ad
    }
}

/// Record IDs are random (UUIDs today): 1 to 64 bytes of ASCII letters, digits and hyphens.
fn check_record_id(id: &str) -> Result<(), SyncError> {
    let fits = (1..=MAX_RECORD_ID_BYTES).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if fits {
        Ok(())
    } else {
        Err(SyncError::RecordId)
    }
}
