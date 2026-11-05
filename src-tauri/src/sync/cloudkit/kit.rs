//! The CloudKit primitives the native code exposes (`native::macos`, `native::ios`): just enough of
//! CloudKit's Objective-C API for the transport, as plain values. Everything else (zones, records,
//! batches, errors) is decided in safe Rust above it, against a fake in tests.

use std::fmt;
use std::path::PathBuf;

pub(crate) const CONTAINER: &str = "iCloud.io.github.jma49.devot";

/// One per Apple ID: `current`, pairing offers, each vault's epoch and its device rows.
pub(crate) const ZONE_DEVOT: &str = "devot";
/// One `DevotClock` per device, watched by no subscription, so a connect wakes no other device.
pub(crate) const ZONE_CLOCK: &str = "devot-clock";

pub(crate) fn vault_zone(vault: &str) -> String {
    format!("devot-{vault}")
}

pub(crate) const TYPE_RECORD: &str = "DevotRecord";
pub(crate) const TYPE_META: &str = "DevotMeta";
pub(crate) const TYPE_DEVICE: &str = "DevotDevice";
pub(crate) const TYPE_CLOCK: &str = "DevotClock";

/// A field value. A fetched asset arrives as `Bytes`: its file is read before the fetch ends.
#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Value {
    Int(i64),
    Text(String),
    Bytes(Vec<u8>),
    /// A staged file to upload as a `CKAsset`.
    Asset(PathBuf),
    /// Clears the field on save, so a chunk no longer used does not stay on the server's record.
    Null,
}

impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Int(n) => write!(f, "Int({n})"),
            Self::Text(t) => write!(f, "Text({} chars)", t.len()),
            Self::Bytes(b) => write!(f, "Bytes({} bytes)", b.len()),
            Self::Asset(_) => f.write_str("Asset"),
            Self::Null => f.write_str("Null"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CkRecord {
    pub name: String,
    pub kind: String,
    /// `encodeSystemFieldsWithCoder:` of the record as the server last gave it; `None` for one never
    /// saved, which a save creates.
    pub system: Option<Vec<u8>>,
    pub fields: Vec<(String, Value)>,
    /// The server's `modificationDate`, in milliseconds, on a fetched or saved record.
    pub modified: Option<i64>,
}

impl fmt::Debug for CkRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CkRecord")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl CkRecord {
    pub(crate) fn new(kind: &str, name: &str) -> Self {
        Self {
            name: name.to_string(),
            kind: kind.to_string(),
            system: None,
            fields: Vec::new(),
            modified: None,
        }
    }

    pub(crate) fn with(mut self, key: &str, value: Value) -> Self {
        self.set(key, value);
        self
    }

    pub(crate) fn set(&mut self, key: &str, value: Value) {
        match self.fields.iter_mut().find(|(k, _)| k == key) {
            Some((_, v)) => *v = value,
            None => self.fields.push((key.to_string(), value)),
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .filter(|v| **v != Value::Null)
    }

    pub(crate) fn int(&self, key: &str) -> Option<i64> {
        match self.get(key) {
            Some(Value::Int(n)) => Some(*n),
            _ => None,
        }
    }

    pub(crate) fn text(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Value::Text(t)) => Some(t),
            _ => None,
        }
    }

    pub(crate) fn bytes(&self, key: &str) -> Option<&[u8]> {
        match self.get(key) {
            Some(Value::Bytes(b)) => Some(b),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Account {
    Available,
    Missing,
    Restricted,
    TemporarilyUnavailable,
    CouldNotDetermine,
}

/// A CloudKit error: its `CKErrorCode` (or [`super::error::code::NATIVE`] when the native call
/// threw or returned nothing), the wait it asks for, and on `serverRecordChanged` the server's
/// record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CkError {
    pub code: i64,
    /// `CKErrorRetryAfterKey`, in milliseconds.
    pub retry_after_ms: Option<u64>,
    pub server_record: Option<Box<CkRecord>>,
}

impl CkError {
    pub(crate) fn of(code: i64) -> Self {
        Self {
            code,
            retry_after_ms: None,
            server_record: None,
        }
    }
}

/// A page of a zone's change feed. `token` is the archived `CKServerChangeToken` to fetch from next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Changes {
    pub records: Vec<CkRecord>,
    pub token: Vec<u8>,
    pub more: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SavePolicy {
    /// `.ifServerRecordUnchanged`: compare-and-swap on the system fields the record carries; a
    /// record without them is created, and refused when one of its name exists.
    IfUnchanged,
    /// `.changedKeys`: written whatever the server holds.
    Overwrite,
}

/// The private database of [`CONTAINER`]. Every call blocks until CloudKit answers.
pub(crate) trait CloudKit: Send + Sync {
    /// Whether this build carries the container's entitlement. Checked before anything touches
    /// `CKContainer`, which throws in a process without it.
    fn available(&self) -> bool;
    fn account(&self) -> Result<Account, CkError>;
    /// The `recordName` of the user's record ID: the same for every device on one Apple ID.
    fn user_record_name(&self) -> Result<String, CkError>;
    /// Whether each zone exists, in order.
    fn zones_exist(&self, zones: &[String]) -> Result<Vec<bool>, CkError>;
    fn save_zones(&self, zones: &[String]) -> Result<(), CkError>;
    /// The records of these names in `zone`, `None` for one that does not exist.
    fn fetch(&self, zone: &str, names: &[String]) -> Result<Vec<Option<CkRecord>>, CkError>;
    /// Saves not atomically: one result per record, in order, each the record as saved.
    fn save(
        &self,
        zone: &str,
        records: &[CkRecord],
        policy: SavePolicy,
    ) -> Result<Vec<Result<CkRecord, CkError>>, CkError>;
    /// At most `limit` changed records after `token` (`None`: from the start).
    fn changes(&self, zone: &str, token: Option<&[u8]>, limit: usize) -> Result<Changes, CkError>;
    /// A `CKRecordZoneSubscription` with silent pushes, saved under `id` (saving it again replaces it).
    fn subscribe(&self, zone: &str, id: &str) -> Result<(), CkError>;
}

/// A build with no native CloudKit (off Apple's platforms): never available.
pub(crate) struct Unavailable;

impl CloudKit for Unavailable {
    fn available(&self) -> bool {
        false
    }
    fn account(&self) -> Result<Account, CkError> {
        Err(unavailable())
    }
    fn user_record_name(&self) -> Result<String, CkError> {
        Err(unavailable())
    }
    fn zones_exist(&self, _: &[String]) -> Result<Vec<bool>, CkError> {
        Err(unavailable())
    }
    fn save_zones(&self, _: &[String]) -> Result<(), CkError> {
        Err(unavailable())
    }
    fn fetch(&self, _: &str, _: &[String]) -> Result<Vec<Option<CkRecord>>, CkError> {
        Err(unavailable())
    }
    fn save(
        &self,
        _: &str,
        _: &[CkRecord],
        _: SavePolicy,
    ) -> Result<Vec<Result<CkRecord, CkError>>, CkError> {
        Err(unavailable())
    }
    fn changes(&self, _: &str, _: Option<&[u8]>, _: usize) -> Result<Changes, CkError> {
        Err(unavailable())
    }
    fn subscribe(&self, _: &str, _: &str) -> Result<(), CkError> {
        Err(unavailable())
    }
}

fn unavailable() -> CkError {
    CkError::of(super::error::code::MISSING_ENTITLEMENT)
}
