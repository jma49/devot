//! Menu bar mode (Settings > General > Keep in Menu Bar). While it is on, Devot shows an icon in
//! the menu bar (`icons/menu-bar/template.png`, the dove drawn as a template image), closing the
//! main window hides it rather than quitting (`exit`), and quick capture opens from the icon or from
//! its shortcut in any app. The main window is hidden, never closed, so its core keeps every unsaved
//! edit and a quit still runs the save handshake.
//! Quick capture is a small window of its own (`quick-capture.html`) that writes nothing itself: Rust
//! hands its note to the main window's core and waits for the answer (`quick_capture_save`,
//! `quick_capture_done`), so one core writes the library and the main window's lists stay current.

use crate::commands::notes::{MAX_BODY_BYTES, MAX_TITLE_CHARS};
use crate::editor_settings::{EditorSettingsStore, is_notebook_id};
use crate::{MAIN_WINDOW, exit, strings};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use tokio::sync::oneshot;

pub const QUICK_CAPTURE: &str = "quick-capture";
/// Control-Option-Command-N as `shortcutAccelerator` spells it; the command registry keeps it
/// from every command (`QUICK_CAPTURE_KEY` in `src/renderer/src/commands/registry.ts`).
pub const QUICK_CAPTURE_SHORTCUT: &str = "Ctrl+Alt+CmdOrCtrl+N";
pub const CAPTURE_EVENT: &str = "devot://quick-capture";
const TRAY_ID: &str = "devot.menuBar";
const NEW_QUICK_NOTE_ID: &str = "devot.menuBar.quickNote";
const OPEN_ID: &str = "devot.menuBar.open";
const QUIT_ID: &str = "devot.menuBar.quit";
const PAGE: &str = "quick-capture.html";
const WIDTH: f64 = 480.0;
const HEIGHT: f64 = 360.0;
const MIN_WIDTH: f64 = 360.0;
const MIN_HEIGHT: f64 = 240.0;
/// A save waits behind an import's file or a busy database; a capture that times out keeps its
/// text in its window.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
const CODE_MAX: usize = 80;

/// Whether the menu bar icon is shown; set and cleared on the main thread alone (`apply`).
#[derive(Default)]
pub struct MenuBar {
    on: AtomicBool,
}

pub fn keeps_running(app: &AppHandle) -> bool {
    app.try_state::<MenuBar>()
        .is_some_and(|state| state.on.load(Ordering::SeqCst))
}

fn icon() -> Image<'static> {
    tauri::include_image!("icons/menu-bar/template.png")
}

/// Tray icons and global shortcuts are AppKit's, so every change runs on the main thread, one at a
/// time. An icon that cannot be shown leaves the mode off: closing the window then quits as usual.
pub fn apply(app: &AppHandle, on: bool) {
    let handle = app.clone();
    if app
        .run_on_main_thread(move || apply_now(&handle, on))
        .is_err()
    {
        log::warn!("W_MENU_BAR_APPLY_FAILED");
    }
}

fn apply_now(app: &AppHandle, on: bool) {
    let Some(state) = app.try_state::<MenuBar>() else {
        return;
    };
    if state.on.load(Ordering::SeqCst) == on {
        return;
    }
    if !on {
        state.on.store(false, Ordering::SeqCst);
        if app
            .global_shortcut()
            .unregister(QUICK_CAPTURE_SHORTCUT)
            .is_err()
        {
            log::warn!("W_QUICK_CAPTURE_SHORTCUT_UNREGISTER_FAILED");
        }
        if app.remove_tray_by_id(TRAY_ID).is_none() {
            log::warn!("W_MENU_BAR_ICON_REMOVE_FAILED");
        }
        // Nothing else would bring a hidden main window back but the Dock.
        show_main(app);
        return;
    }
    if show_icon(app).is_err() {
        log::warn!("W_MENU_BAR_ICON_FAILED");
        return;
    }
    state.on.store(true, Ordering::SeqCst);
    if app
        .global_shortcut()
        .register(QUICK_CAPTURE_SHORTCUT)
        .is_err()
    {
        log::warn!("W_QUICK_CAPTURE_SHORTCUT_FAILED");
    }
}

