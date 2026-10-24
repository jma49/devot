use std::fmt;

use aes_gcm::{Aes256Gcm, KeyInit};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::{SecretStore, SyncError, recovery};

pub(super) const ID_BYTES: usize = 16;
pub(super) const KEY_BYTES: usize = 32;

const ITEM_ACCOUNT: &str = "vault";
const ITEM_VERSION: u8 = 1;
const ITEM_BYTES: usize = 1 + ID_BYTES + KEY_BYTES;

// HKDF labels: one per use, so the record key and the enrollment secret never coincide.
const RECORD_KEY_INFO: &[u8] = b"devot/sync/record-key/v1";
const ENROLLMENT_INFO: &[u8] = b"devot/sync/enrollment/v1";

/// A vault's random ID, a UUIDv4. The relay knows it; it is not a secret.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct VaultId([u8; ID_BYTES]);

impl VaultId {
    pub(crate) fn from_bytes(bytes: [u8; ID_BYTES]) -> Self {
        Self(bytes)
    }

    pub(crate) fn as_bytes(&self) -> &[u8; ID_BYTES] {
        &self.0
    }
}

impl fmt::Display for VaultId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        uuid::Uuid::from_bytes(self.0).hyphenated().fmt(f)
    }
}

impl fmt::Debug for VaultId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VaultId({self})")
    }
}

/// A vault's ID and key. The key lives in the keychain and in this value only: it has no accessor
/// outside `sync`, its `Debug` shows the ID alone, and its bytes are wiped on drop.
pub(crate) struct Vault {
    id: VaultId,
    key: Zeroizing<[u8; KEY_BYTES]>,
    cipher: Aes256Gcm,
}

impl fmt::Debug for Vault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vault")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl Vault {
    pub(super) fn generate() -> Result<Self, SyncError> {
        let mut id = [0; ID_BYTES];
        random(&mut id)?;
        id[6] = (id[6] & 0x0f) | 0x40;
        id[8] = (id[8] & 0x3f) | 0x80;
        let mut key = Zeroizing::new([0; KEY_BYTES]);
        random(key.as_mut())?;
        Ok(Self::from_parts(VaultId(id), key))
    }

    pub(super) fn from_parts(id: VaultId, key: Zeroizing<[u8; KEY_BYTES]>) -> Self {
        let record_key = derive(&id, &key, RECORD_KEY_INFO);
        let cipher = Aes256Gcm::new_from_slice(record_key.as_ref())
            .expect("an HKDF output of 32 bytes is an AES-256 key");
        Self { id, key, cipher }
    }

    pub(crate) fn id(&self) -> VaultId {
        self.id
    }

    pub(super) fn key(&self) -> &[u8; KEY_BYTES] {
        &self.key
    }

    pub(super) fn cipher(&self) -> &Aes256Gcm {
        &self.cipher
    }

    /// What this vault's devices present to the relay to enroll; the relay keeps only its
    /// [`enrollment_verifier`]. Anyone holding the vault key can derive it.
    pub(crate) fn enrollment_secret(&self) -> Zeroizing<[u8; KEY_BYTES]> {
        derive(&self.id, &self.key, ENROLLMENT_INFO)
    }

    /// The vault ID and key as Crockford base32 with a checksum, in groups of five, for printing.
    pub(crate) fn recovery_key(&self) -> Zeroizing<String> {
        recovery::encode(&self.id, &self.key)
    }

    /// Makes a vault and keeps it in `store`; refuses when the store already holds one, so a key
    /// that may be the only copy is never replaced.
    pub(crate) fn create(store: &dyn SecretStore) -> Result<Self, SyncError> {
        Self::keep_new(store, Self::generate()?)
    }

    /// Keeps the vault a recovery key holds in `store`, which must hold none yet.
    pub(crate) fn restore(store: &dyn SecretStore, recovery_key: &str) -> Result<Self, SyncError> {
        let (id, key) = recovery::decode(recovery_key)?;
        Self::keep_new(store, Self::from_parts(id, key))
    }

    pub(crate) fn load(store: &dyn SecretStore) -> Result<Option<Self>, SyncError> {
        store
            .read(ITEM_ACCOUNT)?
            .map(|item| Self::from_item(&item))
            .transpose()
    }

    /// Removes the vault from `store`; `false` when there was none.
    pub(crate) fn delete(store: &dyn SecretStore) -> Result<bool, SyncError> {
        store.remove(ITEM_ACCOUNT)
    }

    fn keep_new(store: &dyn SecretStore, vault: Self) -> Result<Self, SyncError> {
        if store.read(ITEM_ACCOUNT)?.is_some() {
            return Err(SyncError::VaultExists);
        }
        store.add(ITEM_ACCOUNT, &vault.item())?;
        Ok(vault)
    }

    fn item(&self) -> Zeroizing<Vec<u8>> {
        let mut item = Zeroizing::new(Vec::with_capacity(ITEM_BYTES));
        item.push(ITEM_VERSION);
        item.extend_from_slice(&self.id.0);
        item.extend_from_slice(self.key.as_ref());
        item
    }

    fn from_item(item: &[u8]) -> Result<Self, SyncError> {
        let [ITEM_VERSION, rest @ ..] = item else {
            return Err(SyncError::VaultCorrupt);
        };
        if rest.len() != ID_BYTES + KEY_BYTES {
            return Err(SyncError::VaultCorrupt);
        }
        let (id, key_bytes) = rest.split_at(ID_BYTES);
        let mut key = Zeroizing::new([0; KEY_BYTES]);
        key.copy_from_slice(key_bytes);
        let id = VaultId(id.try_into().map_err(|_| SyncError::VaultCorrupt)?);
        Ok(Self::from_parts(id, key))
    }
}

/// The relay's check for an enrollment secret: SHA-256 of its 32 bytes. The secret is uniformly
/// random, so a plain hash cannot be reversed by guessing.
pub(crate) fn enrollment_verifier(secret: &[u8; KEY_BYTES]) -> [u8; 32] {
    Sha256::digest(secret).into()
}

pub(super) fn random(bytes: &mut [u8]) -> Result<(), SyncError> {
    getrandom::fill(bytes).map_err(|_| SyncError::Random)
}

fn derive(id: &VaultId, key: &[u8; KEY_BYTES], info: &[u8]) -> Zeroizing<[u8; KEY_BYTES]> {
    let mut out = Zeroizing::new([0; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&id.0), key)
        .expand(info, out.as_mut())
        .expect("32 bytes is within HKDF-SHA256's output limit");
    out
}
