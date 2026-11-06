use std::path::Path;
use std::ptr::NonNull;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{AllocAnyThread, ClassType};
use objc2_cloud_kit::{
    CKAccountStatus, CKAsset, CKContainer, CKDatabaseOperation, CKErrorDomain,
    CKErrorRetryAfterKey, CKFetchRecordZoneChangesConfiguration, CKFetchRecordZoneChangesOperation,
    CKFetchRecordZonesOperation, CKFetchRecordsOperation, CKModifyRecordZonesOperation,
    CKModifyRecordsOperation, CKModifySubscriptionsOperation, CKNotificationInfo, CKRecord,
    CKRecordChangedErrorServerRecordKey, CKRecordID, CKRecordSavePolicy, CKRecordValue,
    CKRecordZone, CKRecordZoneID, CKRecordZoneSubscription, CKServerChangeToken, CKSubscription,
};
use objc2_foundation::{
    NSArray, NSCoding, NSData, NSDictionary, NSError, NSKeyedArchiver, NSKeyedUnarchiver, NSNumber,
    NSQualityOfService, NSString, NSURL,
};

use crate::locks::lock;
use crate::native::guarded;
use crate::sync::cloudkit::error::code;
use crate::sync::cloudkit::kit::{
    Account, CONTAINER, Changes, CkError, CkRecord, CloudKit, SavePolicy, Value,
};

const WAIT: Duration = Duration::from_secs(120);
/// Uploads and downloads of assets take longer than a small request.
const WAIT_TRANSFER: Duration = Duration::from_secs(600);

pub(crate) struct Native {
    available: bool,
}

impl Native {
    /// `available` is the platform's answer to whether this build holds the container; without
    /// it, nothing here touches `CKContainer`.
    pub(crate) fn new(available: bool) -> Self {
        Self { available }
    }
}

/// iOS keeps no entitlement the app can read, so a build that may use CloudKit names its
/// container in Info.plist (`DevotCloudKitContainer`, written only on iCloud builds).
#[cfg(target_os = "ios")]
pub(crate) fn from_info_plist() -> bool {
    guarded("W_SYNC_ICLOUD_INFO_PLIST", || {
        let bundle = objc2_foundation::NSBundle::mainBundle();
        let value =
            bundle.objectForInfoDictionaryKey(&NSString::from_str("DevotCloudKitContainer"))?;
        let name = value.downcast_ref::<NSString>()?;
        Some(name.to_string() == CONTAINER)
    })
    .unwrap_or(false)
}

fn container() -> Retained<CKContainer> {
    // SAFETY: a container identifier is any string; CloudKit makes or finds the container.
    unsafe { CKContainer::containerWithIdentifier(&NSString::from_str(CONTAINER)) }
}

fn native_error() -> CkError {
    CkError::of(code::NATIVE)
}

/// Starts an operation inside `guarded` and waits for the one answer its blocks send.
fn run<T: 'static>(
    what: &'static str,
    wait: Duration,
    start: impl FnOnce(Sender<Result<T, CkError>>) -> Option<Retained<CKDatabaseOperation>>,
) -> Result<T, CkError> {
    let (sender, answer) = channel();
    let operation = guarded(what, || start(sender)).ok_or_else(native_error)?;
    match answer.recv_timeout(wait) {
        Ok(result) => result,
        Err(_) => {
            log::warn!("{what} E_SYNC_ICLOUD_TIMEOUT");
            let _ = guarded(what, || {
                operation.cancel();
                Some(())
            });
            Err(CkError::of(code::NETWORK_FAILURE))
        }
    }
}

fn add(operation: &CKDatabaseOperation) {
    operation.setQualityOfService(NSQualityOfService::UserInitiated);
    // SAFETY: the private database of the app's own container takes any database operation.
    unsafe { container().privateCloudDatabase().addOperation(operation) };
}

