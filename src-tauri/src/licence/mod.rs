//! The licence that unlocks editing, sync and AI (docs/adr/0006-source-available-and-sold-once.md,
//! The licence): a signed key checked offline against the public keys the build holds, kept in the
//! keychain. Its state is none, valid, revoked (in the last verified revocation list) or invalid
//! (with its code). A valid licence unlocks every version.
//! Without one, a three-day trial (`trial`) unlocks the same; once it is over, notes are read-only
//! and every write of user content is refused (`require_write`, which the database's write gate
//! asks).
//! While the build holds no production key nothing is gated and the trial never starts, so a
//! release made before the owner's keys exist changes nothing.
//! The key and the licensee's address never reach a log, an error or a crash report: logs carry
//! codes and the licence ID.

mod format;
mod keys;
mod revoked;
mod store;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
mod trial;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::State as Tauri;

pub(crate) use format::MAX_LENGTH;
use format::{Payload, Revocations, VerifyError, verify_licence, verify_revocations};
pub(crate) use keys::PublicKeys;
pub(crate) use revoked::refresh_from_site as refresh_revocations;
pub(crate) use store::{KeyStore, Keychain, LICENCE_ACCOUNT, REVOCATIONS_FILE, TRIAL_ACCOUNT};
use trial::Record;
pub(crate) use trial::TrialView;

use crate::storage::Write;

pub(crate) const CHANGED_EVENT: &str = "devot://licence-changed";
pub(crate) const REQUIRED: &str = "E_LICENCE_REQUIRED";
/// A pasted key may carry line breaks from an email; anything longer than this is not a key.
const MAX_INPUT: usize = 4 * MAX_LENGTH;
/// How often the trial is looked at while Devot runs: its end reaches the windows within this.
const TICK: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LicenceState {
    None,
    Valid,
    Revoked,
    Invalid,
}

/// What the windows see: never the key.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    /// Whether editing, sync and AI need a licence or the trial in this build.
    pub gated: bool,
    pub state: LicenceState,
    /// Why the key is invalid, or why it could not be read.
    pub code: Option<&'static str>,
    pub id: Option<String>,
    pub licensee: Option<String>,
    pub plan: Option<&'static str>,
    /// None while the build gates nothing.
    pub trial: Option<TrialView>,
}

impl fmt::Debug for Snapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Snapshot")
            .field("gated", &self.gated)
            .field("state", &self.state)
            .field("code", &self.code)
            .field("id", &self.id)
            .field("trial", &self.trial)
            .finish_non_exhaustive()
    }
}

/// A key from a link, checked before the window asks whether to add it.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Offer {
    pub id: String,
    pub licensee: String,
    pub state: LicenceState,
}

impl fmt::Debug for Offer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Offer")
            .field("id", &self.id)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

type Kept = Option<(String, Result<Payload, VerifyError>)>;

struct Held {
    key: Kept,
    revocations: Option<Revocations>,
}

pub(crate) type Emit = Arc<dyn Fn(&Snapshot) + Send + Sync>;
/// Milliseconds since the epoch.
pub(crate) type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Trial {
    record: Result<Record, &'static str>,
    /// The latest time seen as the keychain holds it.
    written: i64,
}

fn system_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

pub(crate) struct Licence {
    keys: PublicKeys,
    store: Arc<dyn KeyStore>,
    revocations_path: PathBuf,
    /// Taken around every keychain use, which may wait on a prompt; `held` is never held across one,
    /// so a link's offer does not wait.
    keychain: Mutex<()>,
    /// Read from the keychain and the list's file once, on first use.
    held: Mutex<Option<Held>>,
    trial_store: Arc<dyn KeyStore>,
    /// Read from the keychain on first use (begun there on the first launch); one that could not be
    /// read is read again at the next tick. Never held across a keychain use either.
    trial: Mutex<Option<Trial>>,
    /// What the last tick saw, so a change (the trial's end) reaches the windows once.
    ticked: Mutex<Option<Snapshot>>,
    clock: Clock,
    emit: Emit,
}

