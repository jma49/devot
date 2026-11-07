//! The iCloud transport (ADR 0015): the relay's connect, pull and push over the CloudKit
//! primitives. Records are sealed and named as on a relay; CloudKit sees sealed chunks, their sizes
//! and the store names (ADR 0016). The cursor is the vault zone's archived change token and a
//! record's tag its archived system fields, both base64, both opaque to the engine.

use std::collections::VecDeque;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::batch;
use super::encoding::{self, Size};
use super::error::{self, Failure, Refused, classify};
use super::kit::{
    Account, CURRENT, CkError, CkRecord, CloudKit, SavePolicy, TYPE_CLOCK, TYPE_DEVICE, TYPE_META,
    Value, ZONE_CLOCK, ZONE_DEVOT, vault_zone,
};
use super::staging::Staging;
use super::{current, rotation};
use crate::sync::client::DeviceInfo;
use crate::sync::{Vault, names};

/// Records per page of the change feed. Each may carry up to 16 assets of 1.9 MB, all held until
/// the page is handed on.
pub(crate) const PULL_LIMIT: usize = 25;
const DAY_MS: i64 = 86_400_000;
const ACCOUNT_LABEL: &[u8] = b"devot/icloud/account/v1";
const NAME_LABEL: &[u8] = b"devot/icloud/device-name/v1";
pub(crate) const ACCOUNT_UNAVAILABLE: &str = "E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE";
const CURSOR_INVALID: &str = "E_SYNC_CURSOR_INVALID";

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
    /// This device's ID on the relay it moved from, sealed with the name in its device row so the
    /// device that moved the vault sees it arrive; '' for none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub relay_device: String,
    /// The vault this one succeeds after a rotation made here, whose zone and rows this device
    /// still has to delete; '' for none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub retired: String,
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
    /// The name it is filed under; `id` too when it does not open.
    pub name: String,
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
    /// The server's clock less this device's, from the last connect: pauses end on the server's.
    offset: AtomicI64,
}

impl ICloud {
    pub(crate) fn new(kit: Arc<dyn CloudKit>, vault: Arc<Vault>, staging: Arc<Staging>) -> Self {
        let zone = vault_zone(&vault.id().to_string());
        Self {
            kit,
            vault,
            zone,
            staging,
            offset: AtomicI64::new(0),
        }
    }

    /// Checks the account, the zones and the epoch, saves this device's clock and (at most daily)
    /// its device row, and subscribes. `has_synced` is the library's "has synced" state: with it,
    /// a vault zone this device saw before and finds gone stops sync (`E_SYNC_ICLOUD_DELETED`) and
    /// nothing is uploaded; without it the zone is made again, under a new epoch, but only while
    /// `current` names the vault. With zone `devot` gone the vault was left, or is being left, and
    /// sync stops too.
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
        let connected_before = !state.account.is_empty();
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
        let devot_gone = !exist.first().copied().unwrap_or(false);
        let vault_zone_gone = !exist.get(1).copied().unwrap_or(false);
        if devot_gone {
            log::warn!("W_SYNC_ICLOUD_DEVOT_GONE vault={}", state.vault);
            return Err(error::DELETED);
        }
        let mut read = kit
            .fetch(ZONE_DEVOT, &[CURRENT.to_string(), meta_name(&state.vault)])
            .map_err(failure)?
            .into_iter();
        let named = read.next().flatten().and_then(|r| current::vault_of(&r));
        let meta = read.next().flatten();
        if let Some(successor) = named.as_deref().filter(|named| *named != state.vault)
            && rotation::successor(kit, &self.vault, successor)?.is_some()
        {
            log::info!(
                "I_SYNC_ICLOUD_SUCCEEDED vault={} successor={successor}",
                state.vault
            );
            return Err(error::ROTATED);
        }
        if vault_zone_gone && state.zone_seen && has_synced {
            log::warn!("W_SYNC_ICLOUD_ZONE_GONE vault={}", state.vault);
            return Err(error::DELETED);
        }
        // Every way into iCloud claims `current` first, so a vault it does not name was left.
        if vault_zone_gone && named.as_deref() != Some(state.vault.as_str()) {
            log::warn!("W_SYNC_ICLOUD_NOT_CURRENT vault={}", state.vault);
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

        // A zone made for the first time keeps an epoch another device saved meanwhile. A device
        // that connected before checks `zone_seen` above; "upload again" clears it to get here.
        let epoch = epoch(kit, &state.vault, meta, vault_zone_gone && connected_before)?;
        let time = self.clock(&state.device, now)?;
        self.offset.store(time - now, Ordering::Relaxed);
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

    /// Saves this device's clock record; the server's modification date is the time.
    fn clock(&self, device: &str, now: i64) -> Result<i64, &'static str> {
        let record = CkRecord::new(TYPE_CLOCK, device).with("seen", Value::Int(now));
        let saved = self
            .kit
            .save(ZONE_CLOCK, &[record], SavePolicy::Overwrite)
            .map_err(failure)?
            .into_iter()
            .next()
            .ok_or_else(|| error::empty("clock-save"))?
            .map_err(failure)?;
        saved.modified.ok_or_else(|| error::empty("clock-time"))
    }