fn zone_id(zone: &str) -> Retained<CKRecordZoneID> {
    // SAFETY: a zone in the private database is named by the app and owned by the user, whom
    // `CKCurrentUserDefaultName` names.
    unsafe {
        CKRecordZoneID::initWithZoneName_ownerName(
            CKRecordZoneID::alloc(),
            &NSString::from_str(zone),
            objc2_cloud_kit::CKCurrentUserDefaultName,
        )
    }
}

fn record_id(name: &str, zone: &CKRecordZoneID) -> Retained<CKRecordID> {
    // SAFETY: record names are checked by the transport (letters, digits and '-').
    unsafe {
        CKRecordID::initWithRecordName_zoneID(CKRecordID::alloc(), &NSString::from_str(name), zone)
    }
}

/// `None` stays `None`; an error from CloudKit becomes its code, its wait and, for
/// `serverRecordChanged`, the server's record.
fn error_of(error: *mut NSError) -> Option<CkError> {
    // SAFETY: CloudKit passes a valid error or nil, retained for the block's call.
    let error = unsafe { error.as_ref() }?;
    // SAFETY: the CloudKit error keys are constant strings that live as long as the process.
    let (domain, retry_key, server_key) = unsafe {
        (
            CKErrorDomain,
            CKErrorRetryAfterKey,
            CKRecordChangedErrorServerRecordKey,
        )
    };
    if error.domain().to_string() != domain.to_string() {
        let network = error.domain().to_string() == "NSURLErrorDomain";
        return Some(CkError::of(if network {
            code::NETWORK_FAILURE
        } else {
            code::INTERNAL_ERROR
        }));
    }
    let info = error.userInfo();
    let retry_after_ms = info
        .objectForKey(retry_key)
        .and_then(|value| value.downcast_ref::<NSNumber>().map(|n| n.doubleValue()))
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| (seconds * 1000.0) as u64);
    let server_record = info
        .objectForKey(server_key)
        .and_then(|value| value.downcast_ref::<CKRecord>().map(|r| from_ck(r, false)))
        .flatten()
        .map(Box::new);
    Some(CkError {
        code: error.code() as i64,
        retry_after_ms,
        server_record,
    })
}

fn archive_system_fields(record: &CKRecord) -> Vec<u8> {
    let archiver = NSKeyedArchiver::initRequiringSecureCoding(NSKeyedArchiver::alloc(), true);
    // SAFETY: a keyed archiver is the coder `encodeSystemFieldsWithCoder:` documents.
    unsafe { record.encodeSystemFieldsWithCoder(&archiver) };
    archiver.finishEncoding();
    archiver.encodedData().to_vec()
}

fn unarchive_record(system: &[u8]) -> Option<Retained<CKRecord>> {
    let data = NSData::with_bytes(system);
    // SAFETY: the data is read with secure coding, which refuses any class but CKRecord's own.
    let unarchiver = unsafe {
        NSKeyedUnarchiver::initForReadingFromData_error(NSKeyedUnarchiver::alloc(), &data)
    }
    .ok()?;
    // SAFETY: as above; `initWithCoder:` is CKRecord's NSSecureCoding initializer, and the
    // unarchiver is finished once it has read the record.
    unsafe {
        unarchiver.setRequiresSecureCoding(true);
        let record = CKRecord::initWithCoder(CKRecord::alloc(), &unarchiver);
        unarchiver.finishDecoding();
        record
    }
}

fn archive_token(token: &CKServerChangeToken) -> Option<Vec<u8>> {
    // SAFETY: a change token supports secure coding, which the archive is made with.
    unsafe { NSKeyedArchiver::archivedDataWithRootObject_requiringSecureCoding_error(token, true) }
        .ok()
        .map(|data| data.to_vec())
}

fn unarchive_token(bytes: &[u8]) -> Option<Retained<CKServerChangeToken>> {
    let data = NSData::with_bytes(bytes);
    // SAFETY: secure coding with the one class allowed, so nothing else is made from the data.
    unsafe {
        NSKeyedUnarchiver::unarchivedObjectOfClass_fromData_error(
            CKServerChangeToken::class(),
            &data,
        )
    }
    .ok()?
    .downcast::<CKServerChangeToken>()
    .ok()
}

