//! The iCloud transport (ADR 0015): the relay's connect, pull and push over the CloudKit
//! primitives. Records are sealed as on a relay; CloudKit sees sealed chunks, their sizes and the
//! record IDs. The cursor is the vault zone's archived change token and a record's tag its archived
//! system fields, both base64, both opaque to the engine.

use std::collections::VecDeque;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::batch;
use super::encoding::{self, Size};
use super::error::{self, Failure, Refused, classify};
use super::kit::{
    Account, CkError, CkRecord, CloudKit, SavePolicy, TYPE_CLOCK, TYPE_DEVICE, TYPE_META, Value,
    ZONE_CLOCK, ZONE_DEVOT, vault_zone,
};
use super::staging::Staging;
use crate::sync::Vault;

/// Records per page of the change feed. Each may carry up to 16 assets of 1.9 MB, all held until
/// the page is handed on.
pub(crate) const PULL_LIMIT: usize = 25;
const DAY_MS: i64 = 86_400_000;
const ACCOUNT_LABEL: &[u8] = b"devot/icloud/account/v1";
const NAME_LABEL: &[u8] = b"devot/icloud/device-name/v1";
pub(crate) const ACCOUNT_UNAVAILABLE: &str = "E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE";
const CURSOR_INVALID: &str = "E_SYNC_CURSOR_INVALID";
const TAG_INVALID: &str = "E_SYNC_TAG_INVALID";

/// What this device keeps of the vault it syncs through iCloud, in `sync-settings.json`. No
/// secret: IDs, a hash of the Apple ID's user record and dates.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ICloudState {
    /// The vault on iCloud; a device holding another vault syncs through the relay.
    pub vault: String,
    /// This device's ID in the vault, random, kept beside it.
    pub device: String,
    /// The user record's hash, from the first connect; '' before it.
    #[serde(default)]
    pub account: String,
    /// The vault's zone was there (or made here) at a connect, so its loss is a deletion.
    #[serde(default)]
    pub zone_seen: bool,
    #[serde(default)]
    pub subscribed: bool,
    /// The UTC day of the last `DevotDevice` save, and the hash of the name it saved.
    #[serde(default)]
    pub device_day: i64,
    #[serde(default)]
    pub device_name: String,
}