fn show_icon(app: &AppHandle) -> tauri::Result<()> {
    let new_note = MenuItemBuilder::with_id(NEW_QUICK_NOTE_ID, strings::MENU_BAR_NEW_QUICK_NOTE)
        .accelerator(QUICK_CAPTURE_SHORTCUT)
        .build(app)?;
    let open = MenuItemBuilder::with_id(OPEN_ID, strings::MENU_BAR_OPEN).build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT_ID, strings::QUIT).build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&new_note)
        .item(&open)
        .separator()
        .item(&quit)
        .build()?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon())
        .icon_as_template(true)
        .tooltip(strings::APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if opens_capture(&event) {
                open_quick_capture(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// A click opens quick capture; the menu is on a right click (or Control-click).
fn opens_capture(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

/// The menu bar icon's menu items; false for any other item. The app's own menu handler hears
/// every menu event, the icon's included (`menu::on_menu_event`).
pub fn on_menu_event(app: &AppHandle, id: &str) -> bool {
    match id {
        NEW_QUICK_NOTE_ID => open_quick_capture(app),
        OPEN_ID => show_main(app),
        QUIT_ID => exit::request_quit(app),
        _ => return false,
    }
    true
}

pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state == ShortcutState::Pressed
        && QUICK_CAPTURE_SHORTCUT.parse::<Shortcut>().ok().as_ref() == Some(shortcut)
    {
        open_quick_capture(app);
    }
}

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(on_shortcut)
        .build()
}

/// Hides the main window in place of closing it; false when it could not be hidden.
pub fn hide_main(window: &Window) -> bool {
    let hidden = window.hide().is_ok();
    if !hidden {
        log::warn!("W_MAIN_WINDOW_HIDE_FAILED");
    }
    hidden
}

pub fn show_main(app: &AppHandle) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if main
        .show()
        .and(crate::deep_link::unminimize(&main))
        .and(main.set_focus())
        .is_err()
    {
        log::warn!("W_MAIN_WINDOW_SHOW_FAILED");
    }
}

/// A click on the Dock icon brings a hidden main window back.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event
        && let Some(main) = app.get_webview_window(MAIN_WINDOW)
        && !main.is_visible().unwrap_or(true)
    {
        show_main(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

pub fn open_quick_capture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK_CAPTURE) {
        if crate::deep_link::unminimize(&window)
            .and(window.show())
            .and(window.set_focus())
            .is_err()
        {
            log::warn!("W_QUICK_CAPTURE_FOCUS_FAILED");
        }
        return;
    }
    let theme = app
        .try_state::<Arc<EditorSettingsStore>>()
        .and_then(|store| store.get().ok())
        .and_then(|stored| stored.settings.appearance.window_theme());
    let mut builder = WebviewWindowBuilder::new(app, QUICK_CAPTURE, WebviewUrl::App(PAGE.into()));
    // The same WebKit store as the main window (`data_folder`): its notebook list and the draft.
    if let Some(store) = crate::data_folder::this_build_web_data_store() {
        builder = builder.data_store_identifier(store);
    }
    let built = builder
        .title(strings::QUICK_CAPTURE_TITLE)
        .theme(theme)
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .minimizable(false)
        .maximizable(false)
        .center()
        .build();
    match built {
        Ok(window) => {
            if window.set_focus().is_err() {
                log::warn!("W_QUICK_CAPTURE_FOCUS_FAILED");
            }
        }
        Err(_) => log::warn!("W_QUICK_CAPTURE_OPEN_FAILED"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    title: String,
    body: String,
    book_id: Option<String>,
}

/// What the main window gets: the capture and the ID to answer it by (`quick_capture_done`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRequest {
    id: u64,
    title: String,
    body: String,
    book_id: Option<String>,
}

/// The limits `note_put` holds a note to; the window clips its title (`clipTitle`) before it sends.
fn check(capture: &Capture) -> Result<(), &'static str> {
    if capture.title.trim().is_empty() && capture.body.trim().is_empty() {
        return Err("E_QUICK_CAPTURE_EMPTY");
    }
    let title_ok =
        capture.title.chars().count() <= MAX_TITLE_CHARS && !capture.title.contains(['\n', '\r']);
    let book_ok = capture.book_id.as_deref().is_none_or(is_notebook_id);
    if !title_ok || capture.body.len() > MAX_BODY_BYTES || !book_ok {
        return Err("E_QUICK_CAPTURE_INVALID");
    }
    Ok(())
}

type Answer = Result<(), String>;

/// Captures handed to the main window and not answered yet.
#[derive(Default)]
pub struct Captures {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
}

impl Captures {
    fn wait(&self) -> Option<(u64, oneshot::Receiver<Answer>)> {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (reply, answer) = oneshot::channel();
        self.waiting.lock().ok()?.insert(id, reply);
        Some((id, answer))
    }

    /// False for an ID that is not waiting (answered already, timed out, or never asked).
    fn answer(&self, id: u64, answer: Answer) -> bool {
        let reply = self.waiting.lock().ok().and_then(|mut w| w.remove(&id));
        reply.is_some_and(|reply| reply.send(answer).is_ok())
    }

    fn forget(&self, id: u64) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(&id);
        }
    }
}

