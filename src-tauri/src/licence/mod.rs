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

mod activation;
pub(crate) mod client;
mod device;
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

pub(crate) use activation::ACTIVATION_ACCOUNT;
pub(crate) use client::Reply as ActivationReply;
pub(crate) use device::DEVICE_ACCOUNT;
pub(crate) use format::MAX_LENGTH;
use format::{
    Payload, Revocations, VerifyError, verify_activation, verify_licence, verify_revocations,
};
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
/// A note's text and history are still written this long after a seat runs out, so a save in
/// flight lands (the trial's grace is the same idea).
const SEAT_GRACE_MS: i64 = 5 * 60_000;
/// How many licences a device remembers having tried; past this the oldest is forgotten.
const MAX_ATTEMPTED: usize = 32;

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
    /// This device's seat, in a build that manages them; None otherwise.
    pub activation: Option<ActivationView>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivationView {
    pub state: activation::State,
    pub used: u32,
    pub limit: u32,
    /// Milliseconds since the epoch.
    pub expires_at: Option<i64>,
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
/// Asks the Worker for a seat: the key, this device's ID and its label.
pub(crate) type Activator =
    Arc<dyn Fn(&str, &str, &str) -> Result<ActivationReply, &'static str> + Send + Sync>;
/// What the devices page and the Worker's logs show for this build.
const DEVICE_LABEL: &str = if cfg!(target_os = "macos") {
    "Devot for macOS"
} else if cfg!(target_os = "ios") {
    "Devot for iPhone"
} else {
    "Devot"
};

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
    /// Why the key could not be read (a denied keychain prompt, say): it is asked for again at the
    /// next tick rather than at every write, each of which would prompt again.
    unread: Mutex<Option<&'static str>>,
    trial_store: Arc<dyn KeyStore>,
    /// Read from the keychain on first use (begun there on the first launch); one that could not be
    /// read is read again at the next tick. Never held across a keychain use either.
    trial: Mutex<Option<Trial>>,
    /// What the last tick saw, so a change (the trial's end) reaches the windows once.
    ticked: Mutex<Option<Snapshot>>,
    clock: Clock,
    emit: Emit,
    device_store: Option<Arc<dyn KeyStore>>,
    activation_store: Option<Arc<dyn KeyStore>>,
    /// The lease and the seats it reported, read from the keychain once.
    activation: Mutex<Option<activation::Stored>>,
    device: Mutex<Option<String>>,
    activator: Activator,
    /// Why the last activation attempt failed, for the snapshot's code; cleared on success.
    seat_error: Mutex<Option<&'static str>>,
    /// Why the seat item could not be read: a managed device with no readable seat is locked,
    /// and the read is tried again at the next tick rather than at every write.
    seat_unread: Mutex<Option<&'static str>>,
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
            unread: Mutex::new(None),
            trial_store,
            trial: Mutex::new(None),
            ticked: Mutex::new(None),
            device_store: None,
            activation_store: None,
            activation: Mutex::new(None),
            device: Mutex::new(None),
            activator: Arc::new(client::activate_from_site),
            seat_error: Mutex::new(None),
            seat_unread: Mutex::new(None),
            clock: Arc::new(system_now),
            emit,
        }
    }

    /// Manages this device's seats (docs/licensing.md, Activation). Without it the licence is the
    /// key alone, as before seats existed.
    pub(crate) fn with_activation(
        mut self,
        device_store: Arc<dyn KeyStore>,
        activation_store: Arc<dyn KeyStore>,
        activator: Activator,
    ) -> Self {
        self.device_store = Some(device_store);
        self.activation_store = Some(activation_store);
        self.activator = activator;
        self
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

    fn unread(&self) -> Result<MutexGuard<'_, Option<&'static str>>, &'static str> {
        self.unread.lock().map_err(|_| "E_LICENCE_INTERNAL")
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
        *self.unread()? = None;
        Ok(())
    }

    fn with_held<T>(&self, f: impl FnOnce(&mut Held) -> T) -> Result<T, &'static str> {
        if let Some(held) = self.held()?.as_mut() {
            return Ok(f(held));
        }
        {
            let _keychain = self.keychain()?;
            if self.held()?.is_none() {
                if let Some(code) = *self.unread()? {
                    return Err(code);
                }
                let stored = match self.store.get() {
                    Ok(stored) => stored,
                    Err(code) => {
                        log::warn!("W_LICENCE_UNREADABLE {code}");
                        *self.unread()? = Some(code);
                        return Err(code);
                    }
                };
                let key = stored.map(|key| {
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
            activation: None,
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

    /// The key's state, then this device's seat. The seat is read outside `held`: its keychain
    /// reads must never nest inside another keychain use, which `put` takes in the other order.
    fn key_snapshot(&self) -> Snapshot {
        let now = (self.clock)();
        let mut snapshot = self
            .with_held(|held| self.snapshot_of(held))
            .unwrap_or_else(|code| Snapshot {
                gated: self.keys.gated(),
                state: LicenceState::None,
                code: Some(code),
                id: None,
                licensee: None,
                plan: None,
                trial: None,
                activation: None,
            });
        if snapshot.state == LicenceState::Valid
            && let Some(id) = snapshot.id.as_deref()
        {
            let issued_at = self
                .with_held(|held| {
                    held.key
                        .as_ref()
                        .and_then(|(_, payload)| payload.as_ref().ok())
                        .map(|payload| payload.issued_at.clone())
                })
                .ok()
                .flatten()
                .unwrap_or_default();
            let mut check = self.activation_check(id, now);
            // A key sold before seats existed, on a device that has not reached the Worker yet,
            // gets its 30 days. A key sold since, a refused request, or one never held from
            // before does not.
            if check
                .as_ref()
                .is_some_and(|c| c.state == activation::State::Required && c.expires_at.is_none())
                && activation::predates_seats(&issued_at)
                && !self.attempted_for(id)
            {
                self.start_migration(id);
                check = self.activation_check(id, now);
            }
            match check {
                Some(check) => {
                    // A failed attempt explains a usable migration window; once it is over, the
                    // seat's own code says what is missing.
                    let code = if check.state == activation::State::Active {
                        self.seat_error
                            .lock()
                            .ok()
                            .and_then(|code| *code)
                            .or(check.code)
                    } else {
                        check.code
                    };
                    if code.is_some() {
                        snapshot.code = code;
                    }
                    snapshot.activation = self
                        .with_activation_record(|stored| ActivationView {
                            state: check.state,
                            used: stored.used,
                            limit: stored.limit,
                            expires_at: check.expires_at,
                        })
                        .ok();
                }
                None => {
                    // A managed device whose seat cannot be read is locked, never unlocked.
                    snapshot.code = Some(
                        self.seat_unread
                            .lock()
                            .ok()
                            .and_then(|code| *code)
                            .unwrap_or("E_LICENCE_ACTIVATION_UNREADABLE"),
                    );
                    snapshot.activation = Some(ActivationView {
                        state: activation::State::Required,
                        used: 0,
                        limit: 0,
                        expires_at: None,
                    });
                }
            }
        }
        snapshot
    }

    fn managed(&self) -> bool {
        self.activation_store.is_some()
    }

    fn device_id(&self) -> Result<String, &'static str> {
        if let Some(id) = self
            .device
            .lock()
            .map_err(|_| "E_LICENCE_INTERNAL")?
            .clone()
        {
            return Ok(id);
        }
        let store = self.device_store.as_deref().ok_or("E_LICENCE_INTERNAL")?;
        let _keychain = self.keychain()?;
        let id = device::id(store)?;
        *self.device.lock().map_err(|_| "E_LICENCE_INTERNAL")? = Some(id.clone());
        Ok(id)
    }

    fn with_activation_record<T>(
        &self,
        f: impl FnOnce(&mut activation::Stored) -> T,
    ) -> Result<T, &'static str> {
        let store = self
            .activation_store
            .as_deref()
            .ok_or("E_LICENCE_INTERNAL")?;
        if let Some(code) = *self.seat_unread.lock().map_err(|_| "E_LICENCE_INTERNAL")? {
            return Err(code);
        }
        if self
            .activation
            .lock()
            .map_err(|_| "E_LICENCE_INTERNAL")?
            .is_none()
        {
            let _keychain = self.keychain()?;
            if self
                .activation
                .lock()
                .map_err(|_| "E_LICENCE_INTERNAL")?
                .is_none()
            {
                match activation::read(store) {
                    Ok(stored) => {
                        *self.activation.lock().map_err(|_| "E_LICENCE_INTERNAL")? = Some(stored);
                    }
                    Err(code) => {
                        log::warn!("W_LICENCE_ACTIVATION_UNREADABLE {code}");
                        *self.seat_unread.lock().map_err(|_| "E_LICENCE_INTERNAL")? = Some(code);
                        return Err(code);
                    }
                }
            }
        }
        let mut guard = self.activation.lock().map_err(|_| "E_LICENCE_INTERNAL")?;
        Ok(f(guard.as_mut().ok_or("E_LICENCE_INTERNAL")?))
    }

    fn activation_check(&self, licence_id: &str, now: i64) -> Option<activation::Check> {
        if !self.managed() {
            return None;
        }
        let device = match self.device_id() {
            Ok(device) => device,
            Err(code) => {
                if let Ok(mut unread) = self.seat_unread.lock() {
                    *unread = Some(code);
                }
                return None;
            }
        };
        self.with_activation_record(|stored| {
            activation::check(stored, &self.keys, licence_id, &device, now)
        })
        .ok()
    }

    fn persist_activation(&self) -> Result<(), &'static str> {
        let stored = self
            .activation
            .lock()
            .map_err(|_| "E_LICENCE_INTERNAL")?
            .clone()
            .ok_or("E_LICENCE_INTERNAL")?;
        let store = self
            .activation_store
            .as_deref()
            .ok_or("E_LICENCE_INTERNAL")?;
        let _keychain = self.keychain()?;
        activation::write(store, &stored)
    }

    /// Takes or renews this device's seat; a failure leaves the lease kept and says why.
    fn activate_now(&self, licence_id: &str, key: &str) -> Result<(), &'static str> {
        let device = self.device_id()?;
        let reply = (self.activator)(key, &device, DEVICE_LABEL)?;
        self.with_activation_record(|stored| {
            stored.lease = Some(reply.lease.clone());
            stored.used = reply.used;
            stored.limit = reply.limit;
            stored.migration = None;
        })?;
        self.persist_activation()?;
        log::info!("I_LICENCE_ACTIVATED licence={licence_id}");
        Ok(())
    }

    /// Records that this device asked for this licence, so a refusal never turns into a window.
    fn mark_attempted(&self, licence_id: &str) {
        let marked = self.with_activation_record(|stored| {
            if !stored.attempted.iter().any(|id| id == licence_id) {
                stored.attempted.push(licence_id.to_owned());
                if stored.attempted.len() > MAX_ATTEMPTED {
                    stored.attempted.remove(0);
                }
            }
        });
        if marked.and_then(|()| self.persist_activation()).is_err() {
            log::warn!("W_LICENCE_ATTEMPT_WRITE_FAILED");
        }
    }

    fn attempted_for(&self, licence_id: &str) -> bool {
        self.with_activation_record(|stored| stored.attempted.iter().any(|id| id == licence_id))
            .unwrap_or(true)
    }

    /// A key added while the Worker could not be reached works for the migration window. A
    /// window already there is never moved forward, and the key counts as tried from now on.
    fn start_migration(&self, licence_id: &str) {
        let now = (self.clock)();
        let started = self.with_activation_record(|stored| {
            if stored.lease.is_none() && stored.migration.is_none() {
                stored.migration = Some(activation::Migration {
                    id: licence_id.to_owned(),
                    first_seen: now,
                });
                if !stored.attempted.iter().any(|id| id == licence_id) {
                    stored.attempted.push(licence_id.to_owned());
                }
            }
        });
        if started.and_then(|()| self.persist_activation()).is_err() {
            log::warn!("W_LICENCE_MIGRATION_WRITE_FAILED");
        }
    }

    /// A seat item that does not parse can never be read again; re-pasting a key, removing the
    /// licence or Retry replaces it, so the device is not locked out for good.
    fn recover_seat(&self) {
        if self.with_activation_record(|_| ()).is_ok() {
            return;
        }
        if self.seat_unread.lock().ok().and_then(|code| *code)
            != Some("E_LICENCE_ACTIVATION_UNREADABLE")
        {
            return;
        }
        if self.reset_activation_record().is_err() {
            log::warn!("W_LICENCE_ACTIVATION_RESET_FAILED");
        }
    }

    fn reset_activation_record(&self) -> Result<(), &'static str> {
        let store = self
            .activation_store
            .as_deref()
            .ok_or("E_LICENCE_INTERNAL")?;
        *self.activation.lock().map_err(|_| "E_LICENCE_INTERNAL")? =
            Some(activation::Stored::default());
        *self.seat_unread.lock().map_err(|_| "E_LICENCE_INTERNAL")? = None;
        let _keychain = self.keychain()?;
        activation::write(store, &activation::Stored::default())
    }

    fn reset_seat_if_other(&self, licence_id: &str) {
        let reset = self.with_activation_record(|stored| {
            let lease_id = stored
                .lease
                .as_deref()
                .and_then(|lease| verify_activation(lease, &self.keys).ok())
                .map(|activation| activation.id);
            let migration_id = stored.migration.as_ref().map(|m| m.id.clone());
            let other = lease_id.as_deref().is_some_and(|id| id != licence_id)
                || migration_id.as_deref().is_some_and(|id| id != licence_id);
            if other {
                stored.lease = None;
                stored.used = 0;
                stored.limit = 0;
                stored.migration = None;
            }
            other
        });
        if reset == Ok(true) {
            let _ = self.persist_activation();
        }
    }

    /// Renews the seat now, whatever the schedule; a failure keeps the lease that is there.
    pub(crate) fn refresh_activation(&self) -> Result<bool, &'static str> {
        if !self.managed() {
            return Ok(false);
        }
        self.recover_seat();
        let Some(id) = self.key_snapshot().id else {
            return Ok(false);
        };
        self.mark_attempted(&id);
        let key = self.with_held(|held| {
            held.key
                .as_ref()
                .and_then(|(key, payload)| payload.is_ok().then(|| key.clone()))
        })?;
        let Some(key) = key else {
            return Ok(false);
        };
        match self.activate_now(&id, &key) {
            Ok(()) => {
                if let Ok(mut seat) = self.seat_error.lock() {
                    *seat = None;
                }
                self.changed();
                Ok(true)
            }
            Err(code) => {
                if let Ok(mut seat) = self.seat_error.lock() {
                    *seat = Some(code);
                }
                Err(code)
            }
        }
    }

    /// What the daily schedule runs: the seat when it is missing or near its end.
    pub(crate) fn refresh_activation_if_due(&self) -> bool {
        if !self.managed() {
            return false;
        }
        let now = (self.clock)();
        let Some(id) = self.key_snapshot().id else {
            return false;
        };
        let Ok(device) = self.device_id() else {
            return false;
        };
        let due = self
            .with_activation_record(|stored| activation::due(stored, &self.keys, &id, &device, now))
            .unwrap_or(false);
        if !due {
            return false;
        }
        match self.refresh_activation() {
            Ok(_) => true,
            Err(code) => {
                log::warn!("W_LICENCE_ACTIVATION_FAILED {code}");
                // An unreachable Worker is tried again at the next wake-up; a refusal waits.
                !activation::offline(code)
            }
        }
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
                if seen.ended && !record.ended {
                    log::warn!("W_TRIAL_CLOCK_SET_BACK");
                }
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
        if let Err(code) = written {
            log::warn!("W_TRIAL_SEEN_WRITE_FAILED {code}");
        }
        // A refused write waits as long as one that landed: each try may bring back the
        // keychain's prompt.
        if let Ok(Some(trial)) = self.trial_lock().as_deref_mut() {
            trial.written = record.seen;
        }
    }

    /// Whether `what` may be written, sync connect or AI send now: always in a build that gates
    /// nothing, else with a valid licence or while the trial runs. A note's text and history are
    /// still written for a short grace after the trial ran out, so a save in flight lands.
    fn unlocked(&self, what: Write) -> bool {
        if !self.keys.gated() {
            return true;
        }
        let now = (self.clock)();
        let snapshot = self.key_snapshot();
        let licensed = snapshot.state == LicenceState::Valid
            && if self.managed() {
                match snapshot.activation {
                    Some(seat) if seat.state == activation::State::Active => true,
                    // A save in flight still lands when the lease runs out under it.
                    Some(seat) if what == Write::Body => seat
                        .expires_at
                        .is_some_and(|expires| now.saturating_sub(expires) < SEAT_GRACE_MS),
                    _ => false,
                }
            } else {
                true
            };
        if licensed {
            return true;
        }
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

    /// Writes the latest time seen every `SEEN_EVERY_MS` while no licence is valid, reads again a
    /// key or a trial that could not be read, and tells the windows when what they show changed
    /// (the trial ended).
    pub(crate) fn tick(&self) {
        if !self.keys.gated() {
            return;
        }
        let now = (self.clock)();
        if let Ok(mut unread) = self.unread() {
            *unread = None;
        }
        if let Ok(mut unread) = self.seat_unread.lock() {
            *unread = None;
        }
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
            && self.key_snapshot().state != LicenceState::Valid
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
        let issued_at = payload.issued_at.clone();
        let first_try = if self.managed() {
            self.recover_seat();
            self.reset_seat_if_other(&id);
            let first_try = !self.attempted_for(&id);
            // Marked before the key is kept, so a snapshot in between cannot open a window.
            self.mark_attempted(&id);
            first_try
        } else {
            false
        };
        {
            let _keychain = self.keychain()?;
            self.store.set(&key)?;
            self.put(Some((key.clone(), Ok(payload))))?;
        }
        if self.managed() {
            if let Err(code) = self.activate_now(&id, &key) {
                log::warn!("W_LICENCE_ACTIVATION_FAILED {code}");
                if let Ok(mut seat) = self.seat_error.lock() {
                    *seat = Some(code);
                }
                // Only the first try of a key sold before seats existed, and only when the
                // Worker was unreachable, opens the window; a refusal is final.
                if first_try && activation::offline(code) && activation::predates_seats(&issued_at)
                {
                    self.start_migration(&id);
                }
            } else if let Ok(mut seat) = self.seat_error.lock() {
                *seat = None;
            }
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
        if self.managed() {
            self.recover_seat();
            let cleared = self
                .with_activation_record(|stored| {
                    stored.lease = None;
                    stored.used = 0;
                    stored.limit = 0;
                    stored.migration = None;
                })
                .and_then(|()| self.persist_activation());
            if cleared.is_err() {
                log::warn!("W_LICENCE_ACTIVATION_CLEAR_FAILED");
            }
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

/// Settings > Licence's Retry: asks the Worker for this device's seat now.
#[tauri::command]
pub async fn licence_refresh(licence: Tauri<'_, Arc<Licence>>) -> Result<Snapshot, String> {
    blocking(&licence, |licence| {
        licence.refresh_activation()?;
        Ok(licence.snapshot())
    })
    .await
}
