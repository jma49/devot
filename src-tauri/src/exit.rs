//! Quit handshake: on quit or window close Devot holds it, asks the UI to save pending edits, and
//! exits when the UI reports back (or after a timeout, so a stuck UI can never block quitting).
//! On macOS the standard Quit menu item terminates the app without a `RunEvent::ExitRequested`, so
//! the app menu has its own Quit item (`menu::QUIT_ID`) that starts this handshake. Quitting from
//! the Dock or at logout still bypasses it; autosave bounds what that can lose.
//! When a note could not be saved the UI may call the quit off (`app_exit_cancel`); a later quit
//! asks again. In menu bar mode closing the main window hides it instead (`menu_bar`), so the app
//! and its unsaved edits stay; a quit from the menu bar icon runs this handshake too.
//! Every window with a core of its own (each main window, each note window: `note_relay::may_relay`)
//! saves, and the app exits once all of them have reported back.
//! Each held quit has a round, which its events carry and every answer names, so an answer to a
//! quit called off since counts for nothing in the next one.
//! Closing a main window quits only when it is the last one shown (`on_close`): another main window
//! shown keeps the app running, and then `main`, which hosts the mirror, hides rather than closes
//! while any other main window closes after saving (`main_windows`).

use crate::MAIN_WINDOW;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Env, Manager, RunEvent, Window, WindowEvent};

pub const FLUSH_EVENT: &str = "devot://flush-before-exit";
/// A held quit was called off: windows that already stopped what they had running (the Markdown
/// mirror, an import) start it again.
pub const EXIT_CANCELLED_EVENT: &str = "devot://exit-cancelled";
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

/// What both events carry: the quit's round.
#[derive(Clone, Serialize)]
struct Round {
    round: u64,
}

#[derive(Debug, Default, PartialEq, Eq)]
enum QuitPhase {
    #[default]
    Running,
    /// A quit waits while these windows save.
    Held {
        round: u64,
        waiting: HashSet<String>,
    },
    /// The exit has begun; it begins once.
    Exiting { restart: bool },
    /// The app has exited, so background loops end.
    Stopped,
}

#[derive(Default)]
struct Quit {
    phase: QuitPhase,
    /// How many quits were held: each took the next round, from 1.
    rounds: u64,
}

/// A window's save for the quit of a round.
#[derive(Debug, PartialEq, Eq)]
enum Saved {
    Waiting,
    /// It was the last window the quit waited for: the app exits.
    Done,
    /// That quit is no longer held: called off since, or the app exits already.
    Late,
}

#[derive(Default)]
pub struct ExitGate {
    quit: Mutex<Quit>,
    stopped: Condvar,
}

