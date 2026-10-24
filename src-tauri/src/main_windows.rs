//! Several main windows (#9): File > New Window opens another one, with its own library view, note
//! and size. The first is labelled `main` and the others `main-<n>`; each runs a core of its own, and
//! changes to a note reach the other windows through the note relay (`note_relay`). Events that belong
//! to one window of the user's choice (a menu item, a deep link, a quick capture) go to the frontmost
//! main window, the one focused last that is still shown ([`front`]).
//! `main` hosts what runs once: the Markdown mirror and the compaction. It stays alive while the app
//! runs, so closing it while another main window is shown hides it (`exit`). Closing any other main
//! window saves it and closes it. Desktop only builds more windows: a phone has one.

use crate::MAIN_WINDOW;
use crate::note_window::Frame;
#[cfg(desktop)]
use crate::note_window::{frame_of, screens};
use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

const PREFIX: &str = "main-";
/// Each window runs a core, a worker and a web view of its own.
#[cfg(desktop)]
const MAX_WINDOWS: usize = 12;
/// How far a new window sits from the one it follows, so it never covers it exactly.
#[cfg(desktop)]
const CASCADE: f64 = 32.0;

pub fn is_main(label: &str) -> bool {
    label == MAIN_WINDOW || number_of(label).is_some()
}

/// A main window other than `main`: one File > New Window made.
pub fn is_secondary(label: &str) -> bool {
    number_of(label).is_some()
}

fn number_of(label: &str) -> Option<u32> {
    let digits = label.strip_prefix(PREFIX)?;
    if digits.is_empty() || digits.len() > 9 || digits.starts_with('0') {
        return None;
    }
    digits.parse().ok()
}

/// Where a label sorts among the main windows: `main` first, then by number.
fn order_of(label: &str) -> u32 {
    number_of(label).unwrap_or(0)
}

/// The main windows' state: which was focused last, and the numbers of the labels made.
#[derive(Default)]
pub struct MainWindows {
    /// Most recently focused first.
    recent: Mutex<Vec<String>>,
    made: AtomicU32,
}

/// The window to treat as the frontmost: the most recently focused of those shown, else the most
/// recently focused of all (a hidden one in menu bar mode), `main` before the rest among windows never
/// focused.
fn front_of(recent: &[String], windows: &[(String, bool)]) -> Option<String> {
    let rank = |label: &str| recent.iter().position(|r| r == label).unwrap_or(usize::MAX);
    let mut ranked: Vec<&(String, bool)> = windows.iter().collect();
    ranked.sort_by_key(|(label, _)| (rank(label), order_of(label)));
    ranked
        .iter()
        .find(|(_, shown)| *shown)
        .or_else(|| ranked.first())
        .map(|(label, _)| label.clone())
}

impl MainWindows {
    fn focused(&self, label: &str) {
        let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        recent.retain(|kept| kept != label);
        recent.insert(0, label.to_owned());
    }

    fn gone(&self, label: &str) {
        let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        recent.retain(|kept| kept != label);
    }

    fn front(&self, windows: &[(String, bool)]) -> Option<String> {
        let recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        front_of(&recent, windows)
    }

    /// A label no window has, counting on from the last one made (the first made is `main-2`).
    fn next_label(&self, taken: impl Fn(&str) -> bool) -> String {
        loop {
            let n = self.made.fetch_add(1, Ordering::SeqCst) + 2;
            let label = format!("{PREFIX}{n}");
            if !taken(&label) {
                return label;
            }
        }
    }
}

/// A window whose visibility cannot be read is taken as shown. A minimized one counts: AppKit calls
/// it not visible, but the user has it in the Dock.
#[cfg(desktop)]
pub fn is_shown<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false)
}

#[cfg(desktop)]
fn shown_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, bool)> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| is_main(label))
        .map(|(label, window)| {
            let shown = is_shown(&window);
            (label, shown)
        })
        .collect()
}

#[cfg(mobile)]
fn shown_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, bool)> {
    app.webview_windows()
        .into_keys()
        .filter(|label| is_main(label))
        .map(|label| (label, true))
        .collect()
}

/// The label of the frontmost main window; none while there is no main window.
pub fn front_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.try_state::<MainWindows>()?.front(&shown_windows(app))
}

/// The label to answer on, when `label` may be gone: itself if it is a main window still, else the
/// frontmost, else `main`.
pub fn live_or_front<R: Runtime>(app: &AppHandle<R>, label: &str) -> String {
    if is_main(label) && app.get_webview_window(label).is_some() {
        return label.to_owned();
    }
    front_label(app).unwrap_or_else(|| MAIN_WINDOW.to_owned())
}

/// Whether a main window other than `label` is on screen (shown or minimized).
pub fn another_is_shown<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    shown_windows(app)
        .iter()
        .any(|(other, shown)| *shown && other != label)
}

