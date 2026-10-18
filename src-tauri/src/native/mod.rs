//! Platform-native capabilities. `native::macos` is the only place in the
//! crate allowed to use `unsafe`.

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
#[doc(hidden)]
pub mod macos;

/// Event the UI listens for to restyle when the system accent changes.
pub const ACCENT_EVENT: &str = "devot://accent-changed";

/// Applies native window settings after the main window is created, gives
/// the Format menu's keys priority over the web view, and forwards system
/// accent changes to the UI.
pub fn configure_main_window(app: &tauri::App) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Emitter;
        macos::unlock_high_refresh_rate(app);
        macos::give_format_menu_keys_priority(app, crate::strings::MENU_FORMAT);
        let handle = app.handle().clone();
        macos::observe_accent_changes(move || {
            if handle.emit(ACCENT_EVENT, macos::system_accent()).is_err() {
                log::warn!("W_NATIVE_ACCENT_EMIT_FAILED");
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Shows a critical alert with `title` and `message` and waits until it is
/// dismissed: a launch that cannot open the notes, before any window
/// (`startup::fail`). Main thread only; elsewhere, and off macOS, it shows
/// nothing (the failure is logged all the same).
pub fn show_alert(title: &str, message: &str) {
    #[cfg(target_os = "macos")]
    if !macos::show_critical_alert(title, message) {
        log::warn!("W_NATIVE_ALERT_OFF_MAIN_THREAD");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (title, message);
}

/// What the macOS key monitor reads off a key-down event.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct KeyDown {
    pub command: bool,
    pub control: bool,
    /// The event belongs to the main window.
    pub in_main_window: bool,
    /// The main window is the key window (no sheet, panel or Settings on top).
    pub main_window_is_key: bool,
    /// The main window's first responder has marked text: an input method
    /// is composing there (in the editor or a field of the web view).
    pub marked_text: bool,
}

/// Whether the key monitor offers a key-down to the Format menu before the
/// web view sees it: only a key with Command or Control (every format key
/// has one, so typed text never goes there) in the main window while it is
/// the key window, and not while an input method composes there: it gets
/// the key first (it may use Control keys), and a format would end its
/// composition. The menu takes the key only when one of its items has it,
/// which is only while the editor has the keyboard (`format_menu`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn offers_to_format_menu(key: KeyDown) -> bool {
    (key.command || key.control) && key.in_main_window && key.main_window_is_key && !key.marked_text
}

/// The system accent colour. When the user picked Multicolor, the UI keeps
/// Devot's own accent (`light` and `dark` are absent).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccentInfo {
    pub multicolor: bool,
    pub light: Option<String>,
    pub dark: Option<String>,
}

impl AccentInfo {
    pub fn multicolor() -> Self {
        Self {
            multicolor: true,
            light: None,
            dark: None,
        }
    }

    pub fn system(light: String, dark: String) -> Self {
        Self {
            multicolor: false,
            light: Some(light),
            dark: Some(dark),
        }
    }
}

/// `#rrggbb` from colour components in 0..=1, clamped.
pub fn hex_from_unit_rgb(r: f64, g: f64, b: f64) -> String {
    let byte = |c: f64| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
}

/// The current system accent. AppKit is read on the main thread.
#[tauri::command]
pub async fn system_accent(app: tauri::AppHandle) -> Result<AccentInfo, String> {
    #[cfg(target_os = "macos")]
    {
        let (reply, answer) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = reply.send(macos::system_accent());
        })
        .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        answer
            .await
            .map_err(|_| String::from("E_NATIVE_ACCENT_UNAVAILABLE"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(AccentInfo::multicolor())
    }
}

const MAX_SYMBOL_NAME_LEN: usize = 64;
const POINT_SIZE_RANGE: std::ops::RangeInclusive<f64> = 1.0..=128.0;

/// The stroke weights a symbol may be drawn at, as AppKit's font weights
/// (`macos::symbol_weight`); a request without one is `regular`.
const SYMBOL_WEIGHTS: [&str; 9] = [
    "ultralight",
    "thin",
    "light",
    "regular",
    "medium",
    "semibold",
    "bold",
    "heavy",
    "black",
];

/// Checks a symbol request before it reaches native code.
fn validate_symbol_request(name: &str, point_size: f64, weight: &str) -> Result<(), &'static str> {
    let name_ok = !name.is_empty()
        && name.len() <= MAX_SYMBOL_NAME_LEN
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.');
    if !name_ok {
        return Err("E_SYMBOL_NAME_INVALID");
    }
    if !POINT_SIZE_RANGE.contains(&point_size) {
        return Err("E_SYMBOL_SIZE_INVALID");
    }
    if !SYMBOL_WEIGHTS.contains(&weight) {
        return Err("E_SYMBOL_WEIGHT_INVALID");
    }
    Ok(())
}