impl ExitGate {
    fn quit(&self) -> MutexGuard<'_, Quit> {
        crate::locks::lock(&self.quit)
    }

    /// Holds a quit while the windows in `savers` save: its round, or None when one is held already or the app is exiting.
    fn begin(&self, savers: HashSet<String>) -> Option<u64> {
        let mut quit = self.quit();
        if quit.phase != QuitPhase::Running {
            return None;
        }
        quit.rounds += 1;
        let round = quit.rounds;
        quit.phase = QuitPhase::Held {
            round,
            waiting: savers,
        };
        Some(round)
    }

    /// Whether a quit was ever held with `round`, the only rounds a window can answer for.
    fn handed_out(&self, round: u64) -> bool {
        (1..=self.quit().rounds).contains(&round)
    }

    fn saved(&self, label: &str, round: u64) -> Saved {
        match &mut self.quit().phase {
            QuitPhase::Held {
                round: held,
                waiting,
            } if *held == round => {
                waiting.remove(label);
                if waiting.is_empty() {
                    Saved::Done
                } else {
                    Saved::Waiting
                }
            }
            _ => Saved::Late,
        }
    }

    /// `label` closed: the held quit's round when it was the last window that quit waited for.
    fn closed(&self, label: &str) -> Option<u64> {
        let QuitPhase::Held { round, waiting } = &mut self.quit().phase else {
            return None;
        };
        (waiting.remove(label) && waiting.is_empty()).then_some(*round)
    }

    /// Begins the exit for the quit of `round`: false unless that quit is held, so the exit begins
    /// once and never for a quit called off.
    fn exit(&self, round: u64, restart: bool) -> bool {
        let mut quit = self.quit();
        if !matches!(quit.phase, QuitPhase::Held { round: held, .. } if held == round) {
            return false;
        }
        quit.phase = QuitPhase::Exiting { restart };
        true
    }

    /// Calls off the quit of `round`: false unless that quit is held.
    fn call_off(&self, round: u64) -> bool {
        let mut quit = self.quit();
        if !matches!(quit.phase, QuitPhase::Held { round: held, .. } if held == round) {
            return false;
        }
        quit.phase = QuitPhase::Running;
        true
    }

    fn held(&self) -> bool {
        matches!(self.quit().phase, QuitPhase::Held { .. })
    }

    fn exiting(&self) -> bool {
        matches!(
            self.quit().phase,
            QuitPhase::Exiting { .. } | QuitPhase::Stopped
        )
    }

    fn quitting(&self) -> bool {
        self.quit().phase != QuitPhase::Running
    }

    /// False once the app has exited, at once if it already has.
    fn wait(&self, timeout: Duration) -> bool {
        let (quit, _) = self
            .stopped
            .wait_timeout_while(self.quit(), timeout, |quit| {
                quit.phase != QuitPhase::Stopped
            })
            .unwrap_or_else(PoisonError::into_inner);
        quit.phase != QuitPhase::Stopped
    }

    /// The app has exited: whether its own exit asked for a restart.
    fn stop(&self) -> bool {
        let mut quit = self.quit();
        let restart = quit.phase == QuitPhase::Exiting { restart: true };
        quit.phase = QuitPhase::Stopped;
        drop(quit);
        self.stopped.notify_all();
        restart
    }
}