fn set_value(record: &CKRecord, key: &str, value: &Value) -> Option<()> {
    let key = NSString::from_str(key);
    let object: Option<Retained<ProtocolObject<dyn CKRecordValue>>> = match value {
        Value::Int(n) => Some(ProtocolObject::from_retained(NSNumber::new_i64(*n))),
        Value::Text(text) => Some(ProtocolObject::from_retained(NSString::from_str(text))),
        Value::Bytes(bytes) => Some(ProtocolObject::from_retained(NSData::with_bytes(bytes))),
        Value::Asset(path) => {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
            // SAFETY: the file is a staged chunk that stays until the operation has ended.
            let asset = unsafe { CKAsset::initWithFileURL(CKAsset::alloc(), &url) };
            Some(ProtocolObject::from_retained(asset))
        }
        Value::Null => None,
    };
    // SAFETY: the values are the CKRecordValue classes CloudKit stores; nil removes the key.
    unsafe { record.setObject_forKey(object.as_deref(), &key) };
    Some(())
}

fn value_of(object: &AnyObject, with_assets: bool) -> Option<Value> {
    if let Some(number) = object.downcast_ref::<NSNumber>() {
        return Some(Value::Int(number.longLongValue()));
    }
    if let Some(text) = object.downcast_ref::<NSString>() {
        return Some(Value::Text(text.to_string()));
    }
    if let Some(data) = object.downcast_ref::<NSData>() {
        return Some(Value::Bytes(data.to_vec()));
    }
    if let Some(asset) = object.downcast_ref::<CKAsset>() {
        if !with_assets {
            return None;
        }
        // SAFETY: a fetched asset's file URL; its file lasts until the operation ends, and is
        // read here, inside the operation's block.
        let url = unsafe { asset.fileURL() }?;
        let path = url.path()?.to_string();
        return std::fs::read(Path::new(&path)).ok().map(Value::Bytes);
    }
    None
}

/// `None` when a call threw or returned nothing; `BAD_TAG` when the tag is not this record's
/// archive.
fn to_ck(zone: &CKRecordZoneID, record: &CkRecord) -> Option<Result<Retained<CKRecord>, CkError>> {
    let ck = match &record.system {
        Some(system) => {
            let Some(ck) = unarchive_record(system) else {
                return Some(Err(CkError::of(code::BAD_TAG)));
            };
            // SAFETY: plain accessors of a record made just now.
            let (name, zone_name) = unsafe {
                let id = ck.recordID();
                (
                    id.recordName().to_string(),
                    id.zoneID().zoneName().to_string(),
                )
            };
            // SAFETY: as above.
            let zone_wanted = unsafe { zone.zoneName() }.to_string();
            if name != record.name || zone_name != zone_wanted {
                return Some(Err(CkError::of(code::BAD_TAG)));
            }
            ck
        }
        // SAFETY: a record type is any name the app uses; the ID is in the app's own zone.
        None => unsafe {
            CKRecord::initWithRecordType_recordID(
                CKRecord::alloc(),
                &NSString::from_str(&record.kind),
                &record_id(&record.name, zone),
            )
        },
    };
    for (key, value) in &record.fields {
        set_value(&ck, key, value)?;
    }
    Some(Ok(ck))
}

fn from_ck(record: &CKRecord, with_assets: bool) -> Option<CkRecord> {
    // SAFETY: plain accessors of a record CloudKit handed over for this call.
    let (name, kind, keys, modified) = unsafe {
        (
            record.recordID().recordName().to_string(),
            record.recordType().to_string(),
            record.allKeys(),
            record.modificationDate(),
        )
    };
    let mut out = CkRecord::new(&kind, &name);
    out.system = Some(archive_system_fields(record));
    out.modified = modified.map(|date| (date.timeIntervalSince1970() * 1000.0) as i64);
    for key in keys.iter() {
        // SAFETY: a key the record just listed.
        let Some(object) = (unsafe { record.objectForKey(&key) }) else {
            continue;
        };
        let any: &AnyObject = object.as_ref();
        if let Some(value) = value_of(any, with_assets) {
            out.set(&key.to_string(), value);
        }
    }
    Some(out)
}