/// Held while a symbol renders. AppKit lets an image be used on any thread,
/// but by one thread at a time, and the symbol images it hands out may be
/// shared.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static SYMBOL_RENDER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Runs `render` on a blocking thread, one render at a time, never on the
/// thread that asks. Tauri runs a synchronous command on the main thread,
/// which at launch also routes the page's first IPC: rendering the first
/// paint's 22 icons there held it for about 115 ms (80 of them on the
/// first, when AppKit loads the symbols). None when the render panicked.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
async fn render_one_at_a_time<T: Send + 'static>(
    render: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = SYMBOL_RENDER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        render()
    })
    .await
    .ok()
}

/// Renders an SF Symbol as a base64 PNG at twice `point_size` pixels, off
/// the main thread (`render_one_at_a_time`), at `weight` (default regular).
#[tauri::command]
pub async fn symbol_png(
    name: String,
    point_size: f64,
    weight: Option<String>,
) -> Result<String, String> {
    let weight = weight.unwrap_or_else(|| String::from("regular"));
    validate_symbol_request(&name, point_size, &weight).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
        use base64::Engine as _;
        render_one_at_a_time(move || {
            macos::symbol_png(&name, point_size, &weight)
                .map(|png| base64::engine::general_purpose::STANDARD.encode(png))
        })
        .await
        .flatten()
        .ok_or_else(|| String::from("E_SYMBOL_UNAVAILABLE"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(String::from("E_SYMBOL_UNSUPPORTED"))
    }
}

/// Longest text the clipboard command accepts: as much as a note may hold,
/// as a paste takes, so Copy Note Links on any selection a library allows
/// (and any code block) fits.
const MAX_CLIPBOARD_TEXT_LEN: usize = crate::commands::notes::MAX_BODY_BYTES;

/// Checks text before it reaches the pasteboard.
fn validate_clipboard_text(text: &str) -> Result<(), &'static str> {
    if text.is_empty() {
        return Err("E_CLIPBOARD_TEXT_EMPTY");
    }
    if text.len() > MAX_CLIPBOARD_TEXT_LEN {
        return Err("E_CLIPBOARD_TEXT_TOO_LONG");
    }
    if text.contains('\0') {
        return Err("E_CLIPBOARD_TEXT_INVALID");
    }
    Ok(())
}

/// Puts plain text on the general pasteboard. The page cannot do this itself
/// from a native menu item: WebKit only lets a page write the clipboard
/// during a user gesture in the page.
#[tauri::command]
pub async fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    validate_clipboard_text(&text).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
        let (reply, answer) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = reply.send(macos::write_clipboard_text(&text));
        })
        .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        match answer.await {
            Ok(true) => Ok(()),
            _ => Err(String::from("E_CLIPBOARD_WRITE_FAILED")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(String::from("E_CLIPBOARD_UNSUPPORTED"))
    }
}

/// Longest text a plain paste takes: as much as a note body may hold.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAX_CLIPBOARD_READ_BYTES: usize = crate::commands::notes::MAX_BODY_BYTES;

/// What the page gets from a pasteboard read: its text (empty when it holds
/// none), or a code when the text is longer than a note may be.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clipboard_read_result(text: Option<String>) -> Result<String, &'static str> {
    let text = text.unwrap_or_default();
    if text.len() > MAX_CLIPBOARD_READ_BYTES {
        return Err("E_CLIPBOARD_TEXT_TOO_LONG");
    }
    Ok(text)
}

/// Reads the general pasteboard's plain text, for Paste as Plain Text. The
/// page could ask WebKit instead only during a key press in the page, and
/// WebKit would show its own Paste button first; the command palette runs
/// the command after its own keys, too. Takes no arguments.
#[tauri::command]
pub async fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let (reply, answer) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = reply.send(macos::read_clipboard_text());
        })
        .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        match answer.await {
            Ok(Ok(text)) => clipboard_read_result(text).map_err(String::from),
            _ => Err(String::from("E_CLIPBOARD_READ_FAILED")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(String::from("E_CLIPBOARD_UNSUPPORTED"))
    }
}