/// Keeps every character a key can hold; spaces and line breaks a mail client wrapped it with go.
fn cleaned(input: &str) -> Result<String, &'static str> {
    if input.len() > MAX_INPUT {
        return Err(VerifyError::Malformed.code());
    }
    Ok(input.chars().filter(|c| !c.is_ascii_whitespace()).collect())
}

impl Licence {
    pub(crate) fn new(
        keys: PublicKeys,
        store: Arc<dyn KeyStore>,
        trial_store: Arc<dyn KeyStore>,
        data_dir: &Path,
        emit: Emit,
    ) -> Self {
        Self {
            keys,
            store,
            revocations_path: data_dir.join(REVOCATIONS_FILE),
            keychain: Mutex::new(()),
            held: Mutex::new(None),
            trial_store,
            trial: Mutex::new(None),
            ticked: Mutex::new(None),
            clock: Arc::new(system_now),
            emit,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_clock(self, clock: Clock) -> Self {
        Self { clock, ..self }
    }

    fn read_revocations(&self) -> Option<Revocations> {
        let bytes = match std::fs::read(&self.revocations_path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(_) => {
                log::warn!("W_LICENCE_REVOCATIONS_READ_FAILED");
                return None;
            }
        };
        let list = String::from_utf8(bytes).ok();
        match list
            .as_deref()
            .map(|list| verify_revocations(list, &self.keys))
        {
            Some(Ok(list)) => Some(list),
            Some(Err(e)) => {
                log::warn!("W_LICENCE_REVOCATIONS_UNREADABLE {}", e.code());
                None
            }
            None => {
                log::warn!("W_LICENCE_REVOCATIONS_UNREADABLE E_LICENCE_MALFORMED");
                None
            }
        }
    }

    fn held(&self) -> Result<MutexGuard<'_, Option<Held>>, &'static str> {
        self.held.lock().map_err(|_| "E_LICENCE_INTERNAL")
    }

    fn keychain(&self) -> Result<MutexGuard<'_, ()>, &'static str> {
        self.keychain.lock().map_err(|_| "E_LICENCE_INTERNAL")
    }

    /// Replaces the key held, reading the list's file if nothing was held yet. The caller holds
    /// `keychain`, so nothing else fills `held` meanwhile.
    fn put(&self, key: Kept) -> Result<(), &'static str> {
        let revocations = if self.held()?.is_some() {
            None
        } else {
            self.read_revocations()
        };
        let mut held = self.held()?;
        match held.as_mut() {
            Some(held) => held.key = key,
            None => *held = Some(Held { key, revocations }),
        }
        Ok(())
    }

    fn with_held<T>(&self, f: impl FnOnce(&mut Held) -> T) -> Result<T, &'static str> {
        if let Some(held) = self.held()?.as_mut() {
            return Ok(f(held));
        }
        {
            let _keychain = self.keychain()?;
            if self.held()?.is_none() {
                let key = self.store.get()?.map(|key| {
                    let verified = verify_licence(&key, &self.keys);
                    if let Err(e) = &verified {
                        log::warn!("W_LICENCE_STORED_INVALID {}", e.code());
                    }
                    (key, verified)
                });
                self.put(key)?;
            }
        }
        Ok(f(self.held()?.as_mut().ok_or("E_LICENCE_INTERNAL")?))
    }

    fn state_of(&self, payload: &Payload, revocations: Option<&Revocations>) -> LicenceState {
        if revocations.is_some_and(|list| list.ids.contains(&payload.id)) {
            LicenceState::Revoked
        } else {
            LicenceState::Valid
        }
    }

