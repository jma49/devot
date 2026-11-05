//! An in-memory private database that behaves as CloudKit does where the transport depends on it:
//! compare-and-swap on archived system fields, a change feed read by token, assets read from their
//! files at save time, and errors injected per call or per record.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Mutex;

use super::error::code;
use super::kit::{Account, Changes, CkError, CkRecord, CloudKit, SavePolicy, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Op {
    Account,
    UserRecord,
    Zones,
    SaveZones,
    DeleteZones,
    Fetch,
    Save,
    Changes,
    Subscribe,
}

struct Stored {
    record: CkRecord,
    tag: u64,
    seq: u64,
}

#[derive(Default)]
struct Zone {
    records: BTreeMap<String, Stored>,
    seq: u64,
    /// Each make of the zone; a token from an earlier one has expired.
    generation: u64,
}

struct State {
    available: bool,
    account: Account,
    user: String,
    zones: HashMap<String, Zone>,
    generations: u64,
    tags: u64,
    clock: i64,
    fail: VecDeque<(Op, CkError)>,
    fail_records: HashMap<String, VecDeque<CkError>>,
    /// Saves of more records than this fail with `limitExceeded`.
    limit: Option<usize>,
    calls: HashMap<Op, usize>,
    saved_sizes: Vec<usize>,
    subscriptions: Vec<String>,
    /// The asset files a save read, so tests see they were there when it ran.
    assets_read: usize,
    /// Each zone `delete_zones` removed, in order.
    deleted: Vec<String>,
    fail_zone_deletes: HashMap<String, CkError>,
}

pub(crate) struct Fake {
    state: Mutex<State>,
}

impl Fake {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State {
                available: true,
                account: Account::Available,
                user: "_user-one".into(),
                zones: HashMap::new(),
                generations: 0,
                tags: 0,
                clock: 1_800_000_000_000,
                fail: VecDeque::new(),
                fail_records: HashMap::new(),
                limit: None,
                calls: HashMap::new(),
                saved_sizes: Vec::new(),
                subscriptions: Vec::new(),
                assets_read: 0,
                deleted: Vec::new(),
                fail_zone_deletes: HashMap::new(),
            }),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().unwrap())
    }

    pub(crate) fn without_entitlement(self) -> Self {
        self.with(|s| s.available = false);
        self
    }

    pub(crate) fn set_account(&self, account: Account) {
        self.with(|s| s.account = account);
    }

    pub(crate) fn switch_user(&self, user: &str) {
        self.with(|s| s.user = user.to_string());
    }

    pub(crate) fn fail_next(&self, op: Op, error: CkError) {
        self.with(|s| s.fail.push_back((op, error)));
    }

    pub(crate) fn fail_record(&self, name: &str, error: CkError) {
        self.with(|s| {
            s.fail_records
                .entry(name.to_string())
                .or_default()
                .push_back(error);
        });
    }

    pub(crate) fn limit(&self, records: usize) {
        self.with(|s| s.limit = Some(records));
    }

    /// The next delete of `zone` fails with `error` and leaves it.
    pub(crate) fn fail_zone_delete(&self, zone: &str, error: CkError) {
        self.with(|s| s.fail_zone_deletes.insert(zone.to_string(), error));
    }

    pub(crate) fn deleted_zones(&self) -> Vec<String> {
        self.with(|s| s.deleted.clone())
    }

    pub(crate) fn delete_zone(&self, zone: &str) {
        self.with(|s| s.zones.remove(zone));
    }

    /// Expires every token handed out so far, as CloudKit may after a long time.
    pub(crate) fn expire_tokens(&self, zone: &str) {
        self.with(|s| {
            s.generations += 1;
            let generation = s.generations;
            if let Some(z) = s.zones.get_mut(zone) {
                z.generation = generation;
            }
        });
    }

    pub(crate) fn advance(&self, ms: i64) {
        self.with(|s| s.clock += ms);
    }

    pub(crate) fn calls(&self, op: Op) -> usize {
        self.with(|s| s.calls.get(&op).copied().unwrap_or(0))
    }

    pub(crate) fn saved_sizes(&self) -> Vec<usize> {
        self.with(|s| s.saved_sizes.clone())
    }

    pub(crate) fn assets_read(&self) -> usize {
        self.with(|s| s.assets_read)
    }

    pub(crate) fn subscriptions(&self) -> Vec<String> {
        self.with(|s| s.subscriptions.clone())
    }

    pub(crate) fn record(&self, zone: &str, name: &str) -> Option<CkRecord> {
        self.with(|s| {
            s.zones
                .get(zone)
                .and_then(|z| z.records.get(name))
                .map(|r| r.record.clone())
        })
    }

    pub(crate) fn zone_exists(&self, zone: &str) -> bool {
        self.with(|s| s.zones.contains_key(zone))
    }

    fn call(&self, op: Op) -> Result<(), CkError> {
        self.with(|s| {
            assert!(s.available, "CKContainer touched without the entitlement");
            *s.calls.entry(op).or_default() += 1;
            match s.fail.iter().position(|(o, _)| *o == op) {
                Some(at) => Err(s.fail.remove(at).expect("present").1),
                None => Ok(()),
            }
        })
    }
}