/// Longest text Look Up takes, in characters: a word or a phrase.
const MAX_LOOK_UP_CHARS: usize = 1_000;

/// Longest text a speech fallback takes, in characters.
const MAX_SPEECH_CHARS: usize = 100_000;

/// Checks a Look Up request: some text (not only white space) of a sane
/// length and a point with finite, non-negative coordinates. Whether the
/// point lies inside the view is checked against the view itself.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn validate_look_up(text: &str, x: f64, y: f64) -> Result<(), &'static str> {
    if text.trim().is_empty() {
        return Err("E_LOOK_UP_TEXT_EMPTY");
    }
    if text.chars().count() > MAX_LOOK_UP_CHARS {
        return Err("E_LOOK_UP_TEXT_TOO_LONG");
    }
    if text.contains('\0') {
        return Err("E_LOOK_UP_TEXT_INVALID");
    }
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("E_LOOK_UP_POINT_INVALID");
    }
    Ok(())
}

/// What a speech request asks for.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum SpeechRequest {
    Start(Option<String>),
    Stop,
}

/// Checks a speech request: `start` (with the selected text, which a
/// speech synthesizer says when the web view cannot) or `stop`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn validate_speech(action: &str, text: Option<String>) -> Result<SpeechRequest, &'static str> {
    match action {
        "stop" => Ok(SpeechRequest::Stop),
        "start" => {
            let text = text.filter(|text| !text.trim().is_empty());
            if let Some(text) = &text {
                if text.chars().count() > MAX_SPEECH_CHARS {
                    return Err("E_SPEECH_TEXT_TOO_LONG");
                }
                if text.contains('\0') {
                    return Err("E_SPEECH_TEXT_INVALID");
                }
            }
            Ok(SpeechRequest::Start(text))
        }
        _ => Err("E_SPEECH_ACTION_INVALID"),
    }
}

/// Shows the system dictionary for `text` at a point in the window (CSS
/// pixels from the top-left corner of the page).
#[tauri::command]
pub async fn text_look_up(
    app: tauri::AppHandle,
    text: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    validate_look_up(&text, x, y).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window(crate::MAIN_WINDOW)
            .ok_or_else(|| String::from("E_NATIVE_MAIN_WINDOW_MISSING"))?;
        let (reply, answer) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let _ = reply.send(macos::look_up(&webview, &text, x, y));
            })
            .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        match answer.await {
            Ok(result) => result.map_err(String::from),
            Err(_) => Err(String::from("E_LOOK_UP_FAILED")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(String::from("E_LOOK_UP_UNSUPPORTED"))
    }
}

/// Starts (`start`, with the selected text) or stops (`stop`) speaking.
#[tauri::command]
pub async fn text_speak(
    app: tauri::AppHandle,
    action: String,
    text: Option<String>,
) -> Result<(), String> {
    let request = validate_speech(&action, text).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window(crate::MAIN_WINDOW)
            .ok_or_else(|| String::from("E_NATIVE_MAIN_WINDOW_MISSING"))?;
        let (reply, answer) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let result = match &request {
                    SpeechRequest::Stop => macos::speak(&webview, false, None),
                    SpeechRequest::Start(text) => macos::speak(&webview, true, text.as_deref()),
                };
                let _ = reply.send(result);
            })
            .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        match answer.await {
            Ok(result) => result.map_err(String::from),
            Err(_) => Err(String::from("E_SPEECH_FAILED")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Err(String::from("E_SPEECH_UNSUPPORTED"))
    }
}

// ---- The editor's menu -------------------------------------------------------

/// The most items the editor's menu takes from the page (submenu items too).
const MAX_EDITOR_MENU_ITEMS: usize = 64;
/// The longest item text or ID the editor's menu takes, in characters.
const MAX_EDITOR_MENU_TEXT: usize = 200;
/// The longest word the editor's menu offers spelling guesses for.
const MAX_SPELLING_WORD: usize = 100;
/// The farthest point in the window the editor's menu opens at, in CSS pixels.
const MAX_EDITOR_MENU_POINT: f64 = 100_000.0;
/// What every item ID the editor's menu takes starts with.
const EDITOR_MENU_ID_PREFIX: &str = "devot.editor.";

