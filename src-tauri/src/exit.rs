//! Quit handshake: on quit or window close Devot holds it, asks the UI to save pending edits, and
//! exits when the UI reports back (or after a timeout, so a stuck UI can never block quitting).
//! On macOS the standard Quit menu item terminates the app without a `RunEvent::ExitRequested`, so
//! the app menu has its own Quit item (`menu::QUIT_ID`) that starts this handshake. Quitting from
//! the Dock or at logout still bypasses it; autosave bounds what that can lose.
//! When a note could not be saved the UI may call the quit off (`app_exit_cancel`); a later quit
//! asks again. In menu bar mode closing the main window hides it instead (`menu_bar`), so the app
//! and its unsaved edits stay; a quit from the menu bar icon runs this handshake too.
//! Every window with a core of its own (the main window, each note window: `note_relay::may_relay`) saves,
//! and the app exits once all of them have reported back.

use crate::MAIN_WINDOW;
use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Env, Manager, RunEvent, Window, WindowEvent};

pub const FLUSH_EVENT: &str = "devot://flush-before-exit";
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct ExitGate {
    ready: AtomicBool,
    restart: AtomicBool,
    /// The round of the quit held while the UI saves (rounds count from 1), or 0 when none is.
    held: AtomicU64,
    rounds: AtomicU64,
    /// The windows the held quit waits for.
    waiting: Mutex<HashSet<String>>,
}