fn system_of(zone: &str, name: &str, tag: u64) -> Vec<u8> {
    format!("{zone}\n{name}\n{tag}").into_bytes()
}

/// Whether `system` is the archive of this record, as the native code checks after unarchiving.
fn archive_of(system: &[u8], zone: &str, name: &str) -> bool {
    std::str::from_utf8(system).is_ok_and(|text| {
        let mut lines = text.split('\n');
        lines.next() == Some(zone)
            && lines.next() == Some(name)
            && lines.next().is_some_and(|tag| tag.parse::<u64>().is_ok())
            && lines.next().is_none()
    })
}

fn tag_in(system: &[u8]) -> Option<u64> {
    std::str::from_utf8(system)
        .ok()?
        .rsplit('\n')
        .next()?
        .parse()
        .ok()
}

fn token(generation: u64, seq: u64) -> Vec<u8> {
    format!("{generation}:{seq}").into_bytes()
}

fn read_token(token: &[u8]) -> Option<(u64, u64)> {
    let (g, s) = std::str::from_utf8(token).ok()?.split_once(':')?;
    Some((g.parse().ok()?, s.parse().ok()?))
}

impl CloudKit for Fake {
    fn available(&self) -> bool {
        self.with(|s| s.available)
    }

    fn account(&self) -> Result<Account, CkError> {
        self.call(Op::Account)?;
        Ok(self.with(|s| s.account))
    }

    fn user_record_name(&self) -> Result<String, CkError> {
        self.call(Op::UserRecord)?;
        Ok(self.with(|s| s.user.clone()))
    }

    fn zones_exist(&self, zones: &[String]) -> Result<Vec<bool>, CkError> {
        self.call(Op::Zones)?;
        Ok(self.with(|s| zones.iter().map(|z| s.zones.contains_key(z)).collect()))
    }

    fn save_zones(&self, zones: &[String]) -> Result<(), CkError> {
        self.call(Op::SaveZones)?;
        self.with(|s| {
            for zone in zones {
                if !s.zones.contains_key(zone) {
                    s.generations += 1;
                    let generation = s.generations;
                    s.zones.insert(
                        zone.clone(),
                        Zone {
                            generation,
                            ..Zone::default()
                        },
                    );
                }
            }
        });
        Ok(())
    }

    fn delete_zones(&self, zones: &[String]) -> Result<(), CkError> {
        self.call(Op::DeleteZones)?;
        self.with(|s| {
            for zone in zones {
                if let Some(error) = s.fail_zone_deletes.remove(zone) {
                    return Err(error);
                }
                if s.zones.remove(zone).is_some() {
                    s.deleted.push(zone.clone());
                }
            }
            Ok(())
        })
    }

    fn fetch(&self, zone: &str, names: &[String]) -> Result<Vec<Option<CkRecord>>, CkError> {
        self.call(Op::Fetch)?;
        self.with(|s| {
            let z = s
                .zones
                .get(zone)
                .ok_or_else(|| CkError::of(code::ZONE_NOT_FOUND))?;
            Ok(names
                .iter()
                .map(|n| z.records.get(n).map(|r| r.record.clone()))
                .collect())
        })
    }