/// An item of the editor's menu as the page lays it out (`editorMenu.ts`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EditorMenuEntry {
    /// An item the page handles: picking it returns its ID.
    Item {
        id: String,
        text: String,
        /// Shown beside the item (`CmdOrCtrl+Z`); the page handles the key.
        #[serde(default)]
        accelerator: Option<String>,
        #[serde(default)]
        checked: Option<bool>,
    },
    Separator,
    /// One of the system's own items, which act on the web view.
    Predefined {
        item: SystemItem,
    },
    /// A submenu of items (no deeper submenus).
    Submenu {
        id: String,
        text: String,
        items: Vec<EditorMenuEntry>,
    },
}

/// The system's own items the page may put in the editor's menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum SystemItem {
    Cut,
    Copy,
    Paste,
    SelectAll,
}

/// What was picked in the editor's menu, when the page has to act on it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EditorMenuPick {
    /// One of the page's items.
    Item { id: String },
    /// A spelling guess: the page puts it in place of the word.
    Guess { text: String },
}

fn valid_menu_text(text: &str) -> bool {
    !text.trim().is_empty()
        && text.chars().count() <= MAX_EDITOR_MENU_TEXT
        && !text.chars().any(char::is_control)
}

fn valid_menu_id(id: &str) -> bool {
    id.len() <= MAX_EDITOR_MENU_TEXT
        && id.strip_prefix(EDITOR_MENU_ID_PREFIX).is_some_and(|rest| {
            !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
        })
}

/// Checks the editor's menu the page sends: at most `MAX_EDITOR_MENU_ITEMS`
/// items, each with an ID of the editor's and a sane text, submenus one
/// level deep; a point with finite, non-negative coordinates; and a word
/// (to offer spelling guesses for) that is one word.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn validate_editor_menu(
    items: &[EditorMenuEntry],
    x: f64,
    y: f64,
    word: Option<&str>,
) -> Result<(), &'static str> {
    fn check(
        items: &[EditorMenuEntry],
        nested: bool,
        count: &mut usize,
    ) -> Result<(), &'static str> {
        for item in items {
            *count += 1;
            if *count > MAX_EDITOR_MENU_ITEMS {
                return Err("E_EDITOR_MENU_TOO_LONG");
            }
            match item {
                EditorMenuEntry::Item {
                    id,
                    text,
                    accelerator,
                    ..
                } => {
                    if !valid_menu_id(id) || !valid_menu_text(text) {
                        return Err("E_EDITOR_MENU_ITEM_INVALID");
                    }
                    if accelerator.as_deref().is_some_and(|a| !valid_menu_text(a)) {
                        return Err("E_EDITOR_MENU_ITEM_INVALID");
                    }
                }
                EditorMenuEntry::Submenu { id, text, items } => {
                    if nested || !valid_menu_id(id) || !valid_menu_text(text) {
                        return Err("E_EDITOR_MENU_ITEM_INVALID");
                    }
                    check(items, true, count)?;
                }
                EditorMenuEntry::Separator | EditorMenuEntry::Predefined { .. } => {}
            }
        }
        Ok(())
    }
    check(items, false, &mut 0)?;
    if !(0.0..=MAX_EDITOR_MENU_POINT).contains(&x) || !(0.0..=MAX_EDITOR_MENU_POINT).contains(&y) {
        return Err("E_EDITOR_MENU_POINT_INVALID");
    }
    if let Some(word) = word
        && (word.is_empty()
            || word.chars().count() > MAX_SPELLING_WORD
            || word.chars().any(|c| c.is_whitespace() || c.is_control()))
    {
        return Err("E_EDITOR_MENU_WORD_INVALID");
    }
    Ok(())
}

/// A menu item's key as AppKit shows it: the key equivalent and its modifiers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct KeyEquivalent {
    pub key: String,
    pub command: bool,
    pub shift: bool,
    pub option: bool,
    pub control: bool,
}

