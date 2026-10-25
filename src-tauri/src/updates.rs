//! Automatic updates (Tauri's updater, signed releases).
//! Release builds check the update feed 30 seconds after launch and then once a day; Check for
//! Updates checks at once. The feed is a channel file in the repository's fixed `updater` release:
//! a prerelease build (a `-betaN` version) reads `beta.json`, any other build `stable.json`.
//! An update found downloads in the background when the `autoDownloadUpdates` editor setting is on
//! (the default); otherwise the main window offers a Download button. A downloaded update waits:
//! Restart to Update installs it and restarts once the window has saved (the quit handshake, see
//! `exit`). A plain quit installs nothing.
//! A licence covers the updates released up to its `updatesUntil` (docs/adr/0006). When the licence
//! is valid for the running build and the update was released after that date (the feed's
//! `pub_date`, UTC), the update is not downloaded: the status says so (`notCovered`) and the main
//! window offers Renew, Download Anyway and Skip This Version. The skip is remembered for that
//! version only; a later version, or a manual check, offers the update again. Everyone else (no
//! licence, a build that gates nothing, a covered update) gets the behaviour above unchanged.
//! The same schedule fetches the licence's revocation list once a day, also in a build without the
//! updater's key (`licence::revoked`).
//! Rust holds the status and sends it (`devot://update-status`, with a revision so an older one
//! never overrides a newer one) to every window after each change. A build without the updater's
//! public key (any local or dev build: the release workflow passes the key at build time) has no
//! updater: it never checks on its own, and a manual check says updates are unavailable.

use crate::exit;
use crate::licence::{self, Licence, LicenceState};
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Window, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const STATUS_EVENT: &str = "devot://update-status";
const FEED_BASE: &str = "https://github.com/jma49/devot/releases/download/updater";
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Betas ship several times a day.
const CHECK_EVERY_BETA: Duration = Duration::from_secs(60 * 60);
/// Wall-clock time, so a Mac that slept through the day checks soon after it wakes.
const WAKE_EVERY: Duration = Duration::from_secs(15 * 60);
/// The updater sets no timeout of its own, and a hung request would keep any later check out.
const STALL_LIMIT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
}

pub fn channel_for(version: &str) -> Channel {
    let version = version.split('+').next().unwrap_or_default();
    if version.contains('-') {
        Channel::Beta
    } else {
        Channel::Stable
    }
}

pub fn feed_url(channel: Channel) -> String {
    let file = match channel {
        Channel::Stable => "stable.json",
        Channel::Beta => "beta.json",
    };
    format!("{FEED_BASE}/{file}")
}

pub fn configured(updater: Option<&Value>) -> bool {
    updater
        .and_then(|config| config.get("pubkey"))
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum State {
    Idle,
    Checking,
    UpToDate,
    Available {
        version: String,
    },
    /// The licence does not cover this update: nothing downloads until the user chooses to.
    NotCovered {
        version: String,
        updates_until: String,
    },
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    Ready {
        version: String,
    },
    Failed {
        code: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: u64,
    pub current: String,
    pub enabled: bool,
    /// The window that asked for the last manual check, download or restart
    /// (only that window reports up to date or a failure).
    pub asked_by: Option<String>,
    #[serde(flatten)]
    pub state: State,
}

fn may_check(state: &State) -> bool {
    !matches!(
        state,
        State::Checking | State::Downloading { .. } | State::Ready { .. }
    )
}

/// The version the user may download, and whether only by choosing Download Anyway.
fn downloadable(state: &State, anyway: bool) -> Option<&str> {
    match state {
        State::Available { version } => Some(version),
        State::NotCovered { version, .. } if anyway => Some(version),
        _ => None,
    }
}

/// The date (YYYY-MM-DD, UTC) of a Unix time, by the civil-from-days algorithm.
fn utc_date(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400) + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The last release date the licence covers, when it does not cover an update released on
/// `released`: only a licence that is valid for the running build and gated sync and AI make the
/// update one the user is told about. An update without a date is treated as covered.
fn uncovered_until(snapshot: &licence::Snapshot, released: Option<&str>) -> Option<String> {
    let until = snapshot.updates_until.as_deref()?;
    let released = released?;
    (snapshot.gated
        && snapshot.state == LicenceState::Valid
        && !licence::covers(until, Some(released)))
    .then(|| until.to_owned())
}

/// The version the user chose to skip, kept in the app data folder: it holds back the prompt for
/// that version only.
struct Skipped {
    path: PathBuf,
}

const SKIPPED_FILE: &str = "update-skipped-version.txt";

impl Skipped {
    fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(SKIPPED_FILE),
        }
    }

    fn read(&self) -> Option<String> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        let version = text.trim();
        (!version.is_empty()
            && version.len() <= 64
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
        .then(|| version.to_owned())
    }

    /// Whether `version` is the one skipped. Any other version forgets the skip, so a later
    /// version is offered whatever came before.
    fn holds_back(&self, version: &str) -> bool {
        match self.read() {
            Some(skipped) if skipped == version => true,
            Some(_) => {
                let _ = std::fs::remove_file(&self.path);
                false
            }
            None => false,
        }
    }

    fn remember(&self, version: &str) -> Result<(), &'static str> {
        crate::atomic_file::write_replacing(&self.path, version.as_bytes())
            .map_err(|_| "E_UPDATE_SKIP_FAILED")
    }
}