/// A background loop's pause between rounds: false when the app is exiting, so the loop ends.
pub fn wait_unless_exiting(app: &AppHandle, timeout: Duration) -> bool {
    match app.try_state::<ExitGate>() {
        Some(gate) => gate.wait(timeout),
        None => {
            std::thread::sleep(timeout);
            true
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Allow,
    HoldAndAsk,
    Hold,
}

fn decide(exit_code: Option<i32>, exiting: bool, held: bool) -> Decision {
    match (exit_code, exiting, held) {
        (Some(_), _, _) | (None, true, _) => Decision::Allow,
        (None, false, false) => Decision::HoldAndAsk,
        (None, false, true) => Decision::Hold,
    }
}

/// Exits for the quit of `round`: false, doing nothing, unless that quit is still held.
fn exit_now(app: &AppHandle, round: u64) -> bool {
    // Restart to Update restarts into the update it installed (see `updates`).
    #[cfg(desktop)]
    let restart = crate::updates::on_exit(app);
    #[cfg(mobile)]
    let restart = false;
    if !app.state::<ExitGate>().exit(round, restart) {
        return false;
    }
    #[cfg(desktop)]
    if let Some(windows) = app.try_state::<crate::note_window::NoteWindows>() {
        windows.persist();
    }
    #[cfg(desktop)]
    if let Some(api) = app.try_state::<std::sync::Arc<crate::http_api::HttpApi>>() {
        api.stop_bridge();
    }
    app.exit(0);
    true
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
        .is_some_and(|gate| gate.exiting())
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

/// The windows a quit waits for: every one with a core of its own, each main window (hidden ones
/// too, they hold unsaved edits) and each note window.
fn savers_among(labels: impl Iterator<Item = String>) -> HashSet<String> {
    labels
        .filter(|label| crate::note_relay::may_relay(label))
        .collect()
}

pub fn request_quit(app: &AppHandle) {
    let savers = savers_among(app.webview_windows().into_keys());
    let none = savers.is_empty();
    let Some(round) = app.state::<ExitGate>().begin(savers) else {
        return;
    };
    if none || app.emit(FLUSH_EVENT, Round { round }).is_err() {
        exit_now(app, round);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FLUSH_TIMEOUT);
        if exit_now(&app, round) {
            log::warn!("W_EXIT_FLUSH_TIMEOUT {round}");
        }
    });
}

#[derive(Debug, PartialEq, Eq)]
enum OnClose {
    Close,
    /// A main window other than `main`: it saves, then closes.
    CloseAfterSaving,
    Hide,
    Quit,
}

/// What closing `label` does, given whether another main window is shown and whether the app keeps
/// running with no window (menu bar mode).
fn on_close(label: &str, other_main_shown: bool, keep_running: bool) -> OnClose {
    if !crate::main_windows::is_main(label) {
        return OnClose::Close;
    }
    let stays = other_main_shown || keep_running;
    match (label == MAIN_WINDOW, stays) {
        (true, true) => OnClose::Hide,
        (false, true) => OnClose::CloseAfterSaving,
        (_, false) => OnClose::Quit,
    }
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let gate = app.state::<ExitGate>();
    if gate.exiting() {
        return;
    }
    if matches!(event, WindowEvent::Destroyed) {
        // A window that closed while the quit waited has nothing left to save.
        if let Some(round) = gate.closed(window.label()) {
            exit_now(app, round);
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
    let other_main_shown = crate::main_windows::another_is_shown(app, window.label());
    match on_close(window.label(), other_main_shown, keep_running) {
        OnClose::Close => {}
        OnClose::CloseAfterSaving => {
            api.prevent_close();
            #[cfg(desktop)]
            crate::note_window::close_after_saving(window);
        }
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
            match decide(*code, gate.exiting(), gate.held()) {
                Decision::Allow => {}
                Decision::Hold => api.prevent_exit(),
                Decision::HoldAndAsk => {
                    api.prevent_exit();
                    request_quit(app);
                }
            }
        }
        RunEvent::Exit => on_exit(app),
        _ => {}
    }
}

/// Every way out comes here, an Apple Event's quit (logout, another app) among them, which bypasses
/// the handshake: the bridge's socket must not outlive the process. The plugins have seen the exit
/// by now, so the single-instance socket is gone and a restarted process cannot hand its launch
/// back to this one.
fn on_exit(app: &AppHandle) {
    let restarts = app.state::<ExitGate>().stop();
    crate::native::clear_pending_secret_at_exit(app);
    if let Some(db) = app.try_state::<crate::storage::Db>() {
        checkpoint_at_exit(db.inner(), EXIT_CHECKPOINT_LIMIT);
    }
    if let Some(mirror) = app.try_state::<std::sync::Arc<crate::mirror::Mirror>>() {
        mirror.flush(EXIT_MIRROR_LIMIT);
    }
    #[cfg(desktop)]
    if let Some(api) = app.try_state::<std::sync::Arc<crate::http_api::HttpApi>>() {
        api.stop_bridge();
    }
    if restarts {
        restart(app);
    }
}

// A job still ahead of it can take long; the next launch recovers the WAL anyway.
const EXIT_CHECKPOINT_LIMIT: Duration = Duration::from_secs(2);
// A batch still writing the mirror's folder at quit gets this long to write back its manifest.
const EXIT_MIRROR_LIMIT: Duration = Duration::from_secs(2);

fn checkpoint_at_exit(db: &crate::storage::Db, limit: Duration) -> bool {
    // The timer needs the runtime it is made in, and the main thread at exit is not inside one.
    let done = tauri::async_runtime::block_on(async {
        tokio::time::timeout(limit, db.checkpoint()).await
    });
    let checkpointed = matches!(done, Ok(Ok(())));
    if !checkpointed {
        log::warn!("W_EXIT_CHECKPOINT_FAILED");
    }
    checkpointed
}

fn handed_out(app: &AppHandle, round: u64) -> Result<(), String> {
    if app.state::<ExitGate>().handed_out(round) {
        Ok(())
    } else {
        Err("E_EXIT_ROUND".into())
    }
}

/// A window saved for the quit of `round`; the app exits once every window has.
#[tauri::command]
pub fn app_exit_ready(
    app: AppHandle,
    window: tauri::WebviewWindow,
    round: u64,
) -> Result<(), String> {
    handed_out(&app, round)?;
    match app.state::<ExitGate>().saved(window.label(), round) {
        Saved::Waiting => {}
        Saved::Done => {
            exit_now(&app, round);
        }
        Saved::Late => log::warn!("W_EXIT_READY_LATE {round}"),
    }
    Ok(())
}

/// A window could not save for the quit of `round` and calls it off, unless it is over already.
#[tauri::command]
pub fn app_exit_cancel(
    app: AppHandle,
    window: tauri::WebviewWindow,
    round: u64,
) -> Result<(), String> {
    handed_out(&app, round)?;
    if !app.state::<ExitGate>().call_off(round) {
        log::warn!("W_EXIT_CANCEL_LATE {round}");
        return Ok(());
    }
    log::warn!("W_EXIT_CALLED_OFF {round}");
    // A window that had already answered may have stopped its mirror or its import: every window starts its own again.
    if app.emit(EXIT_CANCELLED_EVENT, Round { round }).is_err() {
        log::warn!("W_EXIT_CANCELLED_EMIT_FAILED");
    }
    #[cfg(desktop)]
    {
        // The notice that says why lives in the window that could not save, hidden in menu bar mode.
        crate::menu_bar::reveal_window(&app, window.label());
        crate::updates::restart_called_off(&app);
    }
    #[cfg(mobile)]
    let _ = window;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Db, NoteRecord, Store, Write};
    use std::ffi::OsString;
    use std::sync::{Arc, mpsc};
    use std::task::{Context, Waker};
    use std::time::Instant;
    use tauri::async_runtime::block_on;

    fn savers(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|l| (*l).to_owned()).collect()
    }

    #[test]
    fn a_background_wait_ends_when_the_app_exits() {
        let gate = Arc::new(ExitGate::default());
        assert!(gate.wait(Duration::from_millis(1)));
        let waiter = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || gate.wait(Duration::from_secs(600)))
        };
        std::thread::sleep(Duration::from_millis(20));
        gate.stop();
        assert!(!waiter.join().unwrap());
        assert!(!gate.wait(Duration::from_secs(600)));
    }

    #[test]
    fn exits_once_every_window_that_saves_has_saved_or_closed() {
        let gate = ExitGate::default();
        let note = crate::note_window::label_for("0192a6f0-0000-7000-8000-000000000001");
        let round = gate.begin(savers(&["main", &note])).unwrap();
        assert_eq!(
            gate.saved("main", round),
            Saved::Waiting,
            "the note window has not saved yet"
        );
        assert_eq!(
            gate.saved("main", round),
            Saved::Waiting,
            "saving twice counts once"
        );
        assert_eq!(gate.saved(&note, round), Saved::Done);
        let gate = ExitGate::default();
        let round = gate.begin(savers(&["main", &note])).unwrap();
        assert_eq!(
            gate.closed("settings"),
            None,
            "a window the quit does not wait for"
        );
        assert_eq!(gate.closed(&note), None);
        assert_eq!(gate.closed(&note), None, "closing counts once");
        assert_eq!(gate.saved("main", round), Saved::Done);
        let gate = ExitGate::default();
        let round = gate.begin(savers(&["main", &note])).unwrap();
        assert_eq!(gate.saved("main", round), Saved::Waiting);
        assert_eq!(gate.closed(&note), Some(round));
    }

    #[test]
    fn a_window_saving_for_a_called_off_quit_exits_nothing() {
        let gate = ExitGate::default();
        let round = gate.begin(savers(&["main", "note-x"])).unwrap();
        assert!(gate.call_off(round));
        assert_eq!(gate.saved("note-x", round), Saved::Late);
        assert_eq!(gate.saved("main", round), Saved::Late);
        assert_eq!(gate.closed("main"), None);
        let next = gate.begin(savers(&["main"])).unwrap();
        assert_eq!(gate.saved("main", next), Saved::Done);
    }

    #[test]
    fn a_save_for_a_called_off_quit_does_not_count_for_the_next() {
        let gate = ExitGate::default();
        let first = gate.begin(savers(&["main", "main-2"])).unwrap();
        assert!(gate.call_off(first), "main could not save");
        let second = gate.begin(savers(&["main", "main-2"])).unwrap();
        assert_eq!(
            gate.saved("main-2", first),
            Saved::Late,
            "main-2 answers the first quit late"
        );
        assert_eq!(
            gate.saved("main", second),
            Saved::Waiting,
            "the second quit still waits for main-2"
        );
        assert_eq!(gate.saved("main-2", second), Saved::Done);
    }

    #[test]
    fn the_exit_begins_once_and_nothing_answers_it_after() {
        let gate = ExitGate::default();
        let round = gate.begin(savers(&["main", "main-2"])).unwrap();
        assert!(gate.exit(round, false), "the quit timed out");
        assert!(!gate.exit(round, false), "a second exit does nothing");
        assert_eq!(gate.saved("main", round), Saved::Late);
        assert_eq!(
            gate.saved("main-2", round),
            Saved::Late,
            "a save after the timeout exits nothing"
        );
        assert_eq!(gate.closed("main"), None);
        assert!(!gate.call_off(round), "nor can a window call the exit off");
        assert_eq!(gate.begin(savers(&["main"])), None);
        assert!(gate.exiting());
    }

    #[test]
    fn of_answers_that_race_for_the_last_save_one_exits() {
        let gate = Arc::new(ExitGate::default());
        let round = gate.begin(savers(&["main"])).unwrap();
        let answers: Vec<_> = (0..8)
            .map(|_| {
                let gate = Arc::clone(&gate);
                std::thread::spawn(move || {
                    gate.saved("main", round) == Saved::Done && gate.exit(round, false)
                })
            })
            .collect();
        let exits = answers
            .into_iter()
            .map(|answer| answer.join().unwrap())
            .filter(|exited| *exited)
            .count();
        assert_eq!(exits, 1);
    }

    #[test]
    fn only_the_quit_held_now_can_be_called_off() {
        let gate = ExitGate::default();
        assert!(!gate.call_off(1), "no quit is held");
        let first = gate.begin(savers(&["main"])).unwrap();
        assert!(gate.call_off(first));
        assert!(!gate.call_off(first), "called off once");
        let second = gate.begin(savers(&["main"])).unwrap();
        assert!(
            !gate.call_off(first),
            "a late call-off of the first quit leaves the second held"
        );
        assert!(gate.held());
        assert!(gate.exit(second, false));
        assert!(!gate.call_off(second), "the app exits already");
    }

    #[test]
    fn a_window_answers_only_for_a_round_a_quit_was_held_with() {
        let gate = ExitGate::default();
        assert!(!gate.handed_out(0));
        assert!(!gate.handed_out(1));
        let round = gate.begin(savers(&["main"])).unwrap();
        assert_eq!(round, 1, "rounds count from 1");
        assert!(gate.handed_out(round));
        assert!(!gate.handed_out(0));
        assert!(!gate.handed_out(round + 1));
        assert!(gate.call_off(round));
        assert!(gate.handed_out(round), "a late answer is still one");
    }

    #[test]
    fn the_app_restarts_only_when_its_own_exit_asked_to() {
        let gate = ExitGate::default();
        let round = gate.begin(savers(&["main"])).unwrap();
        assert!(gate.exit(round, true));
        assert!(gate.stop());
        let gate = ExitGate::default();
        let round = gate.begin(savers(&["main"])).unwrap();
        assert!(gate.exit(round, false));
        assert!(!gate.stop());
        let gate = ExitGate::default();
        gate.begin(savers(&["main"])).unwrap();
        assert!(
            !gate.stop(),
            "an exit the handshake never saw (logout) restarts nothing"
        );
        assert!(gate.exiting());
        assert_eq!(gate.begin(savers(&["main"])), None);
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
    fn a_quit_waits_for_every_main_window_and_note_window_and_nothing_else() {
        let note = crate::note_window::label_for("0192a6f0-0000-7000-8000-000000000001");
        let waits: HashSet<String> = savers_among(
            [
                "main",
                "main-2",
                "main-3",
                note.as_str(),
                "settings",
                "quick-capture",
            ]
            .into_iter()
            .map(String::from),
        );
        assert_eq!(waits, savers(&["main", "main-2", "main-3", &note]));
    }

    #[test]
    fn only_closing_the_last_main_window_shown_quits() {
        assert_eq!(on_close("main", false, false), OnClose::Quit);
        assert_eq!(on_close("main-2", false, false), OnClose::Quit);
        assert_eq!(on_close("settings", false, false), OnClose::Close);
        assert_eq!(on_close("quick-capture", false, false), OnClose::Close);
        assert_eq!(on_close("note-x", false, false), OnClose::Close);
    }

    #[test]
    fn in_menu_bar_mode_closing_the_last_main_window_hides_it_and_quits_nothing() {
        assert_eq!(on_close("main", false, true), OnClose::Hide);
        assert_eq!(on_close("settings", false, true), OnClose::Close);
        assert_eq!(on_close("quick-capture", false, true), OnClose::Close);
    }

    #[test]
    fn with_another_main_window_shown_main_hides_and_the_others_close_after_saving() {
        for keep_running in [false, true] {
            assert_eq!(on_close("main", true, keep_running), OnClose::Hide);
            assert_eq!(
                on_close("main-2", true, keep_running),
                OnClose::CloseAfterSaving
            );
            assert_eq!(on_close("settings", true, keep_running), OnClose::Close);
        }
    }

    #[test]
    fn in_menu_bar_mode_a_closed_extra_window_saves_and_goes_but_the_app_stays() {
        assert_eq!(on_close("main-3", false, true), OnClose::CloseAfterSaving);
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
        assert!(gate.held());
        assert_eq!(gate.begin(savers(&["main"])), None, "one quit at a time");
        assert!(gate.call_off(first));
        assert!(!gate.held());
        let second = gate
            .begin(savers(&["main"]))
            .expect("a later quit asks again");
        assert!(
            !gate.exit(first, false),
            "the timeout of a called-off quit does nothing"
        );
        assert!(gate.held());
        assert!(gate.exit(second, false));
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
        let first = gate.begin(savers(&["main"])).unwrap();
        assert!(gate.quitting());
        assert!(!gate.exiting());
        assert!(gate.call_off(first));
        assert!(!gate.quitting());
        let second = gate.begin(savers(&["main"])).unwrap();
        assert!(gate.exit(second, false));
        assert!(gate.quitting());
        gate.stop();
        assert!(gate.quitting());
        assert!(gate.exiting());
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
        block_on(db.write(Write::Body, |store| {
            (0..200).try_for_each(|i| store.put_note(&note(&format!("n{i}")), &[]))
        }))
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
        let mut save =
            std::pin::pin!(db.write(Write::Body, |store| { store.put_note(&note("typed"), &[]) }));
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

    #[test]
    fn the_quit_checkpoint_runs_from_a_thread_outside_any_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devot.sqlite");
        let db = Db::spawn(&path).unwrap();
        let mut big = note("big");
        big.body_md = "word ".repeat(50_000);
        block_on(db.write(Write::Content, move |store| store.put_note(&big, &[]))).unwrap();
        let before = std::fs::metadata(&path).unwrap().len();

        let quit = std::thread::spawn(move || checkpoint_at_exit(&db, EXIT_CHECKPOINT_LIMIT));
        assert!(quit.join().expect("the quit checkpoint panicked"));
        assert!(std::fs::metadata(&path).unwrap().len() >= before + 200_000);
    }

    #[test]
    fn the_quit_checkpoint_gives_up_behind_a_slow_job() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("devot.sqlite")).unwrap();
        let (started, running) = mpsc::channel();
        let slow = {
            let db = db.clone();
            std::thread::spawn(move || {
                block_on(db.call(move |_| {
                    started.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(500));
                    Ok(())
                }))
            })
        };
        running.recv().unwrap();

        let quit = std::thread::spawn(move || checkpoint_at_exit(&db, Duration::from_millis(50)));
        assert!(!quit.join().expect("the quit checkpoint panicked"));
        slow.join().unwrap().unwrap();
    }
}