/// Reads an accelerator as the page writes it (`Ctrl+Shift+Alt+CmdOrCtrl+K`,
/// `shortcutAccelerator`); `None` for a key AppKit has no equivalent for.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn key_equivalent(accelerator: &str) -> Option<KeyEquivalent> {
    let mut parts: Vec<&str> = accelerator.split('+').collect();
    // `CmdOrCtrl++` names the plus key.
    if accelerator.ends_with("++") {
        parts.truncate(parts.len().saturating_sub(2));
        parts.push("+");
    }
    let (name, modifiers) = parts.split_last()?;
    let mut out = KeyEquivalent::default();
    for modifier in modifiers {
        match *modifier {
            "CmdOrCtrl" | "Cmd" | "Command" | "Super" => out.command = true,
            "Ctrl" | "Control" => out.control = true,
            "Shift" => out.shift = true,
            "Alt" | "Option" => out.option = true,
            _ => return None,
        }
    }
    let function = |n: u32| char::from_u32(0xF704 + n - 1);
    let key = match *name {
        "Enter" => '\r',
        "Tab" => '\t',
        "Space" => ' ',
        "Backspace" => '\u{8}',
        "Delete" => '\u{7f}',
        "Escape" => '\u{1b}',
        "ArrowUp" | "Up" => '\u{F700}',
        "ArrowDown" | "Down" => '\u{F701}',
        "ArrowLeft" | "Left" => '\u{F702}',
        "ArrowRight" | "Right" => '\u{F703}',
        "Home" => '\u{F729}',
        "End" => '\u{F72B}',
        "PageUp" => '\u{F72C}',
        "PageDown" => '\u{F72D}',
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => c.to_ascii_lowercase(),
                _ => {
                    let n: u32 = other.strip_prefix('F')?.parse().ok()?;
                    if !(1..=20).contains(&n) {
                        return None;
                    }
                    function(n)?
                }
            }
        }
    };
    out.key = key.to_string();
    Some(out)
}

