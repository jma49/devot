//! Quit handshake: when the user quits or closes the window, Devot holds it,
//! asks the UI to save pending edits, and exits when the UI reports back (or
//! after a timeout, so a stuck UI can never block quitting).
//!
//! On macOS the standard Quit menu item terminates the app without a
//! `RunEvent::ExitRequested`, so the app menu uses its own Quit item
//! (`menu::QUIT_ID`) that starts this handshake. Quitting from the Dock or at
//! logout still bypasses it; autosave bounds what that can lose.
//!
//! When a note could not be saved, the UI may call the quit off instead
//! (`app_exit_cancel`): the app keeps running with the changes in memory, and
//! a later quit asks again.

use crate::MAIN_WINDOW;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Window, WindowEvent};

/// Event the UI listens for; it saves, then calls `app_exit_ready` (or
/// `app_exit_cancel`).
pub const FLUSH_EVENT: &str = "devot://flush-before-exit";
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct ExitGate {
    ready: AtomicBool,
    /// The round of the quit held while the UI saves (rounds count from 1),
    /// or 0 when none is.
    held: AtomicU64,
    /// The last round started.
    rounds: AtomicU64,
}

impl ExitGate {
    /// Holds a quit while the UI saves: its round, or None when one is held
    /// already or the app is exiting.
    fn begin(&self) -> Option<u64> {
        if self.ready.load(Ordering::SeqCst) {
            return None;
        }
        let round = self.rounds.fetch_add(1, Ordering::SeqCst) + 1;
        self.held
            .compare_exchange(0, round, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| round)
    }

    /// Whether a quit is held, waiting for the UI.
    fn asked(&self) -> bool {
        self.held.load(Ordering::SeqCst) != 0
    }

    /// The UI could not save: the quit held is called off.
    fn call_off(&self) {
        self.held.store(0, Ordering::SeqCst);
    }

    /// Whether the timeout of `round` ends the app: that quit is still held
    /// and the UI has not answered.
    fn timed_out(&self, round: u64) -> bool {
        !self.ready.load(Ordering::SeqCst) && self.held.load(Ordering::SeqCst) == round
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Decision {
    /// Our own `exit()` call, or the UI already saved: let it through.
    Allow,
    /// First quit request: hold it and ask the UI to save.
    HoldAndAsk,
    /// Already asked; keep holding until the UI answers or time runs out.
    Hold,
}

fn decide(exit_code: Option<i32>, ready: bool, already_asked: bool) -> Decision {
    match (exit_code, ready, already_asked) {
        (Some(_), _, _) | (None, true, _) => Decision::Allow,
        (None, false, false) => Decision::HoldAndAsk,
        (None, false, true) => Decision::Hold,
    }
}

fn exit_now(app: &AppHandle) {
    app.state::<ExitGate>().ready.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Starts the handshake once; later calls while it runs do nothing.
pub fn request_quit(app: &AppHandle) {
    let Some(round) = app.state::<ExitGate>().begin() else {
        return;
    };
    if app.emit(FLUSH_EVENT, ()).is_err() {
        exit_now(app);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FLUSH_TIMEOUT);
        if app.state::<ExitGate>().timed_out(round) {
            log::warn!("W_EXIT_FLUSH_TIMEOUT");
            exit_now(&app);
        }
    });
}

/// Only the main window's close quits the app; other windows (Settings) just close.
fn close_quits(label: &str) -> bool {
    label == MAIN_WINDOW
}

/// Closing the main window saves first too: hold the close and run the handshake.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        if close_quits(window.label()) && !app.state::<ExitGate>().ready.load(Ordering::SeqCst) {
            api.prevent_close();
            request_quit(app);
        }
    }
}

/// Handles `RunEvent::ExitRequested`; ignores every other event.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    let RunEvent::ExitRequested { api, code, .. } = event else {
        return;
    };
    let gate = app.state::<ExitGate>();
    match decide(*code, gate.ready.load(Ordering::SeqCst), gate.asked()) {
        Decision::Allow => {}
        Decision::Hold => api.prevent_exit(),
        Decision::HoldAndAsk => {
            api.prevent_exit();
            request_quit(app);
        }
    }
}

/// The UI saved everything; quit now.
#[tauri::command]
pub fn app_exit_ready(app: AppHandle) {
    exit_now(&app);
}

/// The UI could not save every note: the quit is called off, and the app
/// keeps running with the changes in memory (the UI tells the user and keeps
/// trying to save them). A later quit asks again.
#[tauri::command]
pub fn app_exit_cancel(app: AppHandle) {
    log::warn!("W_EXIT_CALLED_OFF");
    app.state::<ExitGate>().call_off();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_the_first_user_quit_and_asks_the_ui_to_save() {
        assert_eq!(decide(None, false, false), Decision::HoldAndAsk);
    }

    #[test]
    fn keeps_holding_repeated_quits_until_the_ui_answers() {
        assert_eq!(decide(None, false, true), Decision::Hold);
    }

    #[test]
    fn only_closing_the_main_window_quits() {
        assert!(close_quits("main"));
        assert!(!close_quits("settings"));
    }

    #[test]
    fn lets_our_own_exit_and_post_save_quits_through() {
        assert_eq!(decide(Some(0), false, false), Decision::Allow);
        assert_eq!(decide(Some(1), false, true), Decision::Allow);
        assert_eq!(decide(None, true, true), Decision::Allow);
    }

    #[test]
    fn a_called_off_quit_keeps_the_app_running_and_a_later_quit_asks_again() {
        let gate = ExitGate::default();
        let first = gate.begin().expect("the first quit asks the UI");
        assert!(gate.asked());
        assert_eq!(gate.begin(), None, "one quit at a time");
        assert!(gate.timed_out(first));
        gate.call_off();
        assert!(!gate.asked());
        assert!(
            !gate.timed_out(first),
            "the timeout of a called-off quit does nothing"
        );
        let second = gate.begin().expect("a later quit asks again");
        assert!(!gate.timed_out(first));
        assert!(gate.timed_out(second));
    }

    #[test]
    fn nothing_asks_or_times_out_once_the_ui_has_saved() {
        let gate = ExitGate::default();
        let round = gate.begin().unwrap();
        gate.ready.store(true, Ordering::SeqCst);
        assert!(!gate.timed_out(round));
        assert_eq!(gate.begin(), None);
    }
}