/// Sends `event` to the frontmost main window.
pub fn emit_front<R: Runtime, S: Serialize + Clone>(
    app: &AppHandle<R>,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    let label = front_label(app).ok_or(tauri::Error::WindowNotFound)?;
    app.emit_to(label, event, payload)
}

/// Sends `event` to every main window.
pub fn emit_all<R: Runtime, S: Serialize + Clone>(
    app: &AppHandle<R>,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    let mut sent = Ok(());
    for (label, _) in shown_windows(app) {
        let result = app.emit_to(label, event, payload.clone());
        if sent.is_ok() {
            sent = result;
        }
    }
    sent
}

/// Every main window other than `label`.
pub fn emit_others<R: Runtime, S: Serialize + Clone>(
    app: &AppHandle<R>,
    label: &str,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    let mut sent = Ok(());
    for (other, _) in shown_windows(app) {
        if other == label {
            continue;
        }
        let result = app.emit_to(other, event, payload.clone());
        if sent.is_ok() {
            sent = result;
        }
    }
    sent
}

/// Brings `window` to the front, shown and unminimized.
#[cfg(desktop)]
pub fn bring_forward(window: &WebviewWindow) {
    if window
        .show()
        .and(crate::deep_link::unminimize(window))
        .and(window.set_focus())
        .is_err()
    {
        log::warn!("W_MAIN_WINDOW_FOCUS_FAILED");
    }
}

/// Where a new window opens: the size of `from`, a little down and to the right, unless that would
/// leave its title bar off every screen (then the system centres it).
#[cfg(desktop)]
fn cascaded(from: Frame, screens: &[Frame]) -> Option<Frame> {
    let next = Frame {
        x: from.x + CASCADE,
        y: from.y + CASCADE,
        ..from
    };
    next.on_any(screens).then_some(next)
}

/// A main window as its config describes it, under `label`, opened as things are now: the editor
/// settings' theme and the sidebar material. The first one (`main`) is built here at launch too.
/// Built here rather than from the config alone, to route pop-ups.
pub(crate) fn build(
    app: &AppHandle,
    label: &str,
    frame: Option<Frame>,
) -> Result<WebviewWindow, &'static str> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .ok_or("E_MAIN_WINDOW_CONFIG_MISSING")?
        .clone();
    config.label = label.to_owned();
    let stored = app
        .try_state::<std::sync::Arc<crate::editor_settings::EditorSettingsStore>>()
        .and_then(|store| store.get().ok());
    config.window_effects = app
        .try_state::<crate::sidebar_material::SidebarMaterial>()
        .and_then(|material| material.effects());
    config.theme = stored
        .as_ref()
        .and_then(|stored| stored.settings.appearance.window_theme());
    config.data_store_identifier = crate::data_folder::this_build_web_data_store();
    if let Some(frame) = frame {
        config.x = Some(frame.x);
        config.y = Some(frame.y);
        config.width = frame.width;
        config.height = frame.height;
        config.center = false;
    }
    let mut builder = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|_| "E_MAIN_WINDOW_FAILED")?
        .on_new_window(crate::external::on_new_window);
    if let Some(stored) = &stored {
        builder = builder.initialization_script(crate::editor_settings::initial_script(stored));
    }
    let window = builder.build().map_err(|_| "E_MAIN_WINDOW_FAILED")?;
    crate::native::main_window_built(&window);
    Ok(window)
}

/// File > New Window: another main window beside the frontmost one.
#[cfg(desktop)]
pub fn open(app: &AppHandle) -> Result<(), &'static str> {
    let mains = app
        .try_state::<MainWindows>()
        .ok_or("E_MAIN_WINDOW_STATE_MISSING")?;
    if shown_windows(app).len() >= MAX_WINDOWS {
        return Err("E_MAIN_WINDOW_LIMIT");
    }
    let label = mains.next_label(|label| app.get_webview_window(label).is_some());
    let frame = front_label(app)
        .and_then(|label| app.get_webview_window(&label))
        .map(|front| tauri::Webview::window(front.as_ref()))
        .and_then(|front| frame_of(&front))
        .and_then(|from| cascaded(from, &screens(app)));
    let window = build(app, &label, frame)?;
    bring_forward(&window);
    Ok(())
}

/// A main window comes forward, or goes: the frontmost follows the focus.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let label = window.label();
    if !is_main(label) {
        return;
    }
    let app = window.app_handle();
    let Some(mains) = app.try_state::<MainWindows>() else {
        return;
    };
    match event {
        WindowEvent::Focused(true) => mains.focused(label),
        WindowEvent::Destroyed => {
            mains.gone(label);
            #[cfg(desktop)]
            crate::native::main_window_gone(label);
        }
        _ => {}
    }
}

/// From a main window.
#[cfg(desktop)]
#[tauri::command]
pub fn main_window_new(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if !is_main(window.label()) {
        return Err("E_MAIN_WINDOW_ONLY".into());
    }
    open(&app).map_err(|code| {
        log::warn!("W_MAIN_WINDOW_OPEN_FAILED {code}");
        String::from(code)
    })
}