    /// The device row (sealed name, last day seen), saved only when the name changed or the last
    /// save is a day old, so connects do not wake the other devices. A failure waits for the next.
    fn device_row(&self, state: &mut ICloudState, name: &str, time: i64) {
        let day = time.div_euclid(DAY_MS);
        let (version, plain) = device_name_plain(name, &state.relay_device);
        let print = name_hash(&plain);
        if state.device_day == day && state.device_name == print {
            return;
        }
        let sealed = self
            .vault
            .encrypt_record(&state.device, version, plain.as_bytes())
            .ok()
            .and_then(|mut chunks| chunks.pop());
        let Some(sealed) = sealed else {
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
        let mut legacy = 0usize;
        let records = changes
            .records
            .iter()
            .filter(|record| record.kind == super::kit::TYPE_RECORD)
            .filter(|record| {
                let left = names::is_legacy(&record.name);
                legacy += usize::from(left);
                !left
            })
            .map(|record| self.open(record))
            .collect();
        if legacy > 0 {
            log::info!("I_SYNC_LEGACY_LEFT count={legacy}");
        }
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
        let shown = names::shown_id(&record.name).to_string();
        match encoding::decode(record) {
            Ok(decoded) => {
                let (id, plaintext) =
                    match self
                        .vault
                        .open_stored(&record.name, decoded.version, &decoded.chunks)
                    {
                        Ok((id, plaintext)) => (id, Ok(plaintext)),
                        Err(e) => (shown.clone(), Err(e.code())),
                    };
                Pulled {
                    id,
                    name: shown,
                    version: decoded.version,
                    tag,
                    kind: decoded.kind,
                    plaintext,
                }
            }
            Err(code) => Pulled {
                id: shown.clone(),
                name: shown,
                version: encoding::version_of(record).unwrap_or(0),
                tag,
                kind: record.text(encoding::KIND).unwrap_or("record").to_string(),
                plaintext: Err(code),
            },
        }
    }

    /// Seals and saves each item as version `base + 1`, in batches within the three caps; one
    /// answer per item, in order. After an answer that ends the pass the rest are not sent and get
    /// it too. The staged asset files are gone when this returns. `now` is this device's clock; a
    /// pause's end is on the server's, as the engine reads it.
    pub(crate) fn push_many(&self, items: &[Item<'_>], now: i64) -> Vec<PushAnswer> {
        let now = now.saturating_add(self.offset.load(Ordering::Relaxed));
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
        let mut failed = error::FailedTally::default();
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
                    if answer == PushAnswer::Failed(error::FAILED) {
                        failed.note(Some(e.code));
                    }
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
                        let outcome_code = outcome
                            .as_ref()
                            .and_then(|o| o.as_ref().err())
                            .map(|e| e.code);
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
                        if answer == PushAnswer::Failed(error::FAILED) {
                            failed.note(outcome_code);
                        }
                        if matches!(
                            &answer,
                            PushAnswer::Paused {
                                code: error::BUSY,
                                ..
                            } | PushAnswer::Failed(error::ZONE_MISSING)
                        ) {
                            ended = Some(answer.clone());
                        }
                        results[p.index] = Some(answer);
                    }
                }
            }
        }
        self.staging.remove(&staged);
        let answers = results
            .into_iter()
            .map(|r| {
                r.unwrap_or_else(|| {
                    failed.note(None);
                    PushAnswer::Failed(error::FAILED)
                })
            })
            .collect();
        failed.log("push");
        answers
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
            Some(STANDARD.decode(item.tag).map_err(|_| error::TAG_INVALID)?)
        };
        let (name, chunks) = self
            .vault
            .seal_stored(item.id, version, item.plaintext)
            .map_err(|e| e.code())?;
        if chunks.len() > encoding::MAX_CHUNKS {
            log::warn!("W_SYNC_TOO_LARGE id={}", item.id);
            return Err(error::TOO_LARGE);
        }
        let staging = &self.staging;
        let (record, size) =
            encoding::encode(&name, system, version, item.kind, &chunks, &mut |bytes| {
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

fn meta_name(vault: &str) -> String {
    format!("meta-{vault}")
}

/// The epoch in `meta-<vault>`, as `read` holds it, saved only if absent; a vault zone made again
/// gets a new one (`renew`), saved against the one read, so two devices doing it at once end with
/// one.
pub(crate) fn epoch(
    kit: &dyn CloudKit,
    vault: &str,
    read: Option<CkRecord>,
    renew: bool,
) -> Result<String, &'static str> {
    if let Some(meta) = &read
        && !renew
        && let Some(epoch) = meta.text("epoch")
    {
        return Ok(epoch.to_string());
    }
    let fresh = uuid::Uuid::new_v4().simple().to_string();
    let mut meta =
        CkRecord::new(TYPE_META, &meta_name(vault)).with("epoch", Value::Text(fresh.clone()));
    meta.system = read.and_then(|r| r.system);
    let saved = kit
        .save(ZONE_DEVOT, &[meta], SavePolicy::IfUnchanged)
        .map_err(failure)?
        .into_iter()
        .next()
        .ok_or_else(|| error::empty("epoch-save"))?;
    match saved {
        Ok(_) => {
            log::info!("I_SYNC_ICLOUD_EPOCH vault={vault}");
            Ok(fresh)
        }
        Err(e) => match (classify(&e), &e.server_record) {
            (Failure::Changed, Some(server)) => server
                .text("epoch")
                .map(str::to_string)
                .ok_or_else(|| error::unusable("epoch-record")),
            _ => Err(error::code_of(&e, "epoch")),
        },
    }
}

/// The epoch of `vault`, fetched and saved if absent, as its first connect would.
pub(crate) fn fetch_epoch(kit: &dyn CloudKit, vault: &str) -> Result<String, &'static str> {
    let read = kit
        .fetch(ZONE_DEVOT, &[meta_name(vault)])
        .map_err(failure)?
        .into_iter()
        .next()
        .flatten();
    epoch(kit, vault, read, false)
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
    error::code_of(&e, "transport")
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

/// The hash of the Apple ID signed in now, as `ICloudState::account` keeps it.
pub(crate) fn account_of(kit: &dyn CloudKit) -> Result<String, &'static str> {
    Ok(account_hash(&kit.user_record_name().map_err(failure)?))
}