    fn snapshot_of(&self, held: &Held) -> Snapshot {
        let empty = Snapshot {
            gated: self.keys.gated(),
            state: LicenceState::None,
            code: None,
            id: None,
            licensee: None,
            plan: None,
            trial: None,
        };
        match &held.key {
            None => empty,
            Some((_, Err(e))) => Snapshot {
                state: LicenceState::Invalid,
                code: Some(e.code()),
                ..empty
            },
            Some((_, Ok(payload))) => Snapshot {
                state: self.state_of(payload, held.revocations.as_ref()),
                id: Some(payload.id.clone()),
                licensee: Some(payload.licensee.clone()),
                plan: Some(format::PLAN),
                ..empty
            },
        }
    }

    fn key_snapshot(&self) -> Snapshot {
        self.with_held(|held| self.snapshot_of(held))
            .unwrap_or_else(|code| Snapshot {
                gated: self.keys.gated(),
                state: LicenceState::None,
                code: Some(code),
                id: None,
                licensee: None,
                plan: None,
                trial: None,
            })
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let snapshot = self.key_snapshot();
        let trial = self.keys.gated().then(|| {
            let now = (self.clock)();
            TrialView::of(self.trial_at(now).as_ref().map_err(|code| *code), now)
        });
        Snapshot { trial, ..snapshot }
    }

    fn trial_lock(&self) -> Result<MutexGuard<'_, Option<Trial>>, &'static str> {
        self.trial.lock().map_err(|_| "E_LICENCE_INTERNAL")
    }