fn nothing_found(manual: bool) -> State {
    if manual { State::UpToDate } else { State::Idle }
}

/// Shown when the user asked; otherwise only logged (the next daily check tries again).
fn failed(manual: bool, code: &str) -> State {
    if manual {
        State::Failed { code: code.into() }
    } else {
        State::Idle
    }
}

/// `work`'s output, or None once `progress` has not moved for `limit`.
async fn unless_stalled<T>(
    work: impl Future<Output = T>,
    progress: &AtomicU64,
    limit: Duration,
) -> Option<T> {
    let mut work = std::pin::pin!(work);
    let mut seen = progress.load(Ordering::Relaxed);
    loop {
        if let Ok(out) = tokio::time::timeout(limit, &mut work).await {
            return Some(out);
        }
        let now = progress.load(Ordering::Relaxed);
        if now == seen {
            return None;
        }
        seen = now;
    }
}

fn percent(done: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    u8::try_from(done.min(total).saturating_mul(100) / total).ok()
}

fn check_every(channel: Channel) -> Duration {
    match channel {
        Channel::Stable => CHECK_EVERY,
        Channel::Beta => CHECK_EVERY_BETA,
    }
}

fn due(last: Option<SystemTime>, now: SystemTime, every: Duration) -> bool {
    last.is_none_or(|at| now.duration_since(at).is_ok_and(|gone| gone >= every) || now < at)
}

fn due_now(app: &AppHandle) -> bool {
    let updates = app.state::<Updates>();
    let every = check_every(channel_for(&updates.current));
    due(updates.lock().last_check, SystemTime::now(), every)
}

/// The main window coming to the front checks when one is due, so a beta shows up without a wait.
pub fn on_window_event(window: &Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    if !matches!(event, tauri::WindowEvent::Focused(true))
        || !crate::main_windows::is_main(window.label())
        || cfg!(debug_assertions)
        || !app.state::<Updates>().enabled
        || !due_now(app)
    {
        return;
    }
    tauri::async_runtime::spawn(check(app.clone(), None));
}

pub fn menu_item(state: &State) -> (&'static str, bool) {
    match state {
        State::Checking => (crate::strings::UPDATES_CHECKING, false),
        State::Downloading { .. } => (crate::strings::UPDATES_DOWNLOADING, false),
        State::Ready { .. } => (crate::strings::UPDATES_RESTART, true),
        _ => (crate::strings::UPDATES_CHECK, true),
    }
}

struct Pending {
    update: Arc<Update>,
    bytes: Option<Vec<u8>>,
}

struct Inner {
    revision: u64,
    state: State,
    asked_by: Option<String>,
    found: Option<Arc<Update>>,
    pending: Option<Pending>,
    last_check: Option<SystemTime>,
    installing: bool,
    restart: bool,
}

pub struct Updates {
    enabled: bool,
    current: String,
    skipped: Skipped,
    inner: Mutex<Inner>,
}