/// Pages of zone `devot` read for its device rows at most: it holds only the vault's own records.
const DEVICE_PAGES: usize = 20;
const DEVICE_PAGE: usize = 200;

pub(crate) struct DeviceRow {
    pub info: DeviceInfo,
    /// The device's ID on the relay it moved from; '' for none.
    pub relay: String,
}

/// The vault's `DevotDevice` rows, oldest day seen first, with `created` the day each was last
/// seen; `own` is this device's ID. A row whose name does not open is left out.
pub(crate) fn devices(
    kit: &dyn CloudKit,
    vault: &Vault,
    own: &str,
) -> Result<Vec<DeviceRow>, &'static str> {
    let prefix = format!("device-{}-", vault.id());
    let mut found = Vec::new();
    let mut token: Option<Vec<u8>> = None;
    for _ in 0..DEVICE_PAGES {
        let page = match kit.changes(ZONE_DEVOT, token.as_deref(), DEVICE_PAGE) {
            Ok(page) => page,
            Err(e) if classify(&e) == Failure::ZoneGone => break,
            Err(e) => return Err(failure(e)),
        };
        for record in &page.records {
            if record.kind != TYPE_DEVICE || !record.name.starts_with(&prefix) {
                continue;
            }
            let (Some(device), Some(sealed)) = (record.text("device"), record.bytes("name")) else {
                continue;
            };
            match open_device_name(vault, device, sealed) {
                Ok((label, relay)) => found.push(DeviceRow {
                    info: DeviceInfo {
                        id: device.to_string(),
                        label,
                        created: record.int("day").unwrap_or(0).saturating_mul(DAY_MS),
                        current: device == own,
                        unseen: false,
                    },
                    relay,
                }),
                Err(code) => log::warn!("W_SYNC_ICLOUD_DEVICE_NAME {code} device={device}"),
            }
        }
        if !page.more {
            break;
        }
        token = Some(page.token);
    }
    found.sort_by(|a, b| (a.info.created, &a.info.id).cmp(&(b.info.created, &b.info.id)));
    Ok(found)
}

fn name_hash(name: &str) -> String {
    hash(NAME_LABEL, name)
}

/// The sealed name of a `DevotDevice` row is a record named by the device ID. Version 1 holds the
/// name alone; version 2 also holds the device's ID on the relay it moved from, inside the seal so
/// CloudKit's schema gains no field. Builds before version 2 cannot open it and leave the row out.
const NAME_ALONE: u64 = 1;
const NAME_AND_RELAY: u64 = 2;

#[derive(Serialize, Deserialize)]
struct NameAndRelay {
    name: String,
    relay: String,
}

fn device_name_plain(name: &str, relay: &str) -> (u64, String) {
    if relay.is_empty() {
        return (NAME_ALONE, name.to_string());
    }
    let both = NameAndRelay {
        name: name.to_string(),
        relay: relay.to_string(),
    };
    match serde_json::to_string(&both) {
        Ok(json) => (NAME_AND_RELAY, json),
        Err(_) => (NAME_ALONE, name.to_string()),
    }
}

/// A device row's name and its relay device ID ('' for none).
pub(crate) fn open_device_name(
    vault: &Vault,
    device: &str,
    sealed: &[u8],
) -> Result<(String, String), &'static str> {
    if let Ok(bytes) = vault.decrypt_record(device, NAME_ALONE, &[sealed]) {
        let name = String::from_utf8(bytes.to_vec()).map_err(|_| encoding::INVALID)?;
        return Ok((name, String::new()));
    }
    let bytes = vault
        .decrypt_record(device, NAME_AND_RELAY, &[sealed])
        .map_err(|e| e.code())?;
    let both: NameAndRelay = serde_json::from_slice(&bytes).map_err(|_| encoding::INVALID)?;
    Ok((both.name, both.relay))
}