/// Shows the editor's menu at a point in the window (CSS pixels from the
/// top-left corner of the page) and waits until it closes: the page's
/// items, the system's spelling guesses for `word` when it is misspelled,
/// and the system's Spelling and Grammar, Writing Tools and Services.
/// Returns what the page has to act on, if anything was picked.
#[tauri::command]
pub async fn editor_menu_popup(
    app: tauri::AppHandle,
    items: Vec<EditorMenuEntry>,
    x: f64,
    y: f64,
    word: Option<String>,
) -> Result<Option<EditorMenuPick>, String> {
    validate_editor_menu(&items, x, y, word.as_deref()).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window(crate::MAIN_WINDOW)
            .ok_or_else(|| String::from("E_NATIVE_MAIN_WINDOW_MISSING"))?;
        let (reply, answer) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let _ = reply.send(macos::editor_menu(&webview, &items, x, y, word.as_deref()));
            })
            .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        match answer.await {
            Ok(result) => result.map_err(String::from),
            Err(_) => Err(String::from("E_EDITOR_MENU_FAILED")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, items, word);
        Err(String::from("E_EDITOR_MENU_UNSUPPORTED"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, text: &str) -> EditorMenuEntry {
        EditorMenuEntry::Item {
            id: id.into(),
            text: text.into(),
            accelerator: None,
            checked: None,
        }
    }

    #[test]
    fn takes_the_editor_menu_the_page_lays_out() {
        let speech = EditorMenuEntry::Submenu {
            id: "devot.editor.speech".into(),
            text: "Speech".into(),
            items: vec![item("devot.editor.startSpeaking", "Start Speaking")],
        };
        let items = vec![
            item("devot.editor.undo", "Undo"),
            EditorMenuEntry::Separator,
            EditorMenuEntry::Predefined {
                item: SystemItem::Cut,
            },
            speech,
        ];
        assert_eq!(validate_editor_menu(&items, 0.0, 10.5, Some("teh")), Ok(()));
        assert_eq!(validate_editor_menu(&items, 0.0, 10.5, None), Ok(()));
    }

    #[test]
    fn refuses_an_editor_menu_that_is_not_the_editors() {
        let bad = |items: Vec<EditorMenuEntry>| validate_editor_menu(&items, 1.0, 1.0, None);
        for id in ["devot.note.trash", "devot.editor.", "devot.editor.a b", "x"] {
            assert_eq!(
                bad(vec![item(id, "Undo")]),
                Err("E_EDITOR_MENU_ITEM_INVALID"),
                "{id}"
            );
        }
        for text in ["", "  ", "a\nb", &"x".repeat(MAX_EDITOR_MENU_TEXT + 1)] {
            assert_eq!(
                bad(vec![item("devot.editor.undo", text)]),
                Err("E_EDITOR_MENU_ITEM_INVALID")
            );
        }
        let inner = EditorMenuEntry::Submenu {
            id: "devot.editor.b".into(),
            text: "B".into(),
            items: vec![],
        };
        let nested = EditorMenuEntry::Submenu {
            id: "devot.editor.a".into(),
            text: "A".into(),
            items: vec![inner],
        };
        assert_eq!(bad(vec![nested]), Err("E_EDITOR_MENU_ITEM_INVALID"));
        let many = vec![EditorMenuEntry::Separator; MAX_EDITOR_MENU_ITEMS + 1];
        assert_eq!(bad(many), Err("E_EDITOR_MENU_TOO_LONG"));
        let one = [item("devot.editor.undo", "Undo")];
        for (x, y) in [
            (-1.0, 0.0),
            (0.0, f64::NAN),
            (f64::INFINITY, 0.0),
            (0.0, 100_001.0),
        ] {
            assert_eq!(
                validate_editor_menu(&one, x, y, None),
                Err("E_EDITOR_MENU_POINT_INVALID")
            );
        }
        for word in ["", "two words", "a\tb", &"x".repeat(MAX_SPELLING_WORD + 1)] {
            assert_eq!(
                validate_editor_menu(&one, 0.0, 0.0, Some(word)),
                Err("E_EDITOR_MENU_WORD_INVALID")
            );
        }
    }

    #[test]
    fn reads_the_pages_accelerators_as_key_equivalents() {
        let key = |k: &str, command, shift, option, control| KeyEquivalent {
            key: k.into(),
            command,
            shift,
            option,
            control,
        };
        assert_eq!(
            key_equivalent("CmdOrCtrl+Z"),
            Some(key("z", true, false, false, false))
        );
        assert_eq!(
            key_equivalent("Ctrl+Shift+Alt+CmdOrCtrl+V"),
            Some(key("v", true, true, true, true))
        );
        assert_eq!(
            key_equivalent("Shift+F10"),
            Some(key("\u{F70D}", false, true, false, false))
        );
        assert_eq!(
            key_equivalent("CmdOrCtrl+Enter"),
            Some(key("\r", true, false, false, false))
        );
        assert_eq!(
            key_equivalent("CmdOrCtrl++"),
            Some(key("+", true, false, false, false))
        );
        assert_eq!(
            key_equivalent("CmdOrCtrl+,"),
            Some(key(",", true, false, false, false))
        );
        assert_eq!(key_equivalent("Hyper+K"), None);
        assert_eq!(key_equivalent("CmdOrCtrl+Fn"), None);
        assert_eq!(key_equivalent("F99"), None);
    }

    #[test]
    fn reads_the_pasteboard_text_as_it_is() {
        assert_eq!(clipboard_read_result(None), Ok(String::new()));
        let text = "line one\r\n  line two\t[x](https://example.com)";
        assert_eq!(clipboard_read_result(Some(text.into())), Ok(text.into()));
        let biggest = "x".repeat(MAX_CLIPBOARD_READ_BYTES);
        assert_eq!(clipboard_read_result(Some(biggest.clone())), Ok(biggest));
        assert_eq!(
            clipboard_read_result(Some("x".repeat(MAX_CLIPBOARD_READ_BYTES + 1))),
            Err("E_CLIPBOARD_TEXT_TOO_LONG")
        );
    }

    #[test]
    fn accepts_note_links_uris_and_ids() {
        let id = "0192a6f0-0000-7000-8000-00000000000a";
        for text in [
            id.to_string(),
            format!("devot://note/{id}"),
            format!("[Plan \\[b\\]](devot://note/{id})"),
            "x".repeat(MAX_CLIPBOARD_TEXT_LEN),
        ] {
            assert!(validate_clipboard_text(&text).is_ok());
        }
    }

    #[test]
    fn takes_the_links_of_many_notes_with_long_titles() {
        // Copy Note Links on 1,500 notes, each title the longest a note may
        // have (in three-byte characters): one link per line.
        let id = "0192a6f0-0000-7000-8000-00000000000a";
        let title = "\u{2026}".repeat(crate::commands::notes::MAX_TITLE_CHARS);
        let links = vec![format!("[{title}](devot://note/{id})"); 1_500].join("\n");
        assert!(links.len() > 4_000_000);
        assert_eq!(validate_clipboard_text(&links), Ok(()));
        // As much as a note may hold, so what is copied can be pasted into one.
        assert_eq!(
            MAX_CLIPBOARD_TEXT_LEN,
            crate::commands::notes::MAX_BODY_BYTES
        );
    }

    #[test]
    fn refuses_empty_oversized_or_nul_text() {
        assert_eq!(validate_clipboard_text(""), Err("E_CLIPBOARD_TEXT_EMPTY"));
        assert_eq!(
            validate_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT_LEN + 1)),
            Err("E_CLIPBOARD_TEXT_TOO_LONG")
        );
        assert_eq!(
            validate_clipboard_text("a\0b"),
            Err("E_CLIPBOARD_TEXT_INVALID")
        );
    }

    #[test]
    fn offers_command_and_control_keys_of_the_key_main_window() {
        let main = KeyDown {
            in_main_window: true,
            main_window_is_key: true,
            ..KeyDown::default()
        };
        assert!(offers_to_format_menu(KeyDown {
            command: true,
            ..main
        }));
        assert!(offers_to_format_menu(KeyDown {
            control: true,
            ..main
        }));
        assert!(offers_to_format_menu(KeyDown {
            command: true,
            control: true,
            ..main
        }));
        // Typing (with or without Shift or Option) never goes to the menu.
        assert!(!offers_to_format_menu(main));
    }

    #[test]
    fn leaves_other_windows_keys_alone() {
        let command = KeyDown {
            command: true,
            ..KeyDown::default()
        };
        // Settings, or a panel, is the key window.
        assert!(!offers_to_format_menu(KeyDown {
            in_main_window: false,
            main_window_is_key: false,
            ..command
        }));
        // A sheet on the main window has the keyboard.
        assert!(!offers_to_format_menu(KeyDown {
            in_main_window: true,
            main_window_is_key: false,
            ..command
        }));
        // An event of another window while the main window is key.
        assert!(!offers_to_format_menu(KeyDown {
            in_main_window: false,
            main_window_is_key: true,
            ..command
        }));
    }

    #[test]
    fn leaves_keys_to_an_input_method_that_is_composing() {
        let main = KeyDown {
            in_main_window: true,
            main_window_is_key: true,
            ..KeyDown::default()
        };
        let command = KeyDown {
            command: true,
            ..main
        };
        let control = KeyDown {
            control: true,
            ..main
        };
        assert!(offers_to_format_menu(command) && offers_to_format_menu(control));
        // Marked text (a composition) in the main window: the input method
        // gets the key first, Command-B as much as a Control key it uses.
        assert!(!offers_to_format_menu(KeyDown {
            marked_text: true,
            ..command
        }));
        assert!(!offers_to_format_menu(KeyDown {
            marked_text: true,
            ..control
        }));
    }

    #[test]
    fn formats_accent_components_as_hex() {
        assert_eq!(hex_from_unit_rgb(0.0, 0.478, 1.0), "#007aff");
        assert_eq!(hex_from_unit_rgb(1.0, 1.0, 1.0), "#ffffff");
        assert_eq!(hex_from_unit_rgb(-0.5, 2.0, 0.5), "#00ff80");
    }

    #[test]
    fn multicolor_carries_no_overrides() {
        let info = AccentInfo::multicolor();
        assert!(info.multicolor && info.light.is_none() && info.dark.is_none());
    }

    #[test]
    fn accepts_real_symbol_names() {
        assert!(validate_symbol_request("square.and.pencil", 17.0, "regular").is_ok());
        assert!(validate_symbol_request("rectangle.split.2x1", 15.0, "regular").is_ok());
    }

    #[test]
    fn rejects_malformed_names() {
        for name in ["", "Square", "a/b", "a b", "../x", &"a".repeat(65)] {
            assert_eq!(
                validate_symbol_request(name, 17.0, "regular"),
                Err("E_SYMBOL_NAME_INVALID")
            );
        }
    }

    #[test]
    fn accepts_every_listed_weight() {
        for weight in SYMBOL_WEIGHTS {
            assert!(validate_symbol_request("pin", 17.0, weight).is_ok());
        }
    }

    #[test]
    fn rejects_unknown_weights() {
        for weight in ["", "Light", "extra-light", "400", "light ", "../x"] {
            assert_eq!(
                validate_symbol_request("pin", 17.0, weight),
                Err("E_SYMBOL_WEIGHT_INVALID")
            );
        }
    }

    #[test]
    fn rejects_out_of_range_sizes() {
        for size in [0.0, -1.0, 129.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                validate_symbol_request("pin", size, "regular"),
                Err("E_SYMBOL_SIZE_INVALID")
            );
        }
    }

    #[test]
    fn renders_off_the_asking_thread_one_at_a_time() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        // Tauri runs an async command's future on its runtime, never on the
        // main thread; the render then goes to a blocking thread of its own.
        let asking = std::thread::current().id();
        let rendered_on =
            tauri::async_runtime::block_on(render_one_at_a_time(|| std::thread::current().id()));
        assert!(rendered_on.is_some_and(|thread| thread != asking));
        // Renders asked for together (the icons of the first paint) take
        // turns.
        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let renders: Vec<_> = (0..8)
            .map(|_| {
                let (running, most) = (Arc::clone(&running), Arc::clone(&most));
                tauri::async_runtime::spawn(render_one_at_a_time(move || {
                    most.fetch_max(running.fetch_add(1, SeqCst) + 1, SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    running.fetch_sub(1, SeqCst);
                }))
            })
            .collect();
        tauri::async_runtime::block_on(async {
            for render in renders {
                assert!(render.await.unwrap().is_some());
            }
        });
        assert_eq!(most.load(SeqCst), 1, "renders overlapped");
    }

    #[test]
    fn the_command_refuses_a_bad_request_before_rendering() {
        let ask = |name: &str, size: f64, weight: Option<&str>| {
            tauri::async_runtime::block_on(symbol_png(name.into(), size, weight.map(String::from)))
                .unwrap_err()
        };
        assert_eq!(ask("../x", 17.0, None), "E_SYMBOL_NAME_INVALID");
        assert_eq!(ask("pin", 0.0, None), "E_SYMBOL_SIZE_INVALID");
        assert_eq!(ask("pin", 17.0, Some("flimsy")), "E_SYMBOL_WEIGHT_INVALID");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn renders_a_known_symbol_as_png() {
        use base64::Engine as _;
        let png = macos::symbol_png("square.and.pencil", 17.0, "light").expect("symbol renders");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        // What the page gets: the same, as base64.
        let answer = tauri::async_runtime::block_on(symbol_png(
            "square.and.pencil".into(),
            17.0,
            Some("light".into()),
        ))
        .unwrap();
        let png = base64::engine::general_purpose::STANDARD
            .decode(answer)
            .unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn look_up_takes_a_word_at_a_point_in_the_page() {
        assert_eq!(validate_look_up("word", 10.0, 20.5), Ok(()));
        assert_eq!(
            validate_look_up("  ", 1.0, 1.0),
            Err("E_LOOK_UP_TEXT_EMPTY")
        );
        assert_eq!(validate_look_up("", 1.0, 1.0), Err("E_LOOK_UP_TEXT_EMPTY"));
        assert_eq!(
            validate_look_up(&"x".repeat(MAX_LOOK_UP_CHARS), 1.0, 1.0),
            Ok(())
        );
        assert_eq!(
            validate_look_up(&"x".repeat(MAX_LOOK_UP_CHARS + 1), 1.0, 1.0),
            Err("E_LOOK_UP_TEXT_TOO_LONG")
        );
        // Characters, not bytes: a long run of two-byte letters still fits.
        assert_eq!(
            validate_look_up(&"\u{e9}".repeat(MAX_LOOK_UP_CHARS), 1.0, 1.0),
            Ok(())
        );
        assert_eq!(
            validate_look_up("a\0b", 1.0, 1.0),
            Err("E_LOOK_UP_TEXT_INVALID")
        );
        for (x, y) in [
            (f64::NAN, 1.0),
            (1.0, f64::INFINITY),
            (-1.0, 1.0),
            (1.0, -0.5),
        ] {
            assert_eq!(validate_look_up("a", x, y), Err("E_LOOK_UP_POINT_INVALID"));
        }
    }

    #[test]
    fn speech_starts_with_the_selection_or_stops() {
        assert_eq!(validate_speech("stop", None), Ok(SpeechRequest::Stop));
        assert_eq!(
            validate_speech("start", None),
            Ok(SpeechRequest::Start(None))
        );
        assert_eq!(
            validate_speech("start", Some(" ".into())),
            Ok(SpeechRequest::Start(None))
        );
        assert_eq!(
            validate_speech("start", Some("hello".into())),
            Ok(SpeechRequest::Start(Some("hello".into())))
        );
        assert_eq!(
            validate_speech("start", Some("x".repeat(MAX_SPEECH_CHARS + 1))),
            Err("E_SPEECH_TEXT_TOO_LONG")
        );
        assert_eq!(
            validate_speech("start", Some("a\0".into())),
            Err("E_SPEECH_TEXT_INVALID")
        );
        assert_eq!(
            validate_speech("pause", None),
            Err("E_SPEECH_ACTION_INVALID")
        );
    }
}