impl Updates {
    pub fn new(enabled: bool, current: String, data_dir: &Path) -> Self {
        Self {
            enabled,
            current,
            skipped: Skipped::new(data_dir),
            inner: Mutex::new(Inner {
                revision: 0,
                state: State::Idle,
                asked_by: None,
                found: None,
                pending: None,
                last_check: None,
                installing: false,
                restart: false,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn status_of(&self, inner: &Inner) -> Status {
        Status {
            revision: inner.revision,
            current: self.current.clone(),
            enabled: self.enabled,
            asked_by: inner.asked_by.clone(),
            state: inner.state.clone(),
        }
    }

    pub fn status(&self) -> Status {
        self.status_of(&self.lock())
    }

    fn set(&self, inner: &mut Inner, state: State) -> Status {
        inner.revision += 1;
        inner.state = state;
        self.status_of(inner)
    }
}

pub struct UpdatesMenuItem(pub MenuItem<Wry>);

fn publish(app: &AppHandle, status: &Status) {
    if let Some(item) = app.try_state::<UpdatesMenuItem>() {
        let (title, enabled) = menu_item(&status.state);
        if item.0.set_text(title).is_err() || item.0.set_enabled(enabled).is_err() {
            log::warn!("W_UPDATES_MENU_FAILED");
        }
    }
    if app.emit(STATUS_EVENT, status).is_err() {
        log::warn!("W_UPDATES_EMIT_FAILED");
    }
}

fn change(app: &AppHandle, state: State) {
    let updates = app.state::<Updates>();
    let status = {
        let mut inner = updates.lock();
        updates.set(&mut inner, state)
    };
    publish(app, &status);
}

fn auto_download(app: &AppHandle) -> bool {
    app.try_state::<Arc<crate::editor_settings::EditorSettingsStore>>()
        .and_then(|store| store.get().ok())
        .is_none_or(|snapshot| snapshot.settings.auto_download_updates)
}

async fn check(app: AppHandle, asked_by: Option<String>) {
    let manual = asked_by.is_some();
    let updates = app.state::<Updates>();
    let status = {
        let mut inner = updates.lock();
        if manual {
            inner.asked_by.clone_from(&asked_by);
        }
        if !updates.enabled {
            if !manual {
                return;
            }
            updates.set(
                &mut inner,
                State::Failed {
                    code: "E_UPDATE_UNAVAILABLE".into(),
                },
            )
        } else if !may_check(&inner.state) {
            if !manual {
                return;
            }
            let state = inner.state.clone();
            updates.set(&mut inner, state)
        } else {
            inner.asked_by.clone_from(&asked_by);
            inner.last_check = Some(SystemTime::now());
            updates.set(&mut inner, State::Checking)
        }
    };
    publish(&app, &status);
    if !matches!(status.state, State::Checking) {
        return;
    }
    let url = feed_url(channel_for(&updates.current));
    let found = async {
        let url = url
            .parse()
            .map_err(|_| tauri_plugin_updater::Error::EmptyEndpoints)?;
        app.updater_builder()
            .endpoints(vec![url])?
            .build()?
            .check()
            .await
    };
    let Some(found) = unless_stalled(found, &AtomicU64::new(0), STALL_LIMIT).await else {
        log::warn!("W_UPDATE_CHECK_TIMED_OUT");
        change(&app, failed(manual, "E_UPDATE_CHECK_FAILED"));
        return;
    };
    match found {
        Ok(None) => {
            log::info!("I_UPDATE_NONE");
            change(&app, nothing_found(manual));
        }
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("I_UPDATE_FOUND {version}");
            let released = update.date.map(|date| utc_date(date.unix_timestamp()));
            let until = uncovered_until_for(&app, released).await;
            let skipped = updates.skipped.holds_back(&version);
            if let Some(updates_until) = until {
                if skipped && !manual {
                    log::info!("I_UPDATE_SKIPPED {version}");
                    change(&app, nothing_found(false));
                    return;
                }
                log::info!("I_UPDATE_NOT_COVERED {version}");
                let status = {
                    let mut inner = updates.lock();
                    inner.found = Some(Arc::new(update));
                    updates.set(
                        &mut inner,
                        State::NotCovered {
                            version,
                            updates_until,
                        },
                    )
                };
                publish(&app, &status);
                return;
            }
            // With auto download on, the update goes straight to downloading
            // (no window offers a Download button for it meanwhile).
            let auto = auto_download(&app);
            let status = {
                let mut inner = updates.lock();
                inner.found = Some(Arc::new(update));
                updates.set(&mut inner, State::Available { version })
            };
            if auto {
                download(app.clone(), asked_by, false).await;
            } else {
                publish(&app, &status);
            }
        }
        Err(error) => {
            log::warn!("W_UPDATE_CHECK_FAILED {error}");
            change(&app, failed(manual, "E_UPDATE_CHECK_FAILED"));
        }
    }
}

/// Whether the licence in the app does not cover an update released on `released`, and until
/// when it does. The licence may read the keychain, so it runs off the async threads.
async fn uncovered_until_for(app: &AppHandle, released: Option<String>) -> Option<String> {
    let licence = app.try_state::<Arc<Licence>>()?;
    let licence = Arc::clone(&licence);
    tauri::async_runtime::spawn_blocking(move || {
        uncovered_until(&licence.snapshot(), released.as_deref())
    })
    .await
    .ok()
    .flatten()
}

/// `anyway`: the user chose Download Anyway for an update the licence does not cover. A
/// background download never does.
async fn download(app: AppHandle, asked_by: Option<String>, anyway: bool) {
    let manual = asked_by.is_some();
    let updates = app.state::<Updates>();
    let (update, status) = {
        let mut inner = updates.lock();
        let (Some(version), Some(update)) = (downloadable(&inner.state, anyway), &inner.found)
        else {
            return;
        };
        let (version, update) = (version.to_owned(), Arc::clone(update));
        if manual {
            inner.asked_by.clone_from(&asked_by);
        }
        let status = updates.set(
            &mut inner,
            State::Downloading {
                version,
                percent: None,
            },
        );
        (update, status)
    };
    publish(&app, &status);
    let version = update.version.clone();
    let done = AtomicU64::new(0);
    let mut shown = None;
    let bytes = update.download(
        |chunk, total| {
            let now = done.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
            let now = percent(now, total);
            if now != shown {
                shown = now;
                change(
                    &app,
                    State::Downloading {
                        version: version.clone(),
                        percent: now,
                    },
                );
            }
        },
        || {},
    );
    // `download` checks the signature as well.
    let bytes = match unless_stalled(bytes, &done, STALL_LIMIT).await {
        None => {
            log::warn!("W_UPDATE_DOWNLOAD_TIMED_OUT");
            change(&app, failed(manual, "E_UPDATE_DOWNLOAD_FAILED"));
            return;
        }
        Some(Ok(bytes)) => bytes,
        Some(Err(error)) => {
            let (code, always) = download_failure(&error);
            log::warn!("W_UPDATE_DOWNLOAD_FAILED {code} {error}");
            change(&app, failed(manual || always, code));
            return;
        }
    };
    log::info!("I_UPDATE_DOWNLOADED {version}");
    let status = {
        let mut inner = updates.lock();
        inner.found = None;
        inner.pending = Some(Pending {
            update,
            bytes: Some(bytes),
        });
        updates.set(&mut inner, State::Ready { version })
    };
    publish(&app, &status);
}

/// The code of a failed download, and whether it is reported even for a
/// background download: a bad signature means a tampered or wrongly signed
/// release, never a passing network problem.
fn download_failure(error: &tauri_plugin_updater::Error) -> (&'static str, bool) {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => ("E_UPDATE_SIGNATURE_INVALID", true),
        _ => ("E_UPDATE_DOWNLOAD_FAILED", false),
    }
}

/// Skip This Version: remembers the version of an update the licence does not cover, so the
/// automatic checks stop offering it, and drops the offer.
fn skip(updates: &Updates) -> Result<Status, &'static str> {
    let mut inner = updates.lock();
    let State::NotCovered { version, .. } = &inner.state else {
        return Err("E_UPDATE_NOT_OFFERED");
    };
    let version = version.clone();
    updates.skipped.remember(&version)?;
    inner.found = None;
    log::info!("I_UPDATE_SKIP {version}");
    Ok(updates.set(&mut inner, State::Idle))
}

/// Installs the downloaded update and starts the quit; exiting then restarts
/// into the new version. Installing comes first, so a failure leaves the app
/// running as it was. It extracts the bundle and may ask for an
/// administrator password, so it runs off the main thread and without the
/// lock held.
fn restart(app: &AppHandle, asked_by: &str) -> Result<(), &'static str> {
    let updates = app.state::<Updates>();
    let job = {
        let mut inner = updates.lock();
        inner.asked_by = Some(asked_by.to_owned());
        take_install(&mut inner)?
    };
    if let Some((update, bytes)) = job {
        let installed = update.install(&bytes);
        let mut inner = updates.lock();
        inner.installing = false;
        if let Err(error) = installed {
            log::warn!("W_UPDATE_INSTALL_FAILED {error}");
            inner.pending = None;
            let status = updates.set(
                &mut inner,
                State::Failed {
                    code: "E_UPDATE_INSTALL_FAILED".into(),
                },
            );
            drop(inner);
            publish(app, &status);
            return Err("E_UPDATE_INSTALL_FAILED");
        }
        inner.restart = true;
    } else {
        updates.lock().restart = true;
    }
    log::info!("I_UPDATE_RESTART");
    exit::request_quit(app);
    Ok(())
}

