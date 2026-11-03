//! A Devot an AI tool started (ADR 0012): no window, no Dock icon, no focus, an item in the menu bar
//! with Open Devot and Quit Devot. It is an ordinary Devot in all else, with the single-instance
//! lock, the licence and sync as they always are. Opening Devot in any of the usual ways shows its
//! window and ends all this. One the owner never looked at quits by itself after [`IDLE_LIMIT`]
//! without an MCP call, once its saves are done, through the normal quit handshake.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, Window, WindowEvent};

use crate::{exit, http_api, menu_bar, strings};

const TRAY_ID: &str = "devot.background";
const STATUS_ID: &str = "devot.background.status";
const OPEN_ID: &str = "devot.background.open";
const SETTINGS_ID: &str = "devot.background.settings";
const QUIT_ID: &str = "devot.background.quit";

pub const IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);
/// Records waiting to sync are safe on disk: they delay a quit this much, in case the relay is away.
const SYNC_GRACE: Duration = Duration::from_secs(10 * 60);
const CHECK_EVERY: Duration = Duration::from_secs(30);
const WINDOW_ANSWER: Duration = Duration::from_secs(5);
/// Asks the main window to save and say whether anything could not be saved.
pub const IDLE_CHECK_EVENT: &str = "devot://background-idle-check";

/// Whether this launch was asked for by the bridge.
pub fn requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == crate::cli::BACKGROUND_FLAG)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Background,
    Normal,
}

/// Managed from the start of every launch, so a window built before anything else can ask.
pub struct Background {
    /// No main window has been shown yet in a launch the bridge asked for.
    in_background: AtomicBool,
    /// Any window at all: from then on the owner knows it runs, and it stays until they quit it.
    window_seen: AtomicBool,
    started: Instant,
    idle_answer: Mutex<Option<Sender<bool>>>,
}

impl Background {
    pub fn new(requested: bool) -> Self {
        Self {
            in_background: AtomicBool::new(requested),
            window_seen: AtomicBool::new(false),
            started: Instant::now(),
            idle_answer: Mutex::new(None),
        }
    }

    pub fn active(&self) -> bool {
        self.in_background.load(Ordering::SeqCst)
    }

    fn mode(&self) -> Mode {
        if self.active() {
            Mode::Background
        } else {
            Mode::Normal
        }
    }

    /// True the once it leaves the background.
    fn leave(&self) -> bool {
        self.window_seen.store(true, Ordering::SeqCst);
        self.in_background.swap(false, Ordering::SeqCst)
    }
}

/// Whether a main window should start hidden.
pub fn starts_hidden<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Background>().is_some_and(|b| b.active())
}

pub fn mode(app: &AppHandle) -> Mode {
    app.try_state::<Background>()
        .map_or(Mode::Normal, |b| b.mode())
}

/// In `setup`, before the main window is built: the policy takes the Dock icon and the menus away
/// before anything shows, and a launch stays out of the way of the app in front.
pub fn enter(app: &mut tauri::App, menu_bar_mode: bool) {
    if !starts_hidden(app.handle()) {
        return;
    }
    log::info!("I_BACKGROUND_STARTED");
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    // In menu bar mode its icon already holds Open Devot and Quit Devot.
    if !menu_bar_mode && show_icon(app.handle()).is_err() {
        log::warn!("W_BACKGROUND_ICON_FAILED");
    }
    let handle = app.handle().clone();
    if std::thread::Builder::new()
        .name("background-idle".into())
        .spawn(move || watch_idle(&handle))
        .is_err()
    {
        log::warn!("W_BACKGROUND_WATCH_FAILED");
    }
}

fn show_icon(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItemBuilder::with_id(STATUS_ID, strings::BACKGROUND_MENU_STATUS)
        .enabled(false)
        .build(app)?;
    let open = MenuItemBuilder::with_id(OPEN_ID, strings::MENU_BAR_OPEN).build(app)?;
    let settings =
        MenuItemBuilder::with_id(SETTINGS_ID, strings::BACKGROUND_SETTINGS).build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT_ID, strings::QUIT).build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&status)
        .separator()
        .item(&open)
        .item(&settings)
        .separator()
        .item(&quit)
        .build()?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(menu_bar::icon())
        .icon_as_template(true)
        .tooltip(strings::BACKGROUND_STATUS)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