    /// The trial as of `now`. The first read begins it when the keychain holds none, and records
    /// `now` as the latest time seen; later reads move that on in memory only (`tick` writes it).
    /// A trial that cannot be read or begun counts as ended.
    fn trial_at(&self, now: i64) -> Result<Record, &'static str> {
        let known = self.trial_lock()?.as_ref().map(|trial| trial.record);
        let record = match known {
            Some(record) => record?,
            None => self.load_trial(now)?,
        };
        let next = record.seen_at(now);
        if next.ended && !record.ended {
            log::warn!("W_TRIAL_CLOCK_SET_BACK");
            self.write_trial(&next);
        }
        if let Some(trial) = self.trial_lock()?.as_mut()
            && let Ok(kept) = trial.record.as_mut()
        {
            kept.seen = kept.seen.max(next.seen);
            kept.ended |= next.ended;
        }
        Ok(next)
    }

    fn load_trial(&self, now: i64) -> Result<Record, &'static str> {
        let _keychain = self.keychain()?;
        if let Some(trial) = self.trial_lock()?.as_ref() {
            return trial.record;
        }
        let record = match self.trial_store.get() {
            Ok(Some(text)) => Record::read(&text).map(|record| {
                let seen = record.seen_at(now);
                if self.trial_store.set(&seen.text()).is_err() {
                    log::warn!("W_TRIAL_SEEN_WRITE_FAILED");
                }
                seen
            }),
            Ok(None) => {
                let record = Record::first(now);
                self.trial_store.set(&record.text()).map(|()| {
                    log::info!("I_TRIAL_STARTED");
                    record
                })
            }
            Err(code) => Err(code),
        };
        if let Err(code) = record {
            log::warn!("W_TRIAL_UNREADABLE {code}");
        }
        *self.trial_lock()? = Some(Trial {
            record,
            written: now,
        });
        record
    }

    fn write_trial(&self, record: &Record) {
        let written = self
            .keychain()
            .and_then(|_keychain| self.trial_store.set(&record.text()));
        match written {
            Ok(()) => {
                if let Ok(Some(trial)) = self.trial_lock().as_deref_mut() {
                    trial.written = record.seen;
                }
            }
            Err(code) => log::warn!("W_TRIAL_SEEN_WRITE_FAILED {code}"),
        }
    }

    /// Whether `what` may be written, sync connect or AI send now: always in a build that gates
    /// nothing, else with a valid licence or while the trial runs. A note's text and history are
    /// still written for a short grace after the trial ran out, so a save in flight lands.
    fn unlocked(&self, what: Write) -> bool {
        if !self.keys.gated() || self.key_snapshot().state == LicenceState::Valid {
            return true;
        }
        let now = (self.clock)();
        self.trial_at(now)
            .is_ok_and(|trial| trial.running(now) || (what == Write::Body && trial.in_grace(now)))
    }

    /// Sync and AI call this before they connect or send.
    pub(crate) fn require(&self) -> Result<(), &'static str> {
        if self.unlocked(Write::Content) {
            Ok(())
        } else {
            Err(REQUIRED)
        }
    }

    /// The database's write gate: user content is refused once the trial is over without a valid
    /// licence; sync's bookkeeping and the search index never are.
    pub(crate) fn require_write(&self, what: Write) -> Result<(), &'static str> {
        if what == Write::Bookkeeping || self.unlocked(what) {
            Ok(())
        } else {
            Err(REQUIRED)
        }
    }

    /// Writes the latest time seen every `SEEN_EVERY_MS`, reads again a trial that could not be read,
    /// and tells the windows when what they show changed (the trial ended).
    pub(crate) fn tick(&self) {
        if !self.keys.gated() {
            return;
        }
        let now = (self.clock)();
        if let Ok(mut trial) = self.trial_lock()
            && trial.as_ref().is_some_and(|trial| trial.record.is_err())
        {
            *trial = None;
        }
        let written = self
            .trial_lock()
            .ok()
            .and_then(|trial| trial.as_ref().map(|trial| trial.written));
        if let (Ok(record), Some(written)) = (self.trial_at(now), written)
            && now.saturating_sub(written) >= trial::SEEN_EVERY_MS
        {
            self.write_trial(&record);
        }
        let snapshot = self.snapshot();
        let Ok(mut ticked) = self.ticked.lock() else {
            return;
        };
        if ticked.as_ref() != Some(&snapshot) {
            (self.emit)(&snapshot);
            *ticked = Some(snapshot);
        }
    }

    fn changed(&self) -> Snapshot {
        let snapshot = self.snapshot();
        (self.emit)(&snapshot);
        snapshot
    }

    /// Checks a key without keeping it: what adding it would show. It reads no keychain, since a
    /// link arrives on the main thread.
    pub(crate) fn offer(&self, input: &str) -> Result<Offer, &'static str> {
        let key = cleaned(input)?;
        let payload = verify_licence(&key, &self.keys).map_err(VerifyError::code)?;
        let loaded = self.held()?.as_ref().map(|held| held.revocations.clone());
        let revocations = loaded.unwrap_or_else(|| self.read_revocations());
        let state = self.state_of(&payload, revocations.as_ref());
        Ok(Offer {
            id: payload.id,
            licensee: payload.licensee,
            state,
        })
    }

    /// Replaces the licence with a key that verifies; a key that does not is refused with its code
    /// and nothing changes.
    pub(crate) fn set(&self, input: &str) -> Result<Snapshot, &'static str> {
        let key = cleaned(input)?;
        let payload = verify_licence(&key, &self.keys).map_err(|e| {
            log::warn!("W_LICENCE_REFUSED {}", e.code());
            e.code()
        })?;
        let id = payload.id.clone();
        {
            let _keychain = self.keychain()?;
            self.store.set(&key)?;
            self.put(Some((key, Ok(payload))))?;
        }
        log::info!("I_LICENCE_SET licence={id}");
        Ok(self.changed())
    }

    /// Writing or removing the item never reads it, so a key the keychain cannot give back is
    /// still replaced or removed.
    pub(crate) fn remove(&self) -> Result<Snapshot, &'static str> {
        {
            let _keychain = self.keychain()?;
            self.store.clear()?;
            self.put(None)?;
        }
        log::info!("I_LICENCE_REMOVED");
        Ok(self.changed())
    }

    pub(crate) fn gated(&self) -> bool {
        self.keys.gated()
    }

    /// Whether a revocation list could change anything: the build gates, and a key that verifies
    /// is held.
    pub(crate) fn wants_revocations(&self) -> bool {
        self.keys.gated() && self.key_snapshot().id.is_some()
    }

    /// Keeps a revocation list that verifies and is not older than the one kept; `false` when it
    /// was older and so changed nothing.
    pub(crate) fn apply_revocations(&self, list: &str) -> Result<bool, &'static str> {
        let verified = verify_revocations(list, &self.keys).map_err(|e| {
            log::warn!("W_LICENCE_REVOCATIONS_REFUSED {}", e.code());
            e.code()
        })?;
        let kept = self.with_held(|held| -> Result<bool, &'static str> {
            if held
                .revocations
                .as_ref()
                .is_some_and(|old| old.issued_at > verified.issued_at)
            {
                return Ok(false);
            }
            crate::atomic_file::write_replacing(&self.revocations_path, list.as_bytes())
                .map_err(|_| "E_LICENCE_REVOCATIONS_WRITE_FAILED")?;
            log::info!(
                "I_LICENCE_REVOCATIONS issued={} count={}",
                verified.issued_at,
                verified.ids.len()
            );
            held.revocations = Some(verified);
            Ok(true)
        })??;
        if kept {
            self.changed();
        }
        Ok(kept)
    }

    #[cfg(test)]
    pub(crate) fn revoked(&self) -> std::collections::BTreeSet<String> {
        self.with_held(|held| {
            held.revocations
                .as_ref()
                .map(|list| list.ids.clone())
                .unwrap_or_default()
        })
        .unwrap_or_default()
    }
}