type Install = (Arc<Update>, Vec<u8>);

fn take_install(inner: &mut Inner) -> Result<Option<Install>, &'static str> {
    if !matches!(inner.state, State::Ready { .. }) {
        return Err("E_UPDATE_NOT_READY");
    }
    if inner.installing {
        return Err("E_UPDATE_BUSY");
    }
    let Some(pending) = inner.pending.as_mut() else {
        return Err("E_UPDATE_NOT_READY");
    };
    let job = pending
        .bytes
        .take()
        .map(|bytes| (Arc::clone(&pending.update), bytes));
    inner.installing = job.is_some();
    Ok(job)
}

async fn restart_in_background(app: AppHandle, asked_by: String) -> Result<(), &'static str> {
    tauri::async_runtime::spawn_blocking(move || restart(&app, &asked_by))
        .await
        .unwrap_or(Err("E_UPDATE_INSTALL_FAILED"))
}

/// The quit was called off (a note could not be saved): exiting later does
/// not restart. An update installed already stays installed.
pub fn restart_called_off(app: &AppHandle) {
    if let Some(updates) = app.try_state::<Updates>() {
        updates.lock().restart = false;
    }
}

/// A plain quit installs nothing (installing may ask for a password); the next launch finds the
/// update again.
pub fn on_exit(app: &AppHandle) -> bool {
    app.try_state::<Updates>()
        .is_some_and(|updates| updates.lock().restart)
}

