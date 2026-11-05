//! What a CloudKit error means to the transport (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md,
//! the relay protocol's mapping and Threats and failures). A pure function of the error, so every
//! code is tested without CloudKit.

use super::kit::CkError;

/// `CKErrorCode` values (CloudKit's `CKError.h`), and one of Devot's own.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub(crate) mod code {
    pub(crate) const INTERNAL_ERROR: i64 = 1;
    pub(crate) const PARTIAL_FAILURE: i64 = 2;
    pub(crate) const NETWORK_UNAVAILABLE: i64 = 3;
    pub(crate) const NETWORK_FAILURE: i64 = 4;
    pub(crate) const BAD_CONTAINER: i64 = 5;
    pub(crate) const SERVICE_UNAVAILABLE: i64 = 6;
    pub(crate) const REQUEST_RATE_LIMITED: i64 = 7;
    pub(crate) const MISSING_ENTITLEMENT: i64 = 8;
    pub(crate) const NOT_AUTHENTICATED: i64 = 9;
    #[cfg(test)]
    pub(crate) const PERMISSION_FAILURE: i64 = 10;
    pub(crate) const UNKNOWN_ITEM: i64 = 11;
    pub(crate) const SERVER_RECORD_CHANGED: i64 = 14;
    #[cfg(test)]
    pub(crate) const SERVER_REJECTED_REQUEST: i64 = 15;
    pub(crate) const OPERATION_CANCELLED: i64 = 20;
    pub(crate) const CHANGE_TOKEN_EXPIRED: i64 = 21;
    pub(crate) const BATCH_REQUEST_FAILED: i64 = 22;
    pub(crate) const ZONE_BUSY: i64 = 23;
    pub(crate) const QUOTA_EXCEEDED: i64 = 25;
    pub(crate) const ZONE_NOT_FOUND: i64 = 26;
    pub(crate) const LIMIT_EXCEEDED: i64 = 27;
    pub(crate) const USER_DELETED_ZONE: i64 = 28;
    pub(crate) const MANAGED_ACCOUNT_RESTRICTED: i64 = 32;
    pub(crate) const SERVER_RESPONSE_LOST: i64 = 34;
    pub(crate) const ACCOUNT_TEMPORARILY_UNAVAILABLE: i64 = 36;
    /// Devot's: the native call threw an Objective-C exception, panicked or returned nothing.
    pub(crate) const NATIVE: i64 = -1;
    /// Devot's: a record's tag is not the archive of that record's system fields.
    pub(crate) const BAD_TAG: i64 = -2;
}

pub(crate) const UNAVAILABLE: &str = "E_SYNC_CLOUDKIT_UNAVAILABLE";
pub(crate) const SIGNED_OUT: &str = "E_SYNC_ICLOUD_SIGNED_OUT";
pub(crate) const RESTRICTED: &str = "E_SYNC_ICLOUD_RESTRICTED";
pub(crate) const ACCOUNT_CHANGED: &str = "E_SYNC_ICLOUD_ACCOUNT_CHANGED";
pub(crate) const DELETED: &str = "E_SYNC_ICLOUD_DELETED";
pub(crate) const FULL: &str = "E_SYNC_ICLOUD_FULL";
/// A timed pause: rate limited or CloudKit busy, for the wait CloudKit asked.
pub(crate) const BUSY: &str = "E_SYNC_ICLOUD_BUSY";
/// The vault's zone went missing while connected; the next connect stops or makes it again.
pub(crate) const ZONE_MISSING: &str = "E_SYNC_ICLOUD_ZONE_MISSING";
pub(crate) const FAILED: &str = "E_SYNC_ICLOUD_FAILED";
pub(crate) const OFFLINE: &str = "E_SYNC_OFFLINE";
pub(crate) const TOO_LARGE: &str = "E_SYNC_TOO_LARGE";
pub(crate) const TAG_INVALID: &str = "E_SYNC_TAG_INVALID";

