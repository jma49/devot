//! Quit handshake: on quit or window close Devot holds it, asks the UI to save pending edits, and
//! exits when the UI reports back (or after a timeout, so a stuck UI can never block quitting).
//! On macOS the standard Quit menu item terminates the app without a `RunEvent::ExitRequested`, so
//! the app menu has its own Quit item (`menu::QUIT_ID`) that starts this handshake. Quitting from
//! the Dock or at logout still bypasses it; autosave bounds what that can lose.
//! When a note could not be saved the UI may call the quit off (`app_exit_cancel`); a later quit
//! asks again.

use crate::MAIN_WINDOW;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Window, WindowEvent};

pub const FLUSH_EVENT: &str = "devot://flush-before-exit";
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct ExitGate {
    ready: AtomicBool,
    /// The round of the quit held while the UI saves (rounds count from 1), or 0 when none is.
    held: AtomicU64,
    rounds: AtomicU64,
}

impl ExitGate {
    /// Holds a quit while the UI saves: its round, or None when one is held already or the app is exiting.
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

    fn asked(&self) -> bool {
        self.held.load(Ordering::SeqCst) != 0
    }

    fn call_off(&self) {
        self.held.store(0, Ordering::SeqCst);
    }

    fn timed_out(&self, round: u64) -> bool {
        !self.ready.load(Ordering::SeqCst) && self.held.load(Ordering::SeqCst) == round
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Allow,
    HoldAndAsk,
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
    // Restart to Update restarts into the update it installed (see `updates`).
    if crate::updates::on_exit(app) {
        app.request_restart();
    } else {
        app.exit(0);
    }
}

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

fn close_quits(label: &str) -> bool {
    label == MAIN_WINDOW
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        if close_quits(window.label()) && !app.state::<ExitGate>().ready.load(Ordering::SeqCst) {
            api.prevent_close();
            request_quit(app);
        }
    }
}

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

#[tauri::command]
pub fn app_exit_ready(app: AppHandle) {
    exit_now(&app);
}

#[tauri::command]
pub fn app_exit_cancel(app: AppHandle) {
    log::warn!("W_EXIT_CALLED_OFF");
    app.state::<ExitGate>().call_off();
    crate::updates::restart_called_off(&app);
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