pub fn on_menu(app: &AppHandle) {
    let ready = matches!(app.state::<Updates>().status().state, State::Ready { .. });
    if ready {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let asker =
                crate::main_windows::front_label(&app).unwrap_or_else(|| crate::MAIN_WINDOW.into());
            if let Err(code) = restart_in_background(app, asker).await {
                log::warn!("W_UPDATE_RESTART_FAILED {code}");
            }
        });
    } else {
        let asker =
            crate::main_windows::front_label(app).unwrap_or_else(|| crate::MAIN_WINDOW.into());
        tauri::async_runtime::spawn(check(app.clone(), Some(asker)));
    }
}

/// The scheduler: the revocation list and the update check, each when due. A build without the
/// updater's key still fetches revocations, as long as it gates sync and AI.
pub fn start(app: &AppHandle) {
    let updater = app.state::<Updates>().enabled;
    let licence = app
        .try_state::<Arc<Licence>>()
        .map(|l| Arc::clone(&l))
        .filter(|l| l.gated());
    if cfg!(debug_assertions) || !(updater || licence.is_some()) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("devot-updates".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            let mut last_revocations = None;
            loop {
                if let Some(licence) = &licence
                    && due(last_revocations, SystemTime::now(), CHECK_EVERY)
                    && licence.wants_revocations()
                {
                    last_revocations = Some(SystemTime::now());
                    licence::refresh_revocations(licence);
                }
                if updater && due_now(&app) {
                    tauri::async_runtime::block_on(check(app.clone(), None));
                }
                std::thread::sleep(WAKE_EVERY);
            }
        });
    if spawned.is_err() {
        log::warn!("W_UPDATES_SCHEDULER_FAILED");
    }
}

#[tauri::command]
pub fn update_status(updates: tauri::State<'_, Updates>) -> Status {
    updates.status()
}

#[tauri::command]
pub fn update_check(app: AppHandle, window: Window) {
    tauri::async_runtime::spawn(check(app, Some(window.label().to_owned())));
}

#[tauri::command]
pub fn update_download(app: AppHandle, window: Window) -> Result<(), String> {
    if !crate::main_windows::is_main(window.label()) {
        return Err(String::from("E_UPDATE_WINDOW"));
    }
    tauri::async_runtime::spawn(download(app, Some(window.label().to_owned()), true));
    Ok(())
}

#[tauri::command]
pub fn update_skip(app: AppHandle, window: Window) -> Result<(), String> {
    if !crate::main_windows::is_main(window.label()) {
        return Err(String::from("E_UPDATE_WINDOW"));
    }
    let status = skip(&app.state::<Updates>())?;
    publish(&app, &status);
    Ok(())
}