/// The main window's answer as Rust passes it on: a code, never free text.
fn answer_from(error: Option<String>) -> Answer {
    match error {
        None => Ok(()),
        Some(code)
            if (code.starts_with("E_") || code.starts_with("W_"))
                && (3..=CODE_MAX).contains(&code.len())
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') =>
        {
            Err(code)
        }
        Some(_) => Err("E_QUICK_CAPTURE_FAILED".into()),
    }
}

/// Resolves once the main window's core has made the note (and saved it, or kept it pending as
/// any unsaved edit is, see `captureNote`), or rejects with a code; the window keeps its text then.
#[tauri::command]
pub async fn quick_capture_save(
    app: AppHandle,
    window: WebviewWindow,
    captures: State<'_, Captures>,
    capture: Capture,
) -> Result<(), String> {
    if window.label() != QUICK_CAPTURE {
        return Err("E_QUICK_CAPTURE_WINDOW".into());
    }
    check(&capture)?;
    let (id, answer) = captures.wait().ok_or("E_QUICK_CAPTURE_FAILED")?;
    let request = CaptureRequest {
        id,
        title: capture.title,
        body: capture.body,
        book_id: capture.book_id,
    };
    if app.emit_to(MAIN_WINDOW, CAPTURE_EVENT, request).is_err() {
        captures.forget(id);
        return Err("E_QUICK_CAPTURE_NO_WINDOW".into());
    }
    match tokio::time::timeout(ANSWER_TIMEOUT, answer).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(_)) => Err("E_QUICK_CAPTURE_FAILED".into()),
        Err(_) => {
            captures.forget(id);
            log::warn!("W_QUICK_CAPTURE_TIMEOUT {id}");
            Err("E_QUICK_CAPTURE_TIMEOUT".into())
        }
    }
}

#[tauri::command]
pub fn quick_capture_done(
    window: WebviewWindow,
    captures: State<'_, Captures>,
    id: u64,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW {
        return Err("E_QUICK_CAPTURE_WINDOW".into());
    }
    if captures.answer(id, answer_from(error)) {
        Ok(())
    } else {
        Err("E_QUICK_CAPTURE_UNKNOWN".into())
    }
}

