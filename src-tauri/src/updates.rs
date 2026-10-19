//! Automatic updates (Tauri's updater, signed releases).
//! Release builds check the update feed 30 seconds after launch and then once a day; Check for
//! Updates checks at once. The feed is a channel file in the repository's fixed `updater` release:
//! a prerelease build (a `-betaN` version) reads `beta.json`, any other build `stable.json`.
//! An update found downloads in the background when the `autoDownloadUpdates` editor setting is on
//! (the default); otherwise the main window offers a Download button. A downloaded update waits:
//! Restart to Update installs it and restarts once the window has saved (the quit handshake, see
//! `exit`). A plain quit installs nothing.
//! Rust holds the status and sends it (`devot://update-status`, with a revision so an older one
//! never overrides a newer one) to every window after each change. A build without the updater's
//! public key (any local or dev build: the release workflow passes the key at build time) has no
//! updater: it never checks on its own, and a manual check says updates are unavailable.

use crate::exit;
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Window, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const STATUS_EVENT: &str = "devot://update-status";
const FEED_BASE: &str = "https://github.com/jma49/devot/releases/download/updater";
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Wall-clock time, so a Mac that slept through the day checks soon after it wakes.
const WAKE_EVERY: Duration = Duration::from_secs(60 * 60);

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

fn percent(done: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    u8::try_from(done.min(total).saturating_mul(100) / total).ok()
}

fn due(last: Option<SystemTime>, now: SystemTime) -> bool {
    last.is_none_or(|at| now.duration_since(at).is_ok_and(|gone| gone >= CHECK_EVERY) || now < at)
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
    inner: Mutex<Inner>,
}

impl Updates {
    pub fn new(enabled: bool, current: String) -> Self {
        Self {
            enabled,
            current,
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
    }
    .await;
    match found {
        Ok(None) => {
            log::info!("I_UPDATE_NONE");
            change(&app, nothing_found(manual));
        }
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("I_UPDATE_FOUND {version}");
            // With auto download on, the update goes straight to downloading
            // (no window offers a Download button for it meanwhile).
            let auto = auto_download(&app);
            let status = {
                let mut inner = updates.lock();
                inner.found = Some(Arc::new(update));
                updates.set(&mut inner, State::Available { version })
            };
            if auto {
                download(app.clone(), asked_by).await;
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

async fn download(app: AppHandle, asked_by: Option<String>) {
    let manual = asked_by.is_some();
    let updates = app.state::<Updates>();
    let (update, status) = {
        let mut inner = updates.lock();
        let (State::Available { version }, Some(update)) = (&inner.state, &inner.found) else {
            return;
        };
        let (version, update) = (version.clone(), Arc::clone(update));
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
    let mut done = 0u64;
    let mut shown = None;
    let bytes = update
        .download(
            |chunk, total| {
                done = done.saturating_add(chunk as u64);
                let now = percent(done, total);
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
        )
        .await;
    // `download` checks the signature as well.
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => {
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
            if let Err(code) = restart_in_background(app, crate::MAIN_WINDOW.into()).await {
                log::warn!("W_UPDATE_RESTART_FAILED {code}");
            }
        });
    } else {
        tauri::async_runtime::spawn(check(app.clone(), Some(crate::MAIN_WINDOW.into())));
    }
}

pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) || !app.state::<Updates>().enabled {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("devot-updates".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                let last = app.state::<Updates>().lock().last_check;
                if due(last, SystemTime::now()) {
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
    if window.label() != crate::MAIN_WINDOW {
        return Err(String::from("E_UPDATE_WINDOW"));
    }
    tauri::async_runtime::spawn(download(app, Some(window.label().to_owned())));
    Ok(())
}

#[tauri::command]
pub async fn update_restart(app: AppHandle, window: Window) -> Result<(), String> {
    if window.label() != crate::MAIN_WINDOW {
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
        assert!(due(None, now));
        assert!(!due(Some(now - Duration::from_secs(60)), now));
        assert!(!due(Some(now - CHECK_EVERY + Duration::from_secs(1)), now));
        assert!(due(Some(now - CHECK_EVERY), now));
        assert!(due(Some(now + Duration::from_secs(60)), now));
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
        let updates = Updates::new(true, "0.3.0-beta.1".into());
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
        let idle = serde_json::to_value(Updates::new(false, "0.0.0".into()).status()).unwrap();
        assert_eq!(idle["state"], json!("idle"));
        assert_eq!(idle["enabled"], json!(false));
        assert_eq!(idle["askedBy"], json!(null));
    }

    #[test]
    fn restart_refuses_until_an_update_is_ready() {
        let updates = Updates::new(true, "0.3.0-beta.1".into());
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
}