/// The window saved something other windows list: they load their lists again (`lists_changed`).
pub const LISTS_EVENT: &str = "devot://lists-changed";

/// A main window wrote to the library: the other main windows reload their lists and the notes they
/// hold (a status, a notebook or a tag one window changed, a note it made or trashed).
#[tauri::command]
pub fn main_windows_changed(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if !is_main(window.label()) {
        return Err("E_MAIN_WINDOW_ONLY".into());
    }
    if emit_others(&app, window.label(), LISTS_EVENT, ()).is_err() {
        log::warn!("W_MAIN_WINDOW_LISTS_EMIT_FAILED");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows(list: &[(&str, bool)]) -> Vec<(String, bool)> {
        list.iter().map(|(l, s)| ((*l).to_owned(), *s)).collect()
    }

    fn recent(list: &[&str]) -> Vec<String> {
        list.iter().map(|l| (*l).to_owned()).collect()
    }

    #[test]
    fn main_windows_are_main_and_main_with_a_number() {
        for label in ["main", "main-2", "main-10", "main-123456789"] {
            assert!(is_main(label), "{label}");
        }
        for label in [
            "main-",
            "main-0",
            "main-02",
            "main-1x",
            "main-1234567890",
            "main2",
            "Main",
            "note-0192a6f0-0000-7000-8000-000000000001",
            "settings",
            "quick-capture",
            "",
        ] {
            assert!(!is_main(label), "{label}");
        }
        assert!(!is_secondary("main"));
        assert!(is_secondary("main-2"));
        assert!(!is_secondary("note-main-2"));
    }

    #[test]
    fn the_front_is_the_window_focused_last_of_those_shown() {
        let all = windows(&[("main", true), ("main-2", true), ("main-3", true)]);
        assert_eq!(
            front_of(&recent(&["main-3", "main", "main-2"]), &all),
            Some("main-3".into())
        );
        assert_eq!(
            front_of(&recent(&["main-2", "main-3"]), &all),
            Some("main-2".into())
        );
    }

    #[test]
    fn a_hidden_window_is_the_front_only_while_none_is_shown() {
        let one_hidden = windows(&[("main", false), ("main-2", true)]);
        assert_eq!(
            front_of(&recent(&["main", "main-2"]), &one_hidden),
            Some("main-2".into())
        );
        let all_hidden = windows(&[("main", false), ("main-2", false)]);
        assert_eq!(
            front_of(&recent(&["main-2", "main"]), &all_hidden),
            Some("main-2".into())
        );
    }

    #[test]
    fn windows_never_focused_come_after_the_focused_ones_in_label_order() {
        let all = windows(&[("main-3", true), ("main", true), ("main-2", true)]);
        assert_eq!(front_of(&[], &all), Some("main".into()));
        assert_eq!(front_of(&recent(&["main-2"]), &all), Some("main-2".into()));
        assert_eq!(
            front_of(
                &recent(&["main-9"]),
                &windows(&[("main-3", true), ("main-2", true)])
            ),
            Some("main-2".into()),
            "a window that is gone ranks nothing"
        );
        assert_eq!(front_of(&[], &[]), None);
    }

    #[test]
    fn focus_moves_a_window_to_the_front_and_closing_forgets_it() {
        let mains = MainWindows::default();
        let all = windows(&[("main", true), ("main-2", true)]);
        mains.focused("main");
        mains.focused("main-2");
        assert_eq!(mains.front(&all), Some("main-2".into()));
        mains.focused("main");
        assert_eq!(mains.front(&all), Some("main".into()));
        mains.gone("main");
        assert_eq!(
            mains.front(&windows(&[("main-2", true)])),
            Some("main-2".into())
        );
        assert_eq!(mains.recent.lock().unwrap().as_slice(), ["main-2"]);
    }

    #[test]
    fn new_windows_count_up_from_two_and_skip_labels_in_use() {
        let mains = MainWindows::default();
        assert_eq!(mains.next_label(|_| false), "main-2");
        assert_eq!(mains.next_label(|_| false), "main-3");
        assert_eq!(mains.next_label(|label| label == "main-4"), "main-5");
    }

    #[cfg(desktop)]
    #[test]
    fn a_new_window_follows_the_front_one_down_and_to_the_right() {
        let screen = Frame {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let front = Frame {
            x: 100.0,
            y: 80.0,
            width: 1280.0,
            height: 820.0,
        };
        assert_eq!(
            cascaded(front, &[screen]),
            Some(Frame {
                x: 132.0,
                y: 112.0,
                ..front
            })
        );
    }

    #[cfg(desktop)]
    #[test]
    fn a_new_window_that_would_leave_every_screen_is_centred_instead() {
        let screen = Frame {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let low = Frame {
            x: 100.0,
            y: 1070.0,
            width: 1280.0,
            height: 820.0,
        };
        assert_eq!(cascaded(low, &[screen]), None);
        assert_eq!(cascaded(low, &[]), None);
    }
}