/// The item's menu; false for any other. Settings keeps it in the background: it can say so there.
pub fn on_menu_event(app: &AppHandle, id: &str) -> bool {
    match id {
        OPEN_ID => menu_bar::show_main(app),
        SETTINGS_ID => {
            if let Some(state) = app.try_state::<Background>() {
                state.window_seen.store(true, Ordering::SeqCst);
            }
            crate::settings::open(app);
        }
        QUIT_ID => exit::request_quit(app),
        _ => return false,
    }
    true
}

/// The owner opened Devot: it becomes the Devot they know, with its Dock icon and menus.
pub fn opened<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<Background>() else {
        return;
    };
    if !state.leave() {
        return;
    }
    log::info!("I_BACKGROUND_OPENED");
    #[cfg(target_os = "macos")]
    if app
        .set_activation_policy(tauri::ActivationPolicy::Regular)
        .is_err()
    {
        log::warn!("W_BACKGROUND_POLICY_FAILED");
    }
    // Tray icons are AppKit's, and any thread may arrive here.
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = handle.remove_tray_by_id(TRAY_ID);
        })
        .is_err()
    {
        log::warn!("W_BACKGROUND_ICON_REMOVE_FAILED");
    }
}

/// A window took the focus: only the owner can have done that in a Devot that has no window. A main
/// window ends the background; any other (Settings, quick capture) only ends the idle quit.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Focused(true)) {
        return;
    }
    let app = window.app_handle();
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    if crate::main_windows::is_main(window.label()) {
        opened(app);
    } else if let Some(state) = app.try_state::<Background>() {
        state.window_seen.store(true, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Idle {
    since_last_call: Duration,
    call_on_its_way: bool,
    window_seen: bool,
    in_background: bool,
    /// Records waiting to be sent, when sync is on.
    sync_waiting: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdleStep {
    Wait,
    /// Nothing more can bring the quit about: the owner is here, or it left the background.
    Stop,
    /// Ask the window whether anything is unsaved, and quit if not.
    Check,
}

fn idle_step(idle: Idle) -> IdleStep {
    if !idle.in_background || idle.window_seen {
        return IdleStep::Stop;
    }
    if idle.call_on_its_way || idle.since_last_call < IDLE_LIMIT {
        return IdleStep::Wait;
    }
    if idle.sync_waiting && idle.since_last_call < IDLE_LIMIT + SYNC_GRACE {
        return IdleStep::Wait;
    }
    IdleStep::Check
}

/// Whether records wait to sync; one it cannot read counts as none, since they are safe on disk.
fn sync_waiting(app: &AppHandle) -> bool {
    let on = app
        .try_state::<Arc<crate::sync::service::SyncService>>()
        .is_some_and(|sync| sync.snapshot().enabled);
    if !on {
        return false;
    }
    let Some(db) = app.try_state::<crate::storage::Db>() else {
        return false;
    };
    tauri::async_runtime::block_on(db.call(|store| store.sync_pending_count()))
        .is_ok_and(|waiting| waiting > 0)
}

fn step_now(app: &AppHandle, state: &Background) -> IdleStep {
    let (last, busy) = app
        .try_state::<Arc<http_api::HttpApi>>()
        .map_or((None, false), |api| api.mcp_activity());
    let since = last.unwrap_or(state.started).elapsed();
    let idle = Idle {
        since_last_call: since,
        call_on_its_way: busy,
        window_seen: state.window_seen.load(Ordering::SeqCst),
        in_background: state.active(),
        sync_waiting: since >= IDLE_LIMIT && sync_waiting(app),
    };
    idle_step(idle)
}

/// Whether the main window saved everything it holds; no answer in time counts as not.
fn all_saved(app: &AppHandle, state: &Background) -> bool {
    let (reply, answer) = channel();
    let Ok(mut slot) = state.idle_answer.lock() else {
        return false;
    };
    *slot = Some(reply);
    drop(slot);
    if app
        .emit_to(crate::MAIN_WINDOW, IDLE_CHECK_EVENT, ())
        .is_err()
    {
        return false;
    }
    answer.recv_timeout(WINDOW_ANSWER).unwrap_or(false)
}

fn watch_idle(app: &AppHandle) {
    let Some(state) = app.try_state::<Background>() else {
        return;
    };
    loop {
        std::thread::sleep(CHECK_EVERY);
        match step_now(app, &state) {
            IdleStep::Stop => return,
            IdleStep::Wait => {}
            IdleStep::Check => {
                if all_saved(app, &state) && step_now(app, &state) == IdleStep::Check {
                    log::info!("I_BACKGROUND_IDLE_QUIT");
                    exit::request_quit(app);
                    return;
                }
                log::info!("I_BACKGROUND_IDLE_HELD");
            }
        }
    }
}

/// The main window's answer to [`IDLE_CHECK_EVENT`].
#[tauri::command]
pub fn background_idle_answer(
    window: WebviewWindow,
    state: tauri::State<'_, Background>,
    saved: bool,
) -> Result<(), String> {
    if !crate::main_windows::is_main(window.label()) {
        return Err("E_BACKGROUND_WINDOW".into());
    }
    if let Ok(mut slot) = state.idle_answer.lock()
        && let Some(reply) = slot.take()
    {
        let _ = reply.send(saved);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    mode: Mode,
}

#[tauri::command]
pub fn background_state(app: AppHandle) -> RunState {
    RunState { mode: mode(&app) }
}

/// Settings' Quit Devot: the same handshake as the menu's, so pending saves are flushed.
#[tauri::command]
pub fn background_quit(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != crate::settings::LABEL {
        return Err("E_BACKGROUND_WINDOW".into());
    }
    log::info!("I_BACKGROUND_QUIT_FROM_SETTINGS");
    exit::request_quit(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LONG_AGO: Duration = Duration::from_secs(3600);

    fn idle() -> Idle {
        Idle {
            since_last_call: LONG_AGO,
            call_on_its_way: false,
            window_seen: false,
            in_background: true,
            sync_waiting: false,
        }
    }

    #[test]
    fn asks_to_quit_after_ten_minutes_without_a_call() {
        assert_eq!(IDLE_LIMIT, Duration::from_secs(600));
        assert_eq!(idle_step(idle()), IdleStep::Check);
        let recent = Idle {
            since_last_call: IDLE_LIMIT - Duration::from_secs(1),
            ..idle()
        };
        assert_eq!(idle_step(recent), IdleStep::Wait);
        let exactly = Idle {
            since_last_call: IDLE_LIMIT,
            ..idle()
        };
        assert_eq!(idle_step(exactly), IdleStep::Check);
    }

    #[test]
    fn a_call_on_its_way_holds_it() {
        let busy = Idle {
            call_on_its_way: true,
            ..idle()
        };
        assert_eq!(idle_step(busy), IdleStep::Wait);
    }

    #[test]
    fn a_window_ever_shown_ends_it_for_good() {
        let seen = Idle {
            window_seen: true,
            ..idle()
        };
        assert_eq!(idle_step(seen), IdleStep::Stop);
        let opened = Idle {
            in_background: false,
            ..idle()
        };
        assert_eq!(idle_step(opened), IdleStep::Stop);
    }

    #[test]
    fn records_waiting_to_sync_delay_it_but_cannot_hold_it_for_ever() {
        let waiting = Idle {
            sync_waiting: true,
            since_last_call: IDLE_LIMIT,
            ..idle()
        };
        assert_eq!(idle_step(waiting), IdleStep::Wait);
        let long = Idle {
            since_last_call: IDLE_LIMIT + SYNC_GRACE,
            ..waiting
        };
        assert_eq!(idle_step(long), IdleStep::Check);
    }

    #[test]
    fn leaving_the_background_happens_once_and_counts_as_a_window_seen() {
        let state = Background::new(true);
        assert_eq!(state.mode(), Mode::Background);
        assert!(state.leave());
        assert!(!state.leave());
        assert_eq!(state.mode(), Mode::Normal);
        assert!(state.window_seen.load(Ordering::SeqCst));
    }

    #[test]
    fn a_normal_launch_is_never_in_the_background() {
        let state = Background::new(false);
        assert!(!state.active());
        assert_eq!(state.mode(), Mode::Normal);
    }

    #[test]
    fn the_menu_ids_are_its_own() {
        for id in [STATUS_ID, OPEN_ID, SETTINGS_ID, QUIT_ID] {
            assert_ne!(id, crate::menu::QUIT_ID);
            assert!(crate::format_menu::command_for(id).is_none());
        }
    }

    #[test]
    fn the_wording_says_what_is_running_and_for_whom() {
        assert!(strings::BACKGROUND_STATUS.contains("AI tools"));
        assert!(strings::BACKGROUND_MENU_STATUS.contains("10 minutes"));
        assert_eq!(strings::QUIT, "Quit Devot");
    }
}