impl ExitGate {
    /// Holds a quit while the windows in `savers` save: its round, or None when one is held already or the app is exiting.
    fn begin(&self, savers: HashSet<String>) -> Option<u64> {
        if self.ready.load(Ordering::SeqCst) {
            return None;
        }
        let round = self.rounds.fetch_add(1, Ordering::SeqCst) + 1;
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        let begun = self
            .held
            .compare_exchange(0, round, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if !begun {
            return None;
        }
        *waiting = savers;
        Some(round)
    }

    /// `label` has saved (or is gone): whether the held quit waits for no window now.
    fn saved(&self, label: &str) -> bool {
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        waiting.remove(label);
        self.asked() && waiting.is_empty()
    }

    fn asked(&self) -> bool {
        self.held.load(Ordering::SeqCst) != 0
    }

    fn quitting(&self) -> bool {
        self.ready.load(Ordering::SeqCst) || self.asked()
    }

    fn call_off(&self) {
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        waiting.clear();
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
    #[cfg(desktop)]
    if let Some(windows) = app.try_state::<crate::note_window::NoteWindows>() {
        windows.persist();
    }
    let gate = app.state::<ExitGate>();
    // Restart to Update restarts into the update it installed (see `updates`).
    #[cfg(desktop)]
    let restart = crate::updates::on_exit(app);
    #[cfg(mobile)]
    let restart = false;
    gate.restart.store(restart, Ordering::SeqCst);
    gate.ready.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// From a quit request until it is called off, and while the app exits. Long work on the database
/// thread (Rebuild Search Index) stops then, so the saves queued behind it run before the exit.
pub fn quitting(app: &AppHandle) -> bool {
    app.try_state::<ExitGate>()
        .is_some_and(|gate| gate.quitting())
}

/// Once the windows have saved and the app is on its way out.
pub fn exiting(app: &AppHandle) -> bool {
    app.try_state::<ExitGate>()
        .is_some_and(|gate| gate.ready.load(Ordering::SeqCst))
}

/// Tauri's own restart passes on every argument this process was launched with, and a launch
/// from the `devot` command carries the files it handed over (`cli::handoff_args`): they would be
/// imported again after each update (#274).
fn restart_env(mut env: Env) -> Env {
    env.args_os.truncate(1);
    env
}

fn restart(app: &AppHandle) -> ! {
    app.cleanup_before_exit();
    tauri::process::restart(&restart_env(app.env()))
}

pub fn request_quit(app: &AppHandle) {
    let savers: HashSet<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| crate::note_relay::may_relay(label))
        .collect();
    let none = savers.is_empty();
    let Some(round) = app.state::<ExitGate>().begin(savers) else {
        return;
    };
    if none || app.emit(FLUSH_EVENT, ()).is_err() {
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

#[derive(Debug, PartialEq, Eq)]
enum OnClose {
    Close,
    Hide,
    Quit,
}

fn on_close(label: &str, keep_running: bool) -> OnClose {
    match (label == MAIN_WINDOW, keep_running) {
        (false, _) => OnClose::Close,
        (true, true) => OnClose::Hide,
        (true, false) => OnClose::Quit,
    }
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    if app.state::<ExitGate>().ready.load(Ordering::SeqCst) {
        return;
    }
    if matches!(event, WindowEvent::Destroyed) {
        // A window that closed while the quit waited has nothing left to save.
        if app.state::<ExitGate>().saved(window.label()) {
            exit_now(app);
        }
        return;
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    #[cfg(desktop)]
    let keep_running = crate::menu_bar::keeps_running(app);
    #[cfg(mobile)]
    let keep_running = false;
    match on_close(window.label(), keep_running) {
        OnClose::Close => {}
        OnClose::Hide => {
            api.prevent_close();
            #[cfg(desktop)]
            if !crate::menu_bar::hide_main(window) {
                request_quit(app);
            }
        }
        OnClose::Quit => {
            api.prevent_close();
            request_quit(app);
        }
    }
}

pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::ExitRequested { api, code, .. } => {
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
        // The plugins have seen the exit by now, so the single-instance socket is gone and the new
        // process cannot hand its launch back to this one.
        RunEvent::Exit if app.state::<ExitGate>().restart.load(Ordering::SeqCst) => restart(app),
        _ => {}
    }
}

/// A window saved for the quit; the app exits once every window has.
#[tauri::command]
pub fn app_exit_ready(app: AppHandle, window: tauri::WebviewWindow) {
    let gate = app.state::<ExitGate>();
    if !gate.asked() {
        // Late, for a quit called off since.
        log::warn!("W_EXIT_READY_UNASKED");
        return;
    }
    if gate.saved(window.label()) {
        exit_now(&app);
    }
}

#[tauri::command]
pub fn app_exit_cancel(app: AppHandle) {
    log::warn!("W_EXIT_CALLED_OFF");
    app.state::<ExitGate>().call_off();
    #[cfg(desktop)]
    {
        // The notice that says why lives in the main window, hidden in menu bar mode.
        crate::menu_bar::reveal_main(&app);
        crate::updates::restart_called_off(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Db, NoteRecord, Store};
    use std::ffi::OsString;
    use std::sync::{Arc, mpsc};
    use std::task::{Context, Waker};
    use std::time::Instant;
    use tauri::async_runtime::block_on;

    fn savers(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|l| (*l).to_owned()).collect()
    }

    #[test]
    fn exits_once_every_window_that_saves_has_saved_or_closed() {
        let gate = ExitGate::default();
        let note = crate::note_window::label_for("0192a6f0-0000-7000-8000-000000000001");
        gate.begin(savers(&["main", &note])).unwrap();
        assert!(!gate.saved("main"), "the note window has not saved yet");
        assert!(!gate.saved("main"), "saving twice counts once");
        assert!(gate.saved(&note));
        let gate = ExitGate::default();
        gate.begin(savers(&["main", &note])).unwrap();
        assert!(!gate.saved(&note));
        assert!(gate.saved("main"));
    }

    #[test]
    fn a_window_saving_for_a_called_off_quit_exits_nothing() {
        let gate = ExitGate::default();
        gate.begin(savers(&["main", "note-x"])).unwrap();
        gate.call_off();
        assert!(!gate.saved("note-x"));
        assert!(!gate.saved("main"));
        gate.begin(savers(&["main"])).unwrap();
        assert!(gate.saved("main"));
    }

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
        assert_eq!(on_close("main", false), OnClose::Quit);
        assert_eq!(on_close("settings", false), OnClose::Close);
        assert_eq!(on_close("quick-capture", false), OnClose::Close);
    }

    #[test]
    fn in_menu_bar_mode_closing_the_main_window_hides_it_and_quits_nothing() {
        assert_eq!(on_close("main", true), OnClose::Hide);
        assert_eq!(on_close("settings", true), OnClose::Close);
        assert_eq!(on_close("quick-capture", true), OnClose::Close);
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
        let first = gate
            .begin(savers(&["main"]))
            .expect("the first quit asks the UI");
        assert!(gate.asked());
        assert_eq!(gate.begin(savers(&["main"])), None, "one quit at a time");
        assert!(gate.timed_out(first));
        gate.call_off();
        assert!(!gate.asked());
        assert!(
            !gate.timed_out(first),
            "the timeout of a called-off quit does nothing"
        );
        let second = gate
            .begin(savers(&["main"]))
            .expect("a later quit asks again");
        assert!(!gate.timed_out(first));
        assert!(gate.timed_out(second));
    }

    #[test]
    fn nothing_asks_or_times_out_once_the_ui_has_saved() {
        let gate = ExitGate::default();
        let round = gate.begin(savers(&["main"])).unwrap();
        gate.ready.store(true, Ordering::SeqCst);
        assert!(!gate.timed_out(round));
        assert_eq!(gate.begin(savers(&["main"])), None);
    }

    #[test]
    fn a_restart_starts_without_the_files_a_cli_launch_handed_over() {
        let open = crate::cli::Open {
            files: vec!["/Users/me/x.md".into()],
            notebook: Some("Work".into()),
        };
        let binary = "/Applications/Devot.app/Contents/MacOS/devot";
        let mut launched = Env::default();
        launched.args_os = std::iter::once(binary.to_owned())
            .chain(crate::cli::handoff_args(&open))
            .map(OsString::from)
            .collect();
        assert!(
            launched
                .args_os
                .iter()
                .any(|arg| arg == crate::cli::OPEN_FLAG)
        );
        // Tauri restarts with `open -n <bundle> --args` and these from the second on.
        assert_eq!(restart_env(launched).args_os, [binary]);
    }

    #[test]
    fn quitting_lasts_from_a_quit_request_until_it_is_called_off_or_the_app_exits() {
        let gate = ExitGate::default();
        assert!(!gate.quitting());
        gate.begin(savers(&["main"])).unwrap();
        assert!(gate.quitting());
        gate.call_off();
        assert!(!gate.quitting());
        gate.ready.store(true, Ordering::SeqCst);
        assert!(gate.quitting());
    }

    fn note(id: &str) -> NoteRecord {
        NoteRecord {
            id: id.into(),
            title: format!("Relay {id}"),
            title_hlc: "0000000000001-0000-test".into(),
            body_md: format!("# Relay {id}\n"),
            ydoc: vec![1],
            body_version: 0,
            book_id: None,
            book_hlc: String::new(),
            status: "none".into(),
            status_hlc: String::new(),
            pinned: false,
            pinned_hlc: String::new(),
            created_at: 1,
            updated_at: 1,
            dates_hlc: String::new(),
            deleted_at: None,
            deleted_hlc: None,
        }
    }

    #[test]
    fn a_write_queued_behind_a_rebuild_survives_a_quit_request() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let db = Db::spawn(&path).unwrap();
        block_on(
            db.call(|store| {
                (0..200).try_for_each(|i| store.put_note(&note(&format!("n{i}")), &[]))
            }),
        )
        .unwrap();

        let gate = Arc::new(ExitGate::default());
        let (running, rebuild_runs) = mpsc::channel();
        let stop = {
            let gate = Arc::clone(&gate);
            let mut running = Some(running);
            move || {
                // The first ask holds the rebuild inside its statement until the quit request.
                if let Some(running) = running.take() {
                    running.send(()).unwrap();
                    let until = Instant::now() + Duration::from_secs(10);
                    while !gate.quitting() && Instant::now() < until {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
                gate.quitting()
            }
        };
        let rebuild = {
            let db = db.clone();
            std::thread::spawn(move || block_on(crate::commands::search_index::rebuild(&db, stop)))
        };
        rebuild_runs.recv_timeout(Duration::from_secs(10)).unwrap();
        let mut save = std::pin::pin!(db.call(|store| store.put_note(&note("typed"), &[])));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(
            save.as_mut().poll(&mut cx).is_pending(),
            "queued behind the rebuild"
        );

        let asked = Instant::now();
        gate.begin(savers(&["main"])).expect("a quit request");
        block_on(save).unwrap();
        assert!(
            asked.elapsed() < FLUSH_TIMEOUT,
            "saved before the quit times out"
        );
        assert_eq!(
            rebuild.join().unwrap(),
            Err("E_SEARCH_REBUILD_STOPPED".to_owned())
        );
        let reopened = Store::open(&path).unwrap();
        assert!(reopened.get_note("typed", false).unwrap().is_some());
        assert!(reopened.integrity_ok().unwrap());
    }
}