/// The wait when a busy CloudKit names none.
pub(crate) const DEFAULT_RETRY_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Failure {
    /// `serverRecordChanged`: another device saved first; the error carries the server's record.
    Changed,
    /// Rate limited, the zone busy, or the service down: wait this long.
    Busy {
        retry_after_ms: u64,
    },
    /// The owner's iCloud storage is full.
    Full,
    /// The change token is too old: pull from the start.
    TokenExpired,
    /// `zoneNotFound` or `userDeletedZone`.
    ZoneGone,
    /// The request was too large: halve the batch.
    TooMany,
    /// The item's tag is not a record's archive: that item fails.
    BadTag,
    /// Not this item's fault (a batch it was in failed): send it again.
    Again,
    Offline,
    SignedOut,
    Restricted,
    /// This build may not use the container.
    Unavailable,
    /// Anything else, by its CloudKit code (logged, never shown).
    Other(i64),
}

pub(crate) fn classify(error: &CkError) -> Failure {
    use code::*;
    match error.code {
        SERVER_RECORD_CHANGED => Failure::Changed,
        REQUEST_RATE_LIMITED | ZONE_BUSY | SERVICE_UNAVAILABLE => Failure::Busy {
            retry_after_ms: error.retry_after_ms.unwrap_or(DEFAULT_RETRY_MS),
        },
        QUOTA_EXCEEDED => Failure::Full,
        CHANGE_TOKEN_EXPIRED => Failure::TokenExpired,
        ZONE_NOT_FOUND | USER_DELETED_ZONE => Failure::ZoneGone,
        LIMIT_EXCEEDED => Failure::TooMany,
        BATCH_REQUEST_FAILED => Failure::Again,
        NETWORK_UNAVAILABLE
        | NETWORK_FAILURE
        | SERVER_RESPONSE_LOST
        | OPERATION_CANCELLED
        | ACCOUNT_TEMPORARILY_UNAVAILABLE => Failure::Offline,
        NOT_AUTHENTICATED => Failure::SignedOut,
        MANAGED_ACCOUNT_RESTRICTED => Failure::Restricted,
        MISSING_ENTITLEMENT | BAD_CONTAINER => Failure::Unavailable,
        BAD_TAG => Failure::BadTag,
        other => Failure::Other(other),
    }
}

impl Failure {
    /// The code a call that fails this way rejects with.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Busy { .. } => BUSY,
            Self::Full => FULL,
            Self::ZoneGone => ZONE_MISSING,
            Self::TooMany => TOO_LARGE,
            Self::BadTag => TAG_INVALID,
            Self::Offline | Self::Again => OFFLINE,
            Self::SignedOut => SIGNED_OUT,
            Self::Restricted => RESTRICTED,
            Self::Unavailable => UNAVAILABLE,
            Self::Changed | Self::TokenExpired | Self::Other(_) => FAILED,
        }
    }
}

/// What one record's refused save becomes for the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refused {
    /// Merge with the server's record, then push against its tag.
    Rejected { server: Box<super::kit::CkRecord> },
    /// Pushes wait: until `until` (milliseconds, the transport's clock), or with no end.
    Paused {
        until: Option<i64>,
        code: &'static str,
    },
    /// This item failed with a code; the pass decides whether it goes on.
    Failed(&'static str),
    /// Send it again (its batch was too large, or failed because of another record).
    Again,
}

/// The pure mapping of a refused save, at `now` (milliseconds).
pub(crate) fn refused(error: &CkError, now: i64) -> Refused {
    match classify(error) {
        Failure::Changed => match &error.server_record {
            Some(server) => Refused::Rejected {
                server: server.clone(),
            },
            None => Refused::Failed(FAILED),
        },
        Failure::Busy { retry_after_ms } => Refused::Paused {
            until: Some(now.saturating_add(i64::try_from(retry_after_ms).unwrap_or(i64::MAX))),
            code: BUSY,
        },
        Failure::Full => Refused::Paused {
            until: None,
            code: FULL,
        },
        Failure::TooMany | Failure::Again => Refused::Again,
        other => Refused::Failed(other.code()),
    }
}