/// Closes the quick capture window from its page (Escape, or once a capture is saved).
#[tauri::command]
pub fn quick_capture_close(window: WebviewWindow) -> Result<(), String> {
    if window.label() != QUICK_CAPTURE {
        return Err("E_QUICK_CAPTURE_WINDOW".into());
    }
    window
        .close()
        .map_err(|_| String::from("E_QUICK_CAPTURE_CLOSE_FAILED"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::tray::TrayIconId;
    use tauri::{PhysicalPosition, Rect};

    fn capture(title: &str, body: &str, book_id: Option<&str>) -> Capture {
        Capture {
            title: title.into(),
            body: body.into(),
            book_id: book_id.map(String::from),
        }
    }

    #[test]
    fn takes_a_title_or_a_body_into_a_notebook_or_none() {
        assert_eq!(check(&capture("Groceries", "", None)), Ok(()));
        assert_eq!(check(&capture("", "- milk", Some("0b0c-1d_2"))), Ok(()));
        assert_eq!(
            check(&capture(&"t".repeat(MAX_TITLE_CHARS), "", None)),
            Ok(())
        );
    }

    #[test]
    fn refuses_an_empty_capture() {
        assert_eq!(
            check(&capture("  ", "\n\t", None)),
            Err("E_QUICK_CAPTURE_EMPTY")
        );
    }

    #[test]
    fn refuses_what_storage_would_refuse() {
        for bad in [
            capture(&"t".repeat(MAX_TITLE_CHARS + 1), "", None),
            capture("two\nlines", "", None),
            capture("a\rb", "", None),
            capture("", &"b".repeat(MAX_BODY_BYTES + 1), None),
            capture("t", "", Some("")),
            capture("t", "", Some("../books")),
            capture("t", "", Some(&"a".repeat(65))),
        ] {
            assert_eq!(check(&bad), Err("E_QUICK_CAPTURE_INVALID"), "{bad:?}");
        }
    }

    #[test]
    fn reads_only_the_fields_it_knows() {
        let read = |json: serde_json::Value| serde_json::from_value::<Capture>(json).is_ok();
        assert!(read(
            serde_json::json!({ "title": "t", "body": "b", "bookId": null })
        ));
        assert!(!read(
            serde_json::json!({ "title": "t", "body": "b", "bookId": null, "pinned": true })
        ));
        assert!(!read(serde_json::json!({ "title": "t", "bookId": null })));
    }

    #[test]
    fn hands_the_main_window_the_capture_with_its_id() {
        let request = CaptureRequest {
            id: 3,
            title: "T".into(),
            body: "B".into(),
            book_id: Some("b1".into()),
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({ "id": 3, "title": "T", "body": "B", "bookId": "b1" })
        );
    }

    #[test]
    fn passes_each_answer_to_the_capture_that_waits_for_it_once() {
        let captures = Captures::default();
        let (first, mut first_answer) = captures.wait().unwrap();
        let (second, mut second_answer) = captures.wait().unwrap();
        assert_ne!(first, second);
        assert!(captures.answer(second, Err("E_BOOK_NOT_FOUND".into())));
        assert!(captures.answer(first, Ok(())));
        assert_eq!(first_answer.try_recv().unwrap(), Ok(()));
        assert_eq!(
            second_answer.try_recv().unwrap(),
            Err("E_BOOK_NOT_FOUND".into())
        );
        assert!(!captures.answer(first, Ok(())), "answered once");
        assert!(!captures.answer(99, Ok(())), "never asked");
    }

    #[test]
    fn a_capture_given_up_on_takes_no_late_answer() {
        let captures = Captures::default();
        let (id, _answer) = captures.wait().unwrap();
        captures.forget(id);
        assert!(!captures.answer(id, Ok(())));
    }

    #[test]
    fn passes_on_codes_from_the_main_window_and_nothing_else() {
        assert_eq!(answer_from(None), Ok(()));
        assert_eq!(
            answer_from(Some("E_BOOK_NOT_FOUND".into())),
            Err("E_BOOK_NOT_FOUND".into())
        );
        for text in ["", "E_", "Disk full", "e_lower", "E_A B", &"E_X".repeat(40)] {
            assert_eq!(
                answer_from(Some(text.into())),
                Err("E_QUICK_CAPTURE_FAILED".into()),
                "{text}"
            );
        }
    }

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TrayIconId::new(TRAY_ID),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
            button_state,
        }
    }

    #[test]
    fn a_left_click_on_the_icon_opens_quick_capture_and_a_right_click_does_not() {
        assert!(opens_capture(&click(
            MouseButton::Left,
            MouseButtonState::Up
        )));
        assert!(!opens_capture(&click(
            MouseButton::Left,
            MouseButtonState::Down
        )));
        assert!(!opens_capture(&click(
            MouseButton::Right,
            MouseButtonState::Up
        )));
    }

    #[test]
    fn the_icon_is_a_black_template_image_of_18_points_at_2x() {
        let icon = icon();
        assert_eq!((icon.width(), icon.height()), (36, 36));
        let pixels: Vec<&[u8]> = icon.rgba().chunks(4).collect();
        assert!(pixels.iter().all(|p| p[..3] == [0, 0, 0]));
        assert!(pixels.iter().any(|p| p[3] == 255), "something is drawn");
        assert_eq!(pixels[0][3], 0, "the corner is clear");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_shortcut_is_control_option_command_n() {
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        assert_eq!(
            QUICK_CAPTURE_SHORTCUT.parse::<Shortcut>().unwrap(),
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER),
                Code::KeyN
            )
        );
    }

    #[test]
    fn the_menu_ids_are_its_own() {
        for id in [NEW_QUICK_NOTE_ID, OPEN_ID, QUIT_ID] {
            assert_ne!(id, crate::menu::QUIT_ID);
            assert!(crate::format_menu::command_for(id).is_none());
        }
    }
}
