//! The licence that unlocks sync and AI (docs/adr/0006-source-available-and-sold-once.md, The
//! licence): a signed key checked offline against the public keys the build holds, kept in the
//! keychain. Its state is none, valid, updates ended (the build was released after the licence's
//! `updatesUntil`), revoked (in the last verified revocation list) or invalid (with its code).
//! While the build holds no production key nothing is gated, so a release made before the owner's
//! keys exist changes nothing.
//! The key and the licensee's address never reach a log, an error or a crash report: logs carry
//! codes and the licence ID.

mod format;
mod keys;
mod store;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::State as Tauri;

pub(crate) use format::MAX_LENGTH;
use format::{Payload, Revocations, VerifyError, verify_licence, verify_revocations};
pub(crate) use keys::{PublicKeys, RELEASE_DATE};
pub(crate) use store::{KeyStore, Keychain, REVOCATIONS_FILE};

pub(crate) const CHANGED_EVENT: &str = "devot://licence-changed";
pub(crate) const REQUIRED: &str = "E_LICENCE_REQUIRED";
/// A pasted key may carry line breaks from an email; anything longer than this is not a key.
const MAX_INPUT: usize = 4 * MAX_LENGTH;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LicenceState {
    None,
    Valid,
    UpdatesEnded,
    Revoked,
    Invalid,
}

/// What the windows see: never the key.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    /// Whether sync and AI need a licence in this build.
    pub gated: bool,
    pub state: LicenceState,
    /// Why the key is invalid, or why it could not be read.
    pub code: Option<&'static str>,
    pub id: Option<String>,
    pub licensee: Option<String>,
    pub updates_until: Option<String>,
    pub plan: Option<&'static str>,
}

impl fmt::Debug for Snapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Snapshot")
            .field("gated", &self.gated)
            .field("state", &self.state)
            .field("code", &self.code)
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// A key from a link, checked before the window asks whether to add it.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Offer {
    pub id: String,
    pub licensee: String,
    pub updates_until: String,
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

pub(crate) struct Licence {
    keys: PublicKeys,
    release: Option<String>,
    store: Arc<dyn KeyStore>,
    revocations_path: PathBuf,
    /// Taken around every keychain use, which may wait on a prompt; `held` is never held across one,
    /// so a link's offer does not wait.
    keychain: Mutex<()>,
    /// Read from the keychain and the list's file once, on first use.
    held: Mutex<Option<Held>>,
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
        release: Option<&str>,
        store: Arc<dyn KeyStore>,
        data_dir: &Path,
        emit: Emit,
    ) -> Self {
        Self {
            keys,
            release: release.map(str::to_owned),
            store,
            revocations_path: data_dir.join(REVOCATIONS_FILE),
            keychain: Mutex::new(()),
            held: Mutex::new(None),
            emit,
        }
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
        } else if !keys::covers(&payload.updates_until, self.release.as_deref()) {
            LicenceState::UpdatesEnded
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
            updates_until: None,
            plan: None,
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
                updates_until: Some(payload.updates_until.clone()),
                plan: Some(format::PLAN),
                ..empty
            },
        }
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        self.with_held(|held| self.snapshot_of(held))
            .unwrap_or_else(|code| Snapshot {
                gated: self.keys.gated(),
                state: LicenceState::None,
                code: Some(code),
                id: None,
                licensee: None,
                updates_until: None,
                plan: None,
            })
    }

    /// Sync and AI call this before they connect or send.
    pub(crate) fn require(&self) -> Result<(), &'static str> {
        if !self.keys.gated() || self.snapshot().state == LicenceState::Valid {
            Ok(())
        } else {
            Err(REQUIRED)
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
            updates_until: payload.updates_until,
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

    /// Keeps a revocation list that verifies and is not older than the one kept; `false` when it
    /// was older and so changed nothing. #350 fetches the list.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "fetching the list (#350) is its caller")
    )]
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

/// What sync and AI hold to ask whether they may run.
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