impl ICloudState {
    pub(crate) fn new(vault: &str) -> Self {
        Self {
            vault: vault.to_string(),
            device: uuid::Uuid::new_v4().hyphenated().to_string(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Welcome {
    pub time: i64,
    pub epoch: String,
    /// The engine keeps its own cursor; a connect does not read the feed.
    pub cursor: String,
    pub device: String,
    /// Apple meters the requests: no quota cap of Devot's.
    pub quota: &'static str,
    /// Attachments share the owner's iCloud storage: no share of their own.
    pub attachments: &'static str,
}

pub(crate) struct Pulled {
    pub id: String,
    pub version: u64,
    pub tag: String,
    pub kind: String,
    pub plaintext: Result<Zeroizing<Vec<u8>>, &'static str>,
}

pub(crate) struct Page {
    pub records: Vec<Pulled>,
    pub next: String,
    pub more: bool,
}

pub(crate) struct Item<'a> {
    pub id: &'a str,
    pub base: u64,
    pub tag: &'a str,
    pub plaintext: &'a [u8],
    pub kind: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PushAnswer {
    Pushed {
        version: u64,
        tag: String,
    },
    Rejected {
        version: u64,
        tag: String,
    },
    Paused {
        until: Option<i64>,
        code: &'static str,
    },
    Failed(&'static str),
}

impl PushAnswer {
    /// Whether the rest of the pass waits after this answer, as the engine's `pushOneByOne` reads it.
    fn ends(&self) -> bool {
        match self {
            Self::Paused { code, .. } => *code != error::FULL,
            Self::Failed(code) => *code != error::TOO_LARGE,
            _ => false,
        }
    }
}

struct Prepared {
    index: usize,
    record: CkRecord,
    size: Size,
    version: u64,
}

pub(crate) struct ICloud {
    kit: Arc<dyn CloudKit>,
    vault: Arc<Vault>,
    zone: String,
    staging: Arc<Staging>,
}

impl ICloud {
    pub(crate) fn new(kit: Arc<dyn CloudKit>, vault: Arc<Vault>, staging: Arc<Staging>) -> Self {
        let zone = vault_zone(&vault.id().to_string());
        Self {
            kit,
            vault,
            zone,
            staging,
        }
    }

    /// Checks the account, the zones and the epoch, saves this device's clock and (at most daily)
    /// its device row, and subscribes. `has_synced` is the library's "has synced" state: with it,
    /// a vault zone this device saw before and finds gone stops sync (`E_SYNC_ICLOUD_DELETED`) and
    /// nothing is uploaded; without it the zone is made again, under a new epoch.
    pub(crate) fn connect(
        &self,
        state: &ICloudState,
        has_synced: bool,
        name: &str,
        now: i64,
    ) -> Result<(Welcome, ICloudState), &'static str> {
        let kit = self.kit.as_ref();
        if !kit.available() {
            return Err(error::UNAVAILABLE);
        }
        let mut state = state.clone();
        match kit.account().map_err(failure)? {
            Account::Available => {}
            Account::Missing => return Err(error::SIGNED_OUT),
            Account::Restricted => return Err(error::RESTRICTED),
            Account::TemporarilyUnavailable | Account::CouldNotDetermine => {
                return Err(ACCOUNT_UNAVAILABLE);
            }
        }
        let account = account_hash(&kit.user_record_name().map_err(failure)?);
        if !state.account.is_empty() && state.account != account {
            log::warn!("W_SYNC_ICLOUD_ACCOUNT_CHANGED vault={}", state.vault);
            return Err(error::ACCOUNT_CHANGED);
        }
        state.account = account;

        let zones = [
            ZONE_DEVOT.to_string(),
            self.zone.clone(),
            ZONE_CLOCK.to_string(),
        ];
        let exist = kit.zones_exist(&zones).map_err(failure)?;
        let vault_zone_gone = !exist.get(1).copied().unwrap_or(false);
        if vault_zone_gone && state.zone_seen && has_synced {
            log::warn!("W_SYNC_ICLOUD_ZONE_GONE vault={}", state.vault);
            return Err(error::DELETED);
        }
        let missing: Vec<String> = zones
            .iter()
            .zip(&exist)
            .filter(|(_, there)| !**there)
            .map(|(zone, _)| zone.clone())
            .collect();
        if !missing.is_empty() {
            kit.save_zones(&missing).map_err(failure)?;
        }
        if vault_zone_gone {
            state.subscribed = false;
            if state.zone_seen {
                log::info!("I_SYNC_ICLOUD_ZONE_MADE_AGAIN vault={}", state.vault);
            }
        }
        state.zone_seen = true;

        let epoch = self.epoch(&state.vault, vault_zone_gone)?;
        let time = self.clock(&state.device, now)?;
        self.device_row(&mut state, name, time);
        self.subscribe(&mut state);
        Ok((
            Welcome {
                time,
                epoch,
                cursor: String::new(),
                device: state.device.clone(),
                quota: "off",
                attachments: "on",
            },
            state,
        ))
    }

    /// The epoch in `meta-<vault>`, saved only if absent; a vault zone made again gets a new one,
    /// saved against the one read, so two devices doing it at once end with one.
    fn epoch(&self, vault: &str, renew: bool) -> Result<String, &'static str> {
        let name = format!("meta-{vault}");
        let read = self
            .kit
            .fetch(ZONE_DEVOT, std::slice::from_ref(&name))
            .map_err(failure)?
            .into_iter()
            .next()
            .flatten();
        if let Some(meta) = &read
            && !renew
            && let Some(epoch) = meta.text("epoch")
        {
            return Ok(epoch.to_string());
        }
        let fresh = uuid::Uuid::new_v4().simple().to_string();
        let mut meta = CkRecord::new(TYPE_META, &name).with("epoch", Value::Text(fresh.clone()));
        meta.system = read.and_then(|r| r.system);
        let saved = self
            .kit
            .save(ZONE_DEVOT, &[meta], SavePolicy::IfUnchanged)
            .map_err(failure)?
            .into_iter()
            .next()
            .ok_or(error::FAILED)?;
        match saved {
            Ok(_) => {
                log::info!("I_SYNC_ICLOUD_EPOCH vault={vault}");
                Ok(fresh)
            }
            Err(e) => match (classify(&e), &e.server_record) {
                (Failure::Changed, Some(server)) => server
                    .text("epoch")
                    .map(str::to_string)
                    .ok_or(error::FAILED),
                (other, _) => Err(other.code()),
            },
        }
    }

    /// Saves this device's clock record; the server's modification date is the time.
    fn clock(&self, device: &str, now: i64) -> Result<i64, &'static str> {
        let record = CkRecord::new(TYPE_CLOCK, device).with("seen", Value::Int(now));
        let saved = self
            .kit
            .save(ZONE_CLOCK, &[record], SavePolicy::Overwrite)
            .map_err(failure)?
            .into_iter()
            .next()
            .ok_or(error::FAILED)?
            .map_err(failure)?;
        saved.modified.ok_or(error::FAILED)
    }

    /// The device row (sealed name, last day seen), saved only when the name changed or the last
    /// save is a day old, so connects do not wake the other devices. A failure waits for the next.
    fn device_row(&self, state: &mut ICloudState, name: &str, time: i64) {
        let day = time.div_euclid(DAY_MS);
        let print = name_hash(name);
        if state.device_day == day && state.device_name == print {
            return;
        }
        let Ok(sealed) = seal_device_name(&self.vault, &state.device, name) else {
            log::warn!("W_SYNC_ICLOUD_DEVICE_SEAL");
            return;
        };
        let record = CkRecord::new(
            TYPE_DEVICE,
            &format!("device-{}-{}", state.vault, state.device),
        )
        .with("device", Value::Text(state.device.clone()))
        .with("name", Value::Bytes(sealed))
        .with("day", Value::Int(day));
        let saved = self
            .kit
            .save(ZONE_DEVOT, &[record], SavePolicy::Overwrite)
            .map(|mut results| results.pop());
        match saved {
            Ok(Some(Ok(_))) => {
                state.device_day = day;
                state.device_name = print;
            }
            Ok(Some(Err(e))) | Err(e) => log::warn!("W_SYNC_ICLOUD_DEVICE_SAVE code={}", e.code),
            Ok(None) => log::warn!("W_SYNC_ICLOUD_DEVICE_SAVE"),
        }
    }

    fn subscribe(&self, state: &mut ICloudState) {
        if state.subscribed {
            return;
        }
        let done = [ZONE_DEVOT, self.zone.as_str()].iter().all(|zone| {
            self.kit
                .subscribe(zone, zone)
                .inspect_err(|e| log::warn!("W_SYNC_ICLOUD_SUBSCRIBE code={}", e.code))
                .is_ok()
        });
        state.subscribed = done;
    }

    /// One page of the vault zone's changes after `since` ('' for the start). An expired token
    /// starts again from the start: the versions already seen keep replays out.
    pub(crate) fn pull(&self, since: &str) -> Result<Page, &'static str> {
        let token = if since.is_empty() {
            None
        } else {
            Some(STANDARD.decode(since).map_err(|_| CURSOR_INVALID)?)
        };
        let changes = match self.kit.changes(&self.zone, token.as_deref(), PULL_LIMIT) {
            Err(e) if token.is_some() && classify(&e) == Failure::TokenExpired => {
                log::info!("I_SYNC_ICLOUD_TOKEN_EXPIRED");
                self.kit.changes(&self.zone, None, PULL_LIMIT)
            }
            other => other,
        }
        .map_err(failure)?;
        let records = changes
            .records
            .iter()
            .filter(|record| record.kind == super::kit::TYPE_RECORD)
            .map(|record| self.open(record))
            .collect();
        Ok(Page {
            records,
            next: STANDARD.encode(&changes.token),
            more: changes.more,
        })
    }

    fn open(&self, record: &CkRecord) -> Pulled {
        let tag = record
            .system
            .as_deref()
            .map(|s| STANDARD.encode(s))
            .unwrap_or_default();
        match encoding::decode(record) {
            Ok(decoded) => Pulled {
                plaintext: self
                    .vault
                    .decrypt_record(&record.name, decoded.version, &decoded.chunks)
                    .map_err(|e| e.code()),
                id: record.name.clone(),
                version: decoded.version,
                tag,
                kind: decoded.kind,
            },
            Err(code) => Pulled {
                id: record.name.clone(),
                version: encoding::version_of(record).unwrap_or(0),
                tag,
                kind: record.text(encoding::KIND).unwrap_or("record").to_string(),
                plaintext: Err(code),
            },
        }
    }

    /// Seals and saves each item as version `base + 1`, in batches within the three caps; one
    /// answer per item, in order. After an answer that ends the pass the rest are not sent and get
    /// it too. The staged asset files are gone when this returns.
    pub(crate) fn push_many(&self, items: &[Item<'_>], now: i64) -> Vec<PushAnswer> {
        let mut results: Vec<Option<PushAnswer>> = vec![None; items.len()];
        let mut staged = Vec::new();
        let mut prepared = Vec::new();
        for (index, item) in items.iter().enumerate() {
            match self.prepare(index, item, &mut staged) {
                Ok(p) => prepared.push(p),
                Err(code) => results[index] = Some(PushAnswer::Failed(code)),
            }
        }
        let sizes: Vec<Size> = prepared.iter().map(|p| p.size).collect();
        let mut runs: VecDeque<Range<usize>> = batch::plan(&sizes).into();
        let mut retried = vec![false; prepared.len()];
        let mut ended: Option<PushAnswer> = None;
        while let Some(run) = runs.pop_front() {
            if let Some(end) = &ended {
                for p in &prepared[run] {
                    results[p.index] = Some(end.clone());
                }
                continue;
            }
            let records: Vec<CkRecord> = prepared[run.clone()]
                .iter()
                .map(|p| p.record.clone())
                .collect();
            match self.kit.save(&self.zone, &records, SavePolicy::IfUnchanged) {
                Err(e) => {
                    let failure = classify(&e);
                    if failure == Failure::TooMany && run.len() > 1 {
                        let [first, second] = batch::halve(run);
                        runs.push_front(second);
                        runs.push_front(first);
                        continue;
                    }
                    let answer = match error::refused(&e, now) {
                        Refused::Paused { until, code } => PushAnswer::Paused { until, code },
                        Refused::Again if failure == Failure::TooMany => {
                            PushAnswer::Failed(error::TOO_LARGE)
                        }
                        Refused::Again | Refused::Rejected { .. } => {
                            PushAnswer::Failed(failure.code())
                        }
                        Refused::Failed(code) => PushAnswer::Failed(code),
                    };
                    log::warn!("W_SYNC_ICLOUD_SAVE code={}", e.code);
                    for p in &prepared[run] {
                        results[p.index] = Some(answer.clone());
                    }
                    if answer.ends() {
                        ended = Some(answer);
                    }
                }
                Ok(saved) => {
                    for (at, outcome) in run.clone().zip(
                        saved
                            .into_iter()
                            .map(Some)
                            .chain(std::iter::repeat_with(|| None)),
                    ) {
                        let p = &prepared[at];
                        let answer = match outcome {
                            Some(Ok(record)) => PushAnswer::Pushed {
                                version: p.version,
                                tag: tag_of(&record),
                            },
                            Some(Err(e)) => match error::refused(&e, now) {
                                Refused::Again if !retried[at] => {
                                    retried[at] = true;
                                    runs.push_back(at..at + 1);
                                    continue;
                                }
                                other => answer_of(other),
                            },
                            None => PushAnswer::Failed(error::FAILED),
                        };
                        if let PushAnswer::Paused { code, .. } = &answer
                            && *code == error::BUSY
                        {
                            ended = Some(answer.clone());
                        }
                        results[p.index] = Some(answer);
                    }
                }
            }
        }
        self.staging.remove(&staged);
        results
            .into_iter()
            .map(|r| r.unwrap_or(PushAnswer::Failed(error::FAILED)))
            .collect()
    }

    fn prepare(
        &self,
        index: usize,
        item: &Item<'_>,
        staged: &mut Vec<PathBuf>,
    ) -> Result<Prepared, &'static str> {
        let version = item.base.checked_add(1).ok_or(encoding::INVALID)?;
        let system = if item.tag.is_empty() {
            None
        } else {
            Some(STANDARD.decode(item.tag).map_err(|_| TAG_INVALID)?)
        };
        let chunks = self
            .vault
            .encrypt_record(item.id, version, item.plaintext)
            .map_err(|e| e.code())?;
        if chunks.len() > encoding::MAX_CHUNKS {
            log::warn!("W_SYNC_TOO_LARGE id={}", item.id);
            return Err(error::TOO_LARGE);
        }
        let staging = &self.staging;
        let (record, size) =
            encoding::encode(item.id, system, version, item.kind, &chunks, &mut |bytes| {
                let path = staging.stage(bytes)?;
                staged.push(path.clone());
                Ok(path)
            })?;
        Ok(Prepared {
            index,
            record,
            size,
            version,
        })
    }
}

fn answer_of(refused: Refused) -> PushAnswer {
    match refused {
        Refused::Rejected { server } => match encoding::version_of(&server) {
            Ok(version) => PushAnswer::Rejected {
                version,
                tag: tag_of(&server),
            },
            Err(code) => PushAnswer::Failed(code),
        },
        Refused::Paused { until, code } => PushAnswer::Paused { until, code },
        Refused::Failed(code) => PushAnswer::Failed(code),
        Refused::Again => PushAnswer::Failed(error::OFFLINE),
    }
}

fn tag_of(record: &CkRecord) -> String {
    record
        .system
        .as_deref()
        .map(|s| STANDARD.encode(s))
        .unwrap_or_default()
}

fn failure(e: CkError) -> &'static str {
    let failure = classify(&e);
    if let Failure::Other(code) = failure {
        log::warn!("W_SYNC_ICLOUD_FAILED code={code}");
    }
    failure.code()
}

fn hash(label: &[u8], text: &str) -> String {
    let digest = Sha256::new()
        .chain_update(label)
        .chain_update(text.as_bytes())
        .finalize();
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn account_hash(user_record_name: &str) -> String {
    hash(ACCOUNT_LABEL, user_record_name)
}

fn name_hash(name: &str) -> String {
    hash(NAME_LABEL, name)
}

/// A device's name in its `DevotDevice` row, sealed as version 1 of a record named by the device ID.
pub(crate) fn seal_device_name(
    vault: &Vault,
    device: &str,
    name: &str,
) -> Result<Vec<u8>, &'static str> {
    vault
        .encrypt_record(device, 1, name.as_bytes())
        .map_err(|e| e.code())?
        .pop()
        .ok_or(error::FAILED)
}

#[allow(
    dead_code,
    reason = "Settings lists the devices on iCloud with it (#606)"
)]
pub(crate) fn open_device_name(
    vault: &Vault,
    device: &str,
    sealed: &[u8],
) -> Result<String, &'static str> {
    let bytes = vault
        .decrypt_record(device, 1, &[sealed])
        .map_err(|e| e.code())?;
    String::from_utf8(bytes.to_vec()).map_err(|_| encoding::INVALID)
}