    fn save(
        &self,
        zone: &str,
        records: &[CkRecord],
        policy: SavePolicy,
    ) -> Result<Vec<Result<CkRecord, CkError>>, CkError> {
        self.call(Op::Save)?;
        self.with(|s| {
            if s.limit.is_some_and(|limit| records.len() > limit) {
                return Err(CkError::of(code::LIMIT_EXCEEDED));
            }
            s.saved_sizes.push(records.len());
            // A non-atomic save answers a missing zone per record, under `partialFailure`.
            if !s.zones.contains_key(zone) {
                return Ok(records
                    .iter()
                    .map(|_| Err(CkError::of(code::ZONE_NOT_FOUND)))
                    .collect());
            }
            let mut results = Vec::new();
            for record in records {
                if let Some(system) = &record.system
                    && !archive_of(system, zone, &record.name)
                {
                    results.push(Err(CkError::of(code::BAD_TAG)));
                    continue;
                }
                if let Some(error) = s
                    .fail_records
                    .get_mut(&record.name)
                    .and_then(VecDeque::pop_front)
                {
                    results.push(Err(error));
                    continue;
                }
                let mut stored = record.clone();
                for (_, value) in &mut stored.fields {
                    if let Value::Asset(path) = value {
                        let bytes = std::fs::read(&*path).expect("a staged asset file");
                        s.assets_read += 1;
                        *value = Value::Bytes(bytes);
                    }
                }
                let z = s.zones.get(zone).expect("checked");
                if let Some(current) = z.records.get(&record.name)
                    && policy == SavePolicy::IfUnchanged
                    && record.system.as_deref().and_then(tag_in) != Some(current.tag)
                {
                    results.push(Err(CkError {
                        code: code::SERVER_RECORD_CHANGED,
                        retry_after_ms: None,
                        server_record: Some(Box::new(current.record.clone())),
                    }));
                    continue;
                }
                s.tags += 1;
                s.clock += 1;
                let tag = s.tags;
                let clock = s.clock;
                let z = s.zones.get_mut(zone).expect("checked");
                z.seq += 1;
                // Either policy sends the keys the record set, so the server keeps the others.
                let mut merged = match z.records.get(&record.name) {
                    Some(current) => {
                        let mut merged = current.record.clone();
                        for (key, value) in &stored.fields {
                            merged.set(key, value.clone());
                        }
                        merged
                    }
                    None => stored,
                };
                merged.fields.retain(|(_, v)| *v != Value::Null);
                merged.system = Some(system_of(zone, &record.name, tag));
                merged.modified = Some(clock);
                let seq = z.seq;
                z.records.insert(
                    record.name.clone(),
                    Stored {
                        record: merged.clone(),
                        tag,
                        seq,
                    },
                );
                results.push(Ok(merged));
            }
            Ok(results)
        })
    }

    fn changes(
        &self,
        zone: &str,
        token_in: Option<&[u8]>,
        limit: usize,
    ) -> Result<Changes, CkError> {
        self.call(Op::Changes)?;
        self.with(|s| {
            let z = s
                .zones
                .get(zone)
                .ok_or_else(|| CkError::of(code::ZONE_NOT_FOUND))?;
            let after = match token_in {
                None => 0,
                Some(t) => match read_token(t) {
                    Some((generation, seq)) if generation == z.generation => seq,
                    _ => return Err(CkError::of(code::CHANGE_TOKEN_EXPIRED)),
                },
            };
            let mut changed: Vec<&Stored> = z.records.values().filter(|r| r.seq > after).collect();
            changed.sort_by_key(|r| r.seq);
            let more = changed.len() > limit;
            changed.truncate(limit);
            let last = changed.last().map_or(after, |r| r.seq);
            Ok(Changes {
                records: changed.iter().map(|r| r.record.clone()).collect(),
                token: token(z.generation, if more { last } else { z.seq.max(last) }),
                more,
            })
        })
    }

    fn subscribe(&self, zone: &str, id: &str) -> Result<(), CkError> {
        self.call(Op::Subscribe)?;
        self.with(|s| {
            if !s.subscriptions.iter().any(|z| z == zone) {
                s.subscriptions.push(zone.to_string());
            }
        });
        let _ = id;
        Ok(())
    }
}
