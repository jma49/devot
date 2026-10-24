use std::fmt;

/// A sync key or record failure, by code. No variant can hold key material or record content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncError {
    RecordId,
    RecordTooLarge,
    NoChunks,
    ChunkSize,
    ChunkFormat,
    ChunkAuth,
    Random,
    /// The Security framework's `OSStatus`.
    Keychain(i32),
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    KeychainUnavailable,
    VaultExists,
    VaultCorrupt,
    RecoveryFormat,
    RecoveryChecksum,
    RecoveryVersion,
}

impl SyncError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::RecordId => "E_SYNC_RECORD_ID",
            Self::RecordTooLarge => "E_SYNC_RECORD_TOO_LARGE",
            Self::NoChunks => "E_SYNC_RECORD_NO_CHUNKS",
            Self::ChunkSize => "E_SYNC_CHUNK_SIZE",
            Self::ChunkFormat => "E_SYNC_CHUNK_FORMAT",
            Self::ChunkAuth => "E_SYNC_CHUNK_AUTH",
            Self::Random => "E_SYNC_RANDOM",
            Self::Keychain(_) => "E_SYNC_KEYCHAIN",
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            Self::KeychainUnavailable => "E_SYNC_KEYCHAIN_UNAVAILABLE",
            Self::VaultExists => "E_SYNC_VAULT_EXISTS",
            Self::VaultCorrupt => "E_SYNC_VAULT_CORRUPT",
            Self::RecoveryFormat => "E_SYNC_RECOVERY_FORMAT",
            Self::RecoveryChecksum => "E_SYNC_RECOVERY_CHECKSUM",
            Self::RecoveryVersion => "E_SYNC_RECOVERY_VERSION",
        }
    }
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Keychain(status) => write!(f, "{} {status}", self.code()),
            _ => f.write_str(self.code()),
        }
    }
}

impl std::error::Error for SyncError {}