/// What sync, AI and the database's writes hold to ask whether they may run.
#[derive(Clone)]
pub(crate) struct Gate(Option<Arc<Licence>>);

impl Gate {
    pub(crate) fn of(licence: &Arc<Licence>) -> Self {
        Self(Some(Arc::clone(licence)))
    }

    /// No licence asked for: tests of what sync and AI do once allowed.
    #[cfg(test)]
    pub(crate) fn open() -> Self {
        Self(None)
    }

    pub(crate) fn require(&self) -> Result<(), &'static str> {
        self.0.as_ref().map_or(Ok(()), |licence| licence.require())
    }

    pub(crate) fn require_write(&self, what: Write) -> Result<(), &'static str> {
        self.0
            .as_ref()
            .map_or(Ok(()), |licence| licence.require_write(what))
    }
}

/// Looks at the trial every `TICK` for the life of the process, in a build that gates.
pub(crate) fn watch_trial(licence: &Arc<Licence>) {
    if !licence.gated() {
        return;
    }
    let licence = Arc::clone(licence);
    let started = std::thread::Builder::new()
        .name("licence-trial".into())
        .spawn(move || {
            loop {
                licence.tick();
                std::thread::sleep(TICK);
            }
        });
    if started.is_err() {
        log::warn!("W_TRIAL_WATCH_FAILED");
    }
}

async fn blocking<T: Send + 'static>(
    licence: &Arc<Licence>,
    work: impl FnOnce(&Licence) -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    let licence = Arc::clone(licence);
    tauri::async_runtime::spawn_blocking(move || work(&licence))
        .await
        .map_err(|_| "E_LICENCE_INTERNAL".to_string())?
        .map_err(String::from)
}

#[tauri::command]
pub async fn licence_get(licence: Tauri<'_, Arc<Licence>>) -> Result<Snapshot, String> {
    blocking(&licence, |licence| Ok(licence.snapshot())).await
}

#[tauri::command]
pub async fn licence_set(
    licence: Tauri<'_, Arc<Licence>>,
    key: String,
) -> Result<Snapshot, String> {
    blocking(&licence, move |licence| licence.set(&key)).await
}

#[tauri::command]
pub async fn licence_remove(licence: Tauri<'_, Arc<Licence>>) -> Result<Snapshot, String> {
    blocking(&licence, |licence| licence.remove()).await
}