#[tauri::command]
pub async fn update_restart(app: AppHandle, window: Window) -> Result<(), String> {
    if !crate::main_windows::is_main(window.label()) {
        return Err(String::from("E_UPDATE_WINDOW"));
    }
    restart_in_background(app, window.label().to_owned())
        .await
        .map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_prerelease_build_follows_the_beta_channel() {
        assert_eq!(channel_for("0.9.1-beta1"), Channel::Beta);
        assert_eq!(channel_for("0.9.0-beta.1"), Channel::Beta);
        assert_eq!(channel_for("1.0.0-rc.2+abc"), Channel::Beta);
        assert_eq!(channel_for("1.0.0"), Channel::Stable);
        assert_eq!(channel_for("1.2.3+build-7"), Channel::Stable);
        assert_eq!(channel_for("0.0.0"), Channel::Stable);
    }

    #[test]
    fn each_channel_reads_its_file_in_the_updater_release() {
        assert_eq!(
            feed_url(Channel::Beta),
            "https://github.com/jma49/devot/releases/download/updater/beta.json"
        );
        assert_eq!(
            feed_url(Channel::Stable),
            "https://github.com/jma49/devot/releases/download/updater/stable.json"
        );
        for channel in [Channel::Beta, Channel::Stable] {
            assert!(feed_url(channel).parse::<tauri::Url>().is_ok());
        }
    }

    #[test]
    fn only_a_build_with_a_public_key_has_an_updater() {
        assert!(!configured(None));
        assert!(!configured(Some(&json!({}))));
        assert!(!configured(Some(&json!({ "pubkey": "" }))));
        assert!(!configured(Some(&json!({ "pubkey": "  " }))));
        assert!(!configured(Some(&json!({ "pubkey": 7 }))));
        assert!(configured(Some(
            &json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ=" })
        )));
    }

    #[test]
    fn the_shipped_config_has_no_key_so_local_builds_have_no_updater() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(!configured(config.pointer("/plugins/updater")));
        // The release workflow turns the updater artifacts on with the key.
        assert!(config.pointer("/bundle/createUpdaterArtifacts").is_none());
    }

    #[test]
    fn no_check_starts_while_one_runs_downloads_or_waits_for_a_restart() {
        assert!(may_check(&State::Idle));
        assert!(may_check(&State::UpToDate));
        assert!(may_check(&State::Failed { code: "E_X".into() }));
        assert!(may_check(&State::Available {
            version: "1.0.0".into()
        }));
        assert!(may_check(&notcovered("1.0.0")));
        assert!(!may_check(&State::Checking));
        assert!(!may_check(&State::Downloading {
            version: "1.0.0".into(),
            percent: None
        }));
        assert!(!may_check(&State::Ready {
            version: "1.0.0".into()
        }));
    }

    #[test]
    fn a_request_that_never_answers_fails_and_a_later_check_runs() {
        let limit = Duration::from_millis(20);
        let idle = AtomicU64::new(0);
        let hung = tauri::async_runtime::block_on(unless_stalled(
            std::future::pending::<()>(),
            &idle,
            limit,
        ));
        assert_eq!(hung, None);
        assert!(may_check(&failed(true, "E_UPDATE_CHECK_FAILED")));
        assert!(may_check(&failed(false, "E_UPDATE_CHECK_FAILED")));
    }

    #[test]
    fn a_slow_download_that_keeps_moving_is_not_cut_off() {
        let limit = Duration::from_millis(30);
        let progress = AtomicU64::new(0);
        let slow = async {
            for _ in 0..4 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                progress.fetch_add(1, Ordering::Relaxed);
            }
            "done"
        };
        let out = tauri::async_runtime::block_on(unless_stalled(slow, &progress, limit));
        assert_eq!(out, Some("done"));
    }

    #[test]
    fn only_a_manual_check_reports_nothing_found_or_a_failure() {
        assert_eq!(nothing_found(true), State::UpToDate);
        assert_eq!(nothing_found(false), State::Idle);
        assert_eq!(
            failed(true, "E_UPDATE_CHECK_FAILED"),
            State::Failed {
                code: "E_UPDATE_CHECK_FAILED".into()
            }
        );
        assert_eq!(failed(false, "E_UPDATE_CHECK_FAILED"), State::Idle);
    }

    #[test]
    fn counts_download_progress_in_whole_percent() {
        assert_eq!(percent(0, Some(200)), Some(0));
        assert_eq!(percent(50, Some(200)), Some(25));
        assert_eq!(percent(200, Some(200)), Some(100));
        assert_eq!(percent(300, Some(200)), Some(100));
        assert_eq!(percent(10, None), None);
        assert_eq!(percent(10, Some(0)), None);
    }

    #[test]
    fn checks_daily_by_the_wall_clock() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(10 * 24 * 60 * 60);
        let every = check_every(Channel::Stable);
        assert!(due(None, now, every));
        assert!(!due(Some(now - Duration::from_secs(60)), now, every));
        assert!(!due(Some(now - every + Duration::from_secs(1)), now, every));
        assert!(due(Some(now - every), now, every));
        assert!(due(Some(now + Duration::from_secs(60)), now, every));
    }

    #[test]
    fn a_beta_checks_hourly() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(10 * 24 * 60 * 60);
        let every = check_every(channel_for("0.9.3-beta1"));
        assert_eq!(every, Duration::from_secs(60 * 60));
        assert!(!due(Some(now - Duration::from_secs(59 * 60)), now, every));
        assert!(due(Some(now - Duration::from_secs(60 * 60)), now, every));
        assert!(WAKE_EVERY < every);
    }

    #[test]
    fn the_menu_item_offers_a_restart_once_an_update_is_ready() {
        assert_eq!(menu_item(&State::Idle), ("Check for Updates\u{2026}", true));
        assert_eq!(
            menu_item(&State::UpToDate),
            ("Check for Updates\u{2026}", true)
        );
        assert_eq!(
            menu_item(&State::Checking),
            ("Checking for Updates\u{2026}", false)
        );
        assert_eq!(
            menu_item(&State::Downloading {
                version: "1.0.0".into(),
                percent: Some(5)
            }),
            ("Downloading Update\u{2026}", false)
        );
        assert_eq!(
            menu_item(&State::Ready {
                version: "1.0.0".into()
            }),
            ("Restart to Update", true)
        );
    }

    #[test]
    fn sends_the_status_with_the_names_the_ui_reads() {
        let updates = Updates::new(true, "0.3.0-beta.1".into(), Path::new(""));
        let status = {
            let mut inner = updates.lock();
            inner.asked_by = Some("main".into());
            updates.set(
                &mut inner,
                State::Downloading {
                    version: "0.3.0-beta.2".into(),
                    percent: Some(40),
                },
            )
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "revision": 1,
                "current": "0.3.0-beta.1",
                "enabled": true,
                "askedBy": "main",
                "state": "downloading",
                "version": "0.3.0-beta.2",
                "percent": 40,
            })
        );
        assert_eq!(
            serde_json::to_value(updates.status()).unwrap()["revision"],
            json!(1)
        );
        let idle =
            serde_json::to_value(Updates::new(false, "0.0.0".into(), Path::new("")).status())
                .unwrap();
        assert_eq!(idle["state"], json!("idle"));
        assert_eq!(idle["enabled"], json!(false));
        assert_eq!(idle["askedBy"], json!(null));
    }

    #[test]
    fn restart_refuses_until_an_update_is_ready() {
        let updates = Updates::new(true, "0.3.0-beta.1".into(), Path::new(""));
        let mut inner = updates.lock();
        assert_eq!(take_install(&mut inner).err(), Some("E_UPDATE_NOT_READY"));
        // Ready without a download (cannot happen, but never restarts).
        inner.state = State::Ready {
            version: "0.3.0-beta.2".into(),
        };
        assert_eq!(take_install(&mut inner).err(), Some("E_UPDATE_NOT_READY"));
        inner.installing = true;
        assert_eq!(take_install(&mut inner).err(), Some("E_UPDATE_BUSY"));
        assert!(!inner.restart);
    }

    #[test]
    fn a_bad_signature_is_reported_even_from_the_background() {
        use tauri_plugin_updater::Error;
        assert_eq!(
            download_failure(&Error::SignatureUtf8("x".into())),
            ("E_UPDATE_SIGNATURE_INVALID", true)
        );
        assert_eq!(
            download_failure(&Error::MissingSignedVersion),
            ("E_UPDATE_SIGNATURE_INVALID", true)
        );
        assert_eq!(
            download_failure(&Error::EmptyEndpoints),
            ("E_UPDATE_DOWNLOAD_FAILED", false)
        );
    }

    fn notcovered(version: &str) -> State {
        State::NotCovered {
            version: version.into(),
            updates_until: "2027-10-24".into(),
        }
    }

    fn snapshot(state: LicenceState, gated: bool, until: Option<&str>) -> licence::Snapshot {
        licence::Snapshot {
            gated,
            state,
            code: None,
            id: until.map(|_| "5vEvzHainWD0cA2Ht_ljHg".into()),
            licensee: None,
            updates_until: until.map(str::to_owned),
            plan: None,
        }
    }

    #[test]
    fn dates_a_unix_time_in_utc() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(-1), "1969-12-31");
        assert_eq!(utc_date(1_760_745_600), "2025-10-18");
        assert_eq!(utc_date(1_709_251_199), "2024-02-29");
        assert_eq!(utc_date(1_709_251_200), "2024-03-01");
        assert_eq!(utc_date(951_868_800), "2000-03-01");
        assert_eq!(utc_date(4_107_542_400), "2100-03-01");
        assert_eq!(utc_date(1_798_761_599), "2026-12-31");
        assert_eq!(utc_date(1_798_761_600), "2027-01-01");
    }

    #[test]
    fn only_a_valid_licence_that_ends_before_the_update_is_told() {
        let valid = |until| snapshot(LicenceState::Valid, true, Some(until));
        // The last covered day still covers; the day after does not.
        assert_eq!(
            uncovered_until(&valid("2027-10-24"), Some("2027-10-24")),
            None
        );
        assert_eq!(
            uncovered_until(&valid("2027-10-24"), Some("2026-01-01")),
            None
        );
        assert_eq!(
            uncovered_until(&valid("2027-10-24"), Some("2027-10-25")).as_deref(),
            Some("2027-10-24")
        );
        // An update with no date is covered.
        assert_eq!(uncovered_until(&valid("2027-10-24"), None), None);
        // Everyone else sees what they saw before.
        for state in [
            LicenceState::None,
            LicenceState::UpdatesEnded,
            LicenceState::Revoked,
            LicenceState::Invalid,
        ] {
            let until = (state != LicenceState::None && state != LicenceState::Invalid)
                .then_some("2027-10-24");
            assert_eq!(
                uncovered_until(&snapshot(state, true, until), Some("2030-01-01")),
                None,
                "{state:?}"
            );
        }
        let ungated = snapshot(LicenceState::Valid, false, Some("2027-10-24"));
        assert_eq!(uncovered_until(&ungated, Some("2030-01-01")), None);
    }

    #[test]
    fn download_anyway_is_the_only_way_to_an_update_the_licence_does_not_cover() {
        let available = State::Available {
            version: "1.1.0".into(),
        };
        assert_eq!(downloadable(&available, false), Some("1.1.0"));
        assert_eq!(downloadable(&available, true), Some("1.1.0"));
        assert_eq!(downloadable(&notcovered("1.2.0"), false), None);
        assert_eq!(downloadable(&notcovered("1.2.0"), true), Some("1.2.0"));
        for state in [State::Idle, State::Checking, State::UpToDate] {
            assert_eq!(downloadable(&state, true), None);
        }
    }

    #[test]
    fn a_skipped_version_is_remembered_for_that_version_only() {
        let dir = tempfile::tempdir().unwrap();
        let skipped = Skipped::new(dir.path());
        assert!(!skipped.holds_back("1.2.0"));
        skipped.remember("1.2.0").unwrap();
        assert!(skipped.holds_back("1.2.0"));
        // Kept across launches: a new reader finds it.
        assert!(Skipped::new(dir.path()).holds_back("1.2.0"));
        // A later version is offered, and the skip is gone for good.
        assert!(!skipped.holds_back("1.3.0"));
        assert!(!skipped.holds_back("1.2.0"));
        assert!(!dir.path().join(SKIPPED_FILE).exists());
    }

    #[test]
    fn a_skip_file_that_is_not_a_version_holds_nothing_back() {
        let dir = tempfile::tempdir().unwrap();
        let skipped = Skipped::new(dir.path());
        for text in [
            "",
            "  \n",
            "1.2.0\n../../x",
            "<b>1.2.0</b>",
            &"1".repeat(65),
        ] {
            std::fs::write(dir.path().join(SKIPPED_FILE), text).unwrap();
            assert_eq!(skipped.read(), None, "{text:?}");
            assert!(!skipped.holds_back("1.2.0"), "{text:?}");
        }
        std::fs::write(dir.path().join(SKIPPED_FILE), "1.2.0-beta1\n").unwrap();
        assert!(skipped.holds_back("1.2.0-beta1"));
    }

    #[test]
    fn skipping_drops_the_offer_and_remembers_the_version() {
        let dir = tempfile::tempdir().unwrap();
        let updates = Updates::new(true, "1.0.0".into(), dir.path());
        assert_eq!(skip(&updates).err(), Some("E_UPDATE_NOT_OFFERED"));
        {
            let mut inner = updates.lock();
            updates.set(&mut inner, notcovered("1.2.0"));
        }
        let status = skip(&updates).unwrap();
        assert_eq!(status.state, State::Idle);
        assert_eq!(updates.status().state, State::Idle);
        assert!(updates.skipped.holds_back("1.2.0"));
        // Nothing is offered now, so a second skip has nothing to skip.
        assert_eq!(skip(&updates).err(), Some("E_UPDATE_NOT_OFFERED"));
    }

    #[test]
    fn a_skip_that_cannot_be_kept_leaves_the_offer() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("not-a-folder");
        std::fs::write(&missing, "").unwrap();
        let updates = Updates::new(true, "1.0.0".into(), &missing);
        {
            let mut inner = updates.lock();
            updates.set(&mut inner, notcovered("1.2.0"));
        }
        assert_eq!(skip(&updates).err(), Some("E_UPDATE_SKIP_FAILED"));
        assert_eq!(updates.status().state, notcovered("1.2.0"));
    }

    #[test]
    fn sends_an_update_the_licence_does_not_cover_with_the_names_the_ui_reads() {
        let status = Updates::new(true, "1.0.0".into(), Path::new(""));
        let status = {
            let mut inner = status.lock();
            status.set(&mut inner, notcovered("1.2.0"))
        };
        let sent = serde_json::to_value(&status).unwrap();
        assert_eq!(sent["state"], json!("notCovered"));
        assert_eq!(sent["version"], json!("1.2.0"));
        assert_eq!(sent["updatesUntil"], json!("2027-10-24"));
        assert_eq!(
            menu_item(&status.state),
            ("Check for Updates\u{2026}", true)
        );
    }
}