fn converted(record: *mut CKRecord, with_assets: bool) -> Option<CkRecord> {
    // SAFETY: CloudKit passes a valid record or nil, retained for the block's call.
    let record = unsafe { record.as_ref() }?;
    guarded("W_SYNC_ICLOUD_RECORD_READ", || from_ck(record, with_assets))
}

impl CloudKit for Native {
    fn available(&self) -> bool {
        self.available
    }

    fn account(&self) -> Result<Account, CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let (sender, answer) = channel();
        guarded("W_SYNC_ICLOUD_ACCOUNT", || {
            let block = RcBlock::new(move |status: CKAccountStatus, error: *mut NSError| {
                let result = match error_of(error) {
                    Some(error) => Err(error),
                    None => Ok(match status {
                        CKAccountStatus::Available => Account::Available,
                        CKAccountStatus::NoAccount => Account::Missing,
                        CKAccountStatus::Restricted => Account::Restricted,
                        CKAccountStatus::TemporarilyUnavailable => Account::TemporarilyUnavailable,
                        _ => Account::CouldNotDetermine,
                    }),
                };
                let _ = sender.send(result);
            });
            // SAFETY: the block takes the status and an optional error, as CloudKit calls it.
            unsafe { container().accountStatusWithCompletionHandler(&block) };
            Some(())
        })
        .ok_or_else(native_error)?;
        answer
            .recv_timeout(WAIT)
            .unwrap_or(Err(CkError::of(code::NETWORK_FAILURE)))
    }

    fn user_record_name(&self) -> Result<String, CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let (sender, answer) = channel();
        guarded("W_SYNC_ICLOUD_USER", || {
            let block = RcBlock::new(move |id: *mut CKRecordID, error: *mut NSError| {
                let result = match error_of(error) {
                    Some(error) => Err(error),
                    None => {
                        // SAFETY: CloudKit passes a valid record ID or nil with an error, and
                        // `recordName` is a plain accessor.
                        unsafe { id.as_ref().map(|id| id.recordName().to_string()) }
                            .ok_or_else(native_error)
                    }
                };
                let _ = sender.send(result);
            });
            // SAFETY: the block takes an optional record ID and error, as CloudKit calls it.
            unsafe { container().fetchUserRecordIDWithCompletionHandler(&block) };
            Some(())
        })
        .ok_or_else(native_error)?;
        answer
            .recv_timeout(WAIT)
            .unwrap_or(Err(CkError::of(code::NETWORK_FAILURE)))
    }

    fn zones_exist(&self, zones: &[String]) -> Result<Vec<bool>, CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let found = Arc::new(Mutex::new(Vec::<String>::new()));
        let missing = Arc::new(Mutex::new(Option::<CkError>::None));
        let (seen, failed) = (Arc::clone(&found), Arc::clone(&missing));
        let ids: Vec<_> = zones.iter().map(|zone| zone_id(zone)).collect();
        run("W_SYNC_ICLOUD_ZONES", WAIT, move |sender| {
            // SAFETY: the zone IDs are the app's own.
            let operation = unsafe {
                CKFetchRecordZonesOperation::initWithRecordZoneIDs(
                    CKFetchRecordZonesOperation::alloc(),
                    &NSArray::from_retained_slice(&ids),
                )
            };
            let per_zone = RcBlock::new(
                move |id: NonNull<CKRecordZoneID>, zone: *mut CKRecordZone, error: *mut NSError| {
                    // SAFETY: CloudKit passes the zone ID it asked about.
                    let name = unsafe { id.as_ref().zoneName() }.to_string();
                    match error_of(error) {
                        Some(error)
                            if matches!(
                                error.code,
                                code::ZONE_NOT_FOUND | code::USER_DELETED_ZONE
                            ) => {}
                        Some(error) => *lock(&failed) = Some(error),
                        None if !zone.is_null() => lock(&seen).push(name),
                        None => {}
                    }
                },
            );
            let missing = Arc::clone(&missing);
            let done = RcBlock::new(
                move |_: *mut NSDictionary<CKRecordZoneID, CKRecordZone>, error: *mut NSError| {
                    let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                    let _ = sender.send(match whole.or_else(|| lock(&missing).take()) {
                        Some(error) => Err(error),
                        None => Ok(()),
                    });
                },
            );
            // SAFETY: each block's arguments are as CloudKit documents them for this operation.
            unsafe {
                operation.setPerRecordZoneCompletionBlock(Some(&per_zone));
                operation.setFetchRecordZonesCompletionBlock(Some(&done));
            }
            add(&operation);
            Some(Retained::into_super(operation))
        })?;
        let found = lock(&found);
        Ok(zones.iter().map(|zone| found.contains(zone)).collect())
    }

    fn save_zones(&self, zones: &[String]) -> Result<(), CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let zones: Vec<_> = zones
            .iter()
            // SAFETY: a zone named by the app in its private database.
            .map(|zone| unsafe {
                CKRecordZone::initWithZoneName(CKRecordZone::alloc(), &NSString::from_str(zone))
            })
            .collect();
        run("W_SYNC_ICLOUD_ZONES_SAVE", WAIT, move |sender| {
            // SAFETY: zones to save and none to delete.
            let operation = unsafe {
                CKModifyRecordZonesOperation::initWithRecordZonesToSave_recordZoneIDsToDelete(
                    CKModifyRecordZonesOperation::alloc(),
                    Some(&NSArray::from_retained_slice(&zones)),
                    None,
                )
            };
            let done = RcBlock::new(
                move |_: *mut NSArray<CKRecordZone>,
                      _: *mut NSArray<CKRecordZoneID>,
                      error: *mut NSError| {
                    let _ = sender.send(error_of(error).map_or(Ok(()), Err));
                },
            );
            // SAFETY: the block's arguments are as CloudKit documents them for this operation.
            unsafe { operation.setModifyRecordZonesCompletionBlock(Some(&done)) };
            add(&operation);
            Some(Retained::into_super(operation))
        })
    }

    fn delete_zones(&self, zones: &[String]) -> Result<(), CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let failed = Arc::new(Mutex::new(Option::<CkError>::None));
        let seen = Arc::clone(&failed);
        let ids: Vec<_> = zones.iter().map(|zone| zone_id(zone)).collect();
        run("W_SYNC_ICLOUD_ZONES_DELETE", WAIT, move |sender| {
            // SAFETY: none to save and the app's own zone IDs to delete.
            let operation = unsafe {
                CKModifyRecordZonesOperation::initWithRecordZonesToSave_recordZoneIDsToDelete(
                    CKModifyRecordZonesOperation::alloc(),
                    None,
                    Some(&NSArray::from_retained_slice(&ids)),
                )
            };
            let per_zone =
                RcBlock::new(
                    move |_: NonNull<CKRecordZoneID>, error: *mut NSError| match error_of(error) {
                        Some(error)
                            if matches!(
                                error.code,
                                code::ZONE_NOT_FOUND | code::USER_DELETED_ZONE
                            ) => {}
                        Some(error) => *lock(&seen) = Some(error),
                        None => {}
                    },
                );
            let done = RcBlock::new(
                move |_: *mut NSArray<CKRecordZone>,
                      _: *mut NSArray<CKRecordZoneID>,
                      error: *mut NSError| {
                    let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                    let _ = sender.send(match whole.or_else(|| lock(&failed).take()) {
                        Some(error) => Err(error),
                        None => Ok(()),
                    });
                },
            );
            // SAFETY: each block's arguments are as CloudKit documents them for this operation.
            unsafe {
                operation.setPerRecordZoneDeleteBlock(Some(&per_zone));
                operation.setModifyRecordZonesCompletionBlock(Some(&done));
            }
            add(&operation);
            Some(Retained::into_super(operation))
        })
    }

    fn fetch(&self, zone: &str, names: &[String]) -> Result<Vec<Option<CkRecord>>, CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let zone = zone_id(zone);
        let ids: Vec<_> = names.iter().map(|name| record_id(name, &zone)).collect();
        let got = Arc::new(Mutex::new(Vec::<(String, Result<CkRecord, CkError>)>::new()));
        let into = Arc::clone(&got);
        run("W_SYNC_ICLOUD_FETCH", WAIT_TRANSFER, move |sender| {
            // SAFETY: record IDs in the app's own zone.
            let operation = unsafe {
                CKFetchRecordsOperation::initWithRecordIDs(
                    CKFetchRecordsOperation::alloc(),
                    &NSArray::from_retained_slice(&ids),
                )
            };
            let per_record = RcBlock::new(
                move |record: *mut CKRecord, id: *mut CKRecordID, error: *mut NSError| {
                    // SAFETY: CloudKit passes the record ID it asked about, or nil, and
                    // `recordName` is a plain accessor.
                    let Some(name) = (unsafe { id.as_ref().map(|id| id.recordName().to_string()) })
                    else {
                        return;
                    };
                    let result = match error_of(error) {
                        Some(error) => Err(error),
                        None => converted(record, true).ok_or_else(native_error),
                    };
                    lock(&into).push((name, result));
                },
            );
            let done = RcBlock::new(
                move |_: *mut NSDictionary<CKRecordID, CKRecord>, error: *mut NSError| {
                    let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                    let _ = sender.send(whole.map_or(Ok(()), Err));
                },
            );
            // SAFETY: each block's arguments are as CloudKit documents them for this operation.
            #[allow(deprecated)]
            unsafe {
                operation.setPerRecordCompletionBlock(Some(&per_record));
                operation.setFetchRecordsCompletionBlock(Some(&done));
            }
            add(&operation);
            Some(Retained::into_super(operation))
        })?;
        let mut got = lock(&got);
        names
            .iter()
            .map(|name| {
                match got
                    .iter()
                    .position(|(n, _)| n == name)
                    .map(|at| got.remove(at).1)
                {
                    Some(Ok(record)) => Ok(Some(record)),
                    Some(Err(error)) if error.code == code::UNKNOWN_ITEM => Ok(None),
                    Some(Err(error)) => Err(error),
                    None => Ok(None),
                }
            })
            .collect()
    }

    fn save(
        &self,
        zone: &str,
        records: &[CkRecord],
        policy: SavePolicy,
    ) -> Result<Vec<Result<CkRecord, CkError>>, CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let zone = zone_id(zone);
        let built: Vec<Result<Retained<CKRecord>, CkError>> = records
            .iter()
            .map(|record| {
                guarded("W_SYNC_ICLOUD_RECORD_BUILD", || to_ck(&zone, record))
                    .unwrap_or_else(|| Err(native_error()))
            })
            .collect();
        let sending: Vec<Retained<CKRecord>> = built
            .iter()
            .filter_map(|b| b.as_ref().ok())
            .cloned()
            .collect();
        let got = Arc::new(Mutex::new(Vec::<(String, Result<CkRecord, CkError>)>::new()));
        if !sending.is_empty() {
            let into = Arc::clone(&got);
            run("W_SYNC_ICLOUD_SAVE", WAIT_TRANSFER, move |sender| {
                // SAFETY: records to save and none to delete; records are never deleted.
                let operation = unsafe {
                    CKModifyRecordsOperation::initWithRecordsToSave_recordIDsToDelete(
                        CKModifyRecordsOperation::alloc(),
                        Some(&NSArray::from_retained_slice(&sending)),
                        None,
                    )
                };
                let per_record = RcBlock::new(
                    move |id: NonNull<CKRecordID>, record: *mut CKRecord, error: *mut NSError| {
                        // SAFETY: CloudKit passes the ID of a record this operation saved.
                        let name = unsafe { id.as_ref().recordName() }.to_string();
                        let result = match error_of(error) {
                            Some(error) => Err(error),
                            None => converted(record, false).ok_or_else(native_error),
                        };
                        lock(&into).push((name, result));
                    },
                );
                let done = RcBlock::new(
                    move |_: *mut NSArray<CKRecord>,
                          _: *mut NSArray<CKRecordID>,
                          error: *mut NSError| {
                        let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                        let _ = sender.send(whole.map_or(Ok(()), Err));
                    },
                );
                // SAFETY: each block's arguments are as CloudKit documents them; the policy
                // is one of CloudKit's own.
                unsafe {
                    operation.setSavePolicy(match policy {
                        SavePolicy::IfUnchanged => CKRecordSavePolicy::IfServerRecordUnchanged,
                        SavePolicy::Overwrite => CKRecordSavePolicy::ChangedKeys,
                    });
                    operation.setAtomic(false);
                    operation.setPerRecordSaveBlock(Some(&per_record));
                    operation.setModifyRecordsCompletionBlock(Some(&done));
                }
                add(&operation);
                Some(Retained::into_super(operation))
            })?;
        }
        let mut got = lock(&got);
        Ok(records
            .iter()
            .zip(&built)
            .map(|(record, built)| {
                if let Err(e) = built {
                    return Err(e.clone());
                }
                got.iter()
                    .position(|(n, _)| *n == record.name)
                    .map_or(Err(CkError::of(code::INTERNAL_ERROR)), |at| {
                        got.remove(at).1
                    })
            })
            .collect())
    }

    fn changes(&self, zone: &str, token: Option<&[u8]>, limit: usize) -> Result<Changes, CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let previous = match token {
            Some(bytes) => {
                Some(unarchive_token(bytes).ok_or(CkError::of(code::CHANGE_TOKEN_EXPIRED))?)
            }
            None => None,
        };
        let zone = zone_id(zone);
        let records = Arc::new(Mutex::new(Vec::<CkRecord>::new()));
        let end = Arc::new(Mutex::new(Option::<Result<(Vec<u8>, bool), CkError>>::None));
        let (into, ended) = (Arc::clone(&records), Arc::clone(&end));
        run("W_SYNC_ICLOUD_CHANGES", WAIT_TRANSFER, move |sender| {
            // SAFETY: a plain configuration object; the token was archived by this code.
            let configuration = unsafe {
                let configuration = CKFetchRecordZoneChangesConfiguration::new();
                configuration.setPreviousServerChangeToken(previous.as_deref());
                configuration.setResultsLimit(limit);
                configuration
            };
            let configurations = NSDictionary::from_retained_objects(&[&*zone], &[configuration]);
            // SAFETY: one zone of the app's own and its configuration.
            let operation = unsafe {
                CKFetchRecordZoneChangesOperation::initWithRecordZoneIDs_configurationsByRecordZoneID(
                    CKFetchRecordZoneChangesOperation::alloc(),
                    &NSArray::from_retained_slice(std::slice::from_ref(&zone)),
                    Some(&configurations),
                )
            };
            let changed = RcBlock::new(
                move |_: NonNull<CKRecordID>, record: *mut CKRecord, error: *mut NSError| {
                    if error_of(error).is_none()
                        && let Some(record) = converted(record, true)
                    {
                        lock(&into).push(record);
                    }
                },
            );
            let zone_done = RcBlock::new(
                move |_: NonNull<CKRecordZoneID>,
                      token: *mut CKServerChangeToken,
                      _: *mut NSData,
                      more: Bool,
                      error: *mut NSError| {
                    let result = match error_of(error) {
                        Some(error) => Err(error),
                        // SAFETY: CloudKit passes a valid token or nil.
                        None => unsafe { token.as_ref() }
                            .and_then(archive_token)
                            .map(|token| (token, more.as_bool()))
                            .ok_or_else(native_error),
                    };
                    *lock(&ended) = Some(result);
                },
            );
            let end = Arc::clone(&end);
            let done = RcBlock::new(move |error: *mut NSError| {
                let zone = lock(&end).take();
                let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                let _ = sender.send(match (zone, whole) {
                    (Some(result), _) => result,
                    (None, Some(error)) => Err(error),
                    (None, None) => Err(native_error()),
                });
            });
            // SAFETY: each block's arguments are as CloudKit documents them for this operation;
            // one page per operation, so the transport pages with its own cursor.
            unsafe {
                operation.setFetchAllChanges(false);
                operation.setRecordWasChangedBlock(Some(&changed));
                operation.setRecordZoneFetchCompletionBlock(Some(&zone_done));
                operation.setFetchRecordZoneChangesCompletionBlock(Some(&done));
            }
            add(&operation);
            Some(Retained::into_super(operation))
        })
        .map(|(token, more)| Changes {
            records: std::mem::take(&mut *lock(&records)),
            token,
            more,
        })
    }

    fn subscribe(&self, zone: &str, id: &str) -> Result<(), CkError> {
        if !self.available {
            return Err(CkError::of(code::MISSING_ENTITLEMENT));
        }
        let zone = zone_id(zone);
        let id = NSString::from_str(id);
        run("W_SYNC_ICLOUD_SUBSCRIBE", WAIT, move |sender| {
            // SAFETY: a zone subscription with a silent notice, which wakes the app without an
            // alert; the IDs are the app's own.
            let subscription = unsafe {
                let subscription = CKRecordZoneSubscription::initWithZoneID_subscriptionID(
                    CKRecordZoneSubscription::alloc(),
                    &zone,
                    &id,
                );
                let info = CKNotificationInfo::new();
                info.setShouldSendContentAvailable(true);
                subscription.setNotificationInfo(Some(&info));
                subscription
            };
            let subscriptions: [Retained<CKSubscription>; 1] = [Retained::into_super(subscription)];
            // SAFETY: subscriptions to save and none to delete.
            let operation = unsafe {
                CKModifySubscriptionsOperation::initWithSubscriptionsToSave_subscriptionIDsToDelete(
                    CKModifySubscriptionsOperation::alloc(),
                    Some(&NSArray::from_retained_slice(&subscriptions)),
                    None,
                )
            };
            let done = RcBlock::new(
                move |_: *mut NSArray<CKSubscription>,
                      _: *mut NSArray<NSString>,
                      error: *mut NSError| {
                    let _ = sender.send(error_of(error).map_or(Ok(()), Err));
                },
            );
            // SAFETY: the block's arguments are as CloudKit documents them for this operation.
            unsafe { operation.setModifySubscriptionsCompletionBlock(Some(&done)) };
            add(&operation);
            Some(Retained::into_super(operation))
        })
    }
}

/// Calls `on_change` on each `CKAccountChanged`, for the life of the process.
pub(crate) fn observe_account(on_change: Box<dyn Fn() + Send + Sync>) {
    let _ = guarded("W_SYNC_ICLOUD_ACCOUNT_OBSERVE", || {
        let block = RcBlock::new(move |_: NonNull<objc2_foundation::NSNotification>| {
            use std::panic::{AssertUnwindSafe, catch_unwind};
            if catch_unwind(AssertUnwindSafe(&on_change)).is_err() {
                log::warn!("W_SYNC_ICLOUD_ACCOUNT_PANIC");
            }
        });
        // SAFETY: the notice's name is CloudKit's constant; with no queue the block runs on the
        // posting thread, and it only calls the service, which is thread-safe.
        let observer = unsafe {
            objc2_foundation::NSNotificationCenter::defaultCenter()
                .addObserverForName_object_queue_usingBlock(
                    Some(objc2_cloud_kit::CKAccountChangedNotification),
                    None,
                    None,
                    &block,
                )
        };
        // The observer is kept for the life of the process.
        std::mem::forget(observer);
        Some(())
    });
}
