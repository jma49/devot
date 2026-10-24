//! Platform-native capabilities. `native::macos` and `native::ios` are the
//! only places in the crate allowed to use `unsafe`.

#[cfg(target_os = "ios")]
#[allow(unsafe_code)]
#[doc(hidden)]
pub mod ios;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
#[doc(hidden)]
pub mod macos;

#[cfg(target_os = "ios")]
use ios::symbol_png as render_symbol;
#[cfg(target_os = "macos")]
use macos::symbol_png as render_symbol;

pub const ACCENT_EVENT: &str = "devot://accent-changed";

/// An Objective-C exception (which `catch_unwind` cannot stop; it would end the app) and a Rust
/// panic are both caught, logged as `code` and give `None`, the caller's fallback.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn guarded<R>(code: &'static str, call: impl FnOnce() -> Option<R>) -> Option<R> {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    let caught = catch_unwind(AssertUnwindSafe(|| {
        objc2::exception::catch(AssertUnwindSafe(call))
    }));
    match caught {
        Ok(Ok(result)) => result,
        Ok(Err(_exception)) => {
            log::warn!("{code} E_NATIVE_OBJC_EXCEPTION");
            None
        }
        Err(_panic) => {
            log::warn!("{code} E_NATIVE_PANIC");
            None
        }
    }
}

/// The NSWindows of the main windows by label, as addresses (only compared, never used as pointers)
/// so the Format menu's key monitor can tell them from the others.
#[cfg(target_os = "macos")]
static MAIN_WINDOWS: std::sync::Mutex<Vec<(String, usize)>> = std::sync::Mutex::new(Vec::new());

#[cfg(target_os = "macos")]
fn is_main_window(ns_window: *const std::ffi::c_void) -> bool {
    MAIN_WINDOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|(_, address)| *address == ns_window as usize)
}

/// A main window exists now: its web view gets the 120 Hz unlock and its keys the Format menu's
/// priority. Every main window, `main` included, comes through here.
pub fn main_window_built(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        macos::unlock_high_refresh_rate(window);
        match window.ns_window() {
            Ok(address) if !address.is_null() => MAIN_WINDOWS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((window.label().to_owned(), address as usize)),
            _ => log::warn!("W_FORMAT_KEY_MONITOR_NO_WINDOW"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// A main window is gone: its NSWindow is no longer one to serve.
pub fn main_window_gone(label: &str) {
    #[cfg(target_os = "macos")]
    MAIN_WINDOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(kept, _)| kept != label);
    #[cfg(not(target_os = "macos"))]
    let _ = label;
}

pub fn configure_main_window(app: &tauri::App) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Emitter;
        macos::give_format_menu_keys_priority(crate::strings::MENU_FORMAT);
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

/// Main thread only; elsewhere, and off macOS, it shows nothing (the failure is logged all the
/// same).
pub fn show_alert(title: &str, message: &str) {
    #[cfg(target_os = "macos")]
    if !macos::show_critical_alert(title, message) {
        log::warn!("W_NATIVE_ALERT_OFF_MAIN_THREAD");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (title, message);
}

#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct KeyDown {
    pub command: bool,
    pub control: bool,
    pub in_main_window: bool,
    pub main_window_is_key: bool,
    /// The main window's first responder has marked text: an input method
    /// is composing there (in the editor or a field of the web view).
    pub marked_text: bool,
}

/// A key with Command or Control only (every format key has one, so typed text never goes there),
/// in the main window while it is the key window, and not while an input method composes there: it
/// gets the key first (it may use Control keys) and a format would end its composition. The menu
/// takes the key only when one of its items has it, which is only while the editor has the keyboard
/// (`format_menu`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn offers_to_format_menu(key: KeyDown) -> bool {
    (key.command || key.control) && key.in_main_window && key.main_window_is_key && !key.marked_text
}

/// When the user picked Multicolor, the UI keeps Devot's own accent (`light` and `dark` are
/// absent).
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

pub fn hex_from_unit_rgb(r: f64, g: f64, b: f64) -> String {
    let byte = |c: f64| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
}

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

/// A symbol is drawn at this many times the point size asked for, one pixel to a point
/// (`PIXELS_PER_POINT` in `icons/symbols.ts`).
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
const SYMBOL_PIXELS_PER_POINT: f64 = 2.0;

/// In pixels; at the largest point size the widest symbol of Devot's catalogs is 576.
const MAX_SYMBOL_CANVAS: f64 = 1024.0;

/// UIKit's `UIImageSymbolWeight` for a weight of `SYMBOL_WEIGHTS`: 1 (ultralight) to 9 (black), in
/// that order; regular (4) for any other.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn symbol_weight_rank(weight: &str) -> isize {
    SYMBOL_WEIGHTS
        .iter()
        .position(|known| *known == weight)
        .map_or(4, |index| index as isize + 1)
}

/// The bitmap, in whole pixels, that a symbol image of `width` by `height` points fills at one
/// pixel to a point; none for a size no symbol has.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn symbol_canvas(width: f64, height: f64) -> Option<(f64, f64)> {
    // UIKit's whole sizes can carry float noise (34.00000000000001).
    let side = |points: f64| {
        (points.is_finite() && points > 0.0 && points <= MAX_SYMBOL_CANVAS)
            .then(|| (points - 1e-6).ceil().max(1.0))
    };
    Some((side(width)?, side(height)?))
}

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

/// AppKit lets an image be used on any thread, but by one thread at a time, and the symbol images
/// it hands out may be shared.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
static SYMBOL_RENDER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Tauri runs a synchronous command on the main thread, which at launch also routes the page's
/// first IPC: rendering the first paint's 22 icons there held it for about 115 ms (80 of them on
/// the first, when AppKit loads the symbols). None when the render panicked.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
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

#[tauri::command]
pub async fn symbol_png(
    name: String,
    point_size: f64,
    weight: Option<String>,
) -> Result<String, String> {
    let weight = weight.unwrap_or_else(|| String::from("regular"));
    validate_symbol_request(&name, point_size, &weight).map_err(String::from)?;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use base64::Engine as _;
        render_one_at_a_time(move || {
            render_symbol(&name, point_size, &weight)
                .map(|png| base64::engine::general_purpose::STANDARD.encode(png))
        })
        .await
        .flatten()
        .ok_or_else(|| String::from("E_SYMBOL_UNAVAILABLE"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Err(String::from("E_SYMBOL_UNSUPPORTED"))
    }
}

/// Longest text the clipboard command accepts: as much as a note may hold,
/// as a paste takes, so Copy Note Links on any selection a library allows
/// (and any code block) fits.
const MAX_CLIPBOARD_TEXT_LEN: usize = crate::commands::notes::MAX_BODY_BYTES;

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

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAX_CLIPBOARD_READ_BYTES: usize = crate::commands::notes::MAX_BODY_BYTES;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clipboard_read_result(text: Option<String>) -> Result<String, &'static str> {
    let text = text.unwrap_or_default();
    if text.len() > MAX_CLIPBOARD_READ_BYTES {
        return Err("E_CLIPBOARD_TEXT_TOO_LONG");
    }
    Ok(text)
}

/// The page could ask WebKit instead only during a key press in the page, and WebKit would show its
/// own Paste button first.
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

const MAX_LOOK_UP_CHARS: usize = 1_000;

const MAX_SPEECH_CHARS: usize = 100_000;

/// Whether the point lies inside the view is checked against the view itself.
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

const MAX_LOOK_UP_FONT_LIST: usize = 2_048;

const MAX_LOOK_UP_FAMILIES: usize = 16;

const LOOK_UP_FONT_SIZES: std::ops::RangeInclusive<f64> = 1.0..=512.0;

/// The family name the page loads an imported font under starts with this
/// (`importedFontFamily` in src/renderer/src/fonts.ts).
const IMPORTED_FAMILY_PREFIX: &str = "Devot Font ";

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct LookUpFont {
    pub family: String,
    pub size: f64,
    pub weight: f64,
    #[serde(default)]
    pub italic: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum LookUpFamily {
    System,
    Monospaced,
    Installed(String),
    Imported(String),
}

/// Where a Look Up font comes from, in the order to try: an imported font
/// is its file's bytes, read (and checked) before AppKit is asked.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FontSource {
    System,
    Monospaced,
    Installed(String),
    File(Vec<u8>),
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq)]
pub struct LookUpStyle {
    pub sources: Vec<FontSource>,
    /// In points (a CSS pixel each); None for the system font size.
    pub size: Option<f64>,
    pub weight: &'static str,
    /// AppKit's font manager weight (0 to 15; 5 is regular, 9 bold).
    pub manager_weight: isize,
    pub italic: bool,
}

/// A name is checked like the other font names (no quotes or backslashes, a length limit) and
/// skipped when it fails; so is the whole list when it is too long.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn look_up_families(list: &str) -> Vec<LookUpFamily> {
    if list.chars().count() > MAX_LOOK_UP_FONT_LIST {
        return Vec::new();
    }
    list.split(',')
        .filter_map(|name| {
            let name = name.trim();
            let name = ['"', '\'']
                .into_iter()
                .find_map(|q| name.strip_prefix(q)?.strip_suffix(q))
                .unwrap_or(name);
            look_up_family(name)
        })
        .take(MAX_LOOK_UP_FAMILIES)
        .collect()
}

fn look_up_family(name: &str) -> Option<LookUpFamily> {
    match name.to_ascii_lowercase().as_str() {
        "-apple-system" | "system-ui" | "blinkmacsystemfont" | "sans-serif" | "ui-sans-serif" => {
            return Some(LookUpFamily::System);
        }
        "ui-monospace" | "sfmono-regular" | "sf mono" | "monospace" => {
            return Some(LookUpFamily::Monospaced);
        }
        _ => {}
    }
    if let Some(rest) = name.strip_prefix(IMPORTED_FAMILY_PREFIX) {
        // The page names a file `Name.ttf` as `Devot Font Name ttf`: its
        // extension's dot is the last space.
        let (stem, ext) = rest.rsplit_once(' ')?;
        let id = format!("{stem}.{ext}");
        return crate::fonts::valid_id(&id).then_some(LookUpFamily::Imported(id));
    }
    crate::fonts::valid_family_name(name).then(|| LookUpFamily::Installed(name.to_string()))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn css_weight_name(weight: f64) -> &'static str {
    if !weight.is_finite() {
        return "regular";
    }
    let index = (weight / 100.0).round().clamp(1.0, 9.0) as usize - 1;
    SYMBOL_WEIGHTS[index]
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn manager_weight(weight: f64) -> isize {
    const SCALE: [isize; 9] = [2, 3, 4, 5, 6, 8, 9, 10, 11];
    let index = SYMBOL_WEIGHTS
        .iter()
        .position(|name| *name == css_weight_name(weight))
        .unwrap_or(3);
    SCALE[index]
}

/// Of the faces' traits (CoreText's weight, -1 to 1, and italic), the one closest to the wanted
/// ones, a matching italic before a closer weight; the first face when none can be read.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn closest_face(faces: &[Option<(f64, bool)>], weight: f64, italic: bool) -> usize {
    let distance = |(face_weight, face_italic): (f64, bool)| {
        let off = (face_weight - weight).abs();
        (
            face_italic != italic,
            if off.is_nan() { f64::INFINITY } else { off },
        )
    };
    faces
        .iter()
        .enumerate()
        .filter_map(|(index, traits)| Some((index, distance((*traits)?))))
        .min_by(|(_, a), (_, b)| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)))
        .map_or(0, |(index, _)| index)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn look_up_style(font: Option<&LookUpFont>, read: impl Fn(&str) -> Option<Vec<u8>>) -> LookUpStyle {
    let fallback = LookUpStyle {
        sources: Vec::new(),
        size: None,
        weight: "regular",
        manager_weight: 5,
        italic: false,
    };
    let Some(font) = font.filter(|f| LOOK_UP_FONT_SIZES.contains(&f.size)) else {
        return fallback;
    };
    let sources = look_up_families(&font.family)
        .into_iter()
        .filter_map(|family| match family {
            LookUpFamily::System => Some(FontSource::System),
            LookUpFamily::Monospaced => Some(FontSource::Monospaced),
            LookUpFamily::Installed(name) => Some(FontSource::Installed(name)),
            LookUpFamily::Imported(id) => read(&id).map(FontSource::File),
        })
        .collect();
    LookUpStyle {
        sources,
        size: Some(font.size),
        weight: css_weight_name(font.weight),
        manager_weight: manager_weight(font.weight),
        italic: font.italic,
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum SpeechRequest {
    Start(Option<String>),
    Stop,
}

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

#[tauri::command]
pub async fn text_look_up(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    text: String,
    x: f64,
    y: f64,
    font: Option<LookUpFont>,
) -> Result<(), String> {
    validate_look_up(&text, x, y).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // An imported font's file is read here, off the main thread.
        let fonts = std::sync::Arc::clone(&app.state::<std::sync::Arc<crate::fonts::Fonts>>());
        let style = tauri::async_runtime::spawn_blocking(move || {
            look_up_style(font.as_ref(), |id| fonts.read(id).ok())
        })
        .await
        .map_err(|_| String::from("E_LOOK_UP_FAILED"))?;
        let (reply, answer) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let _ = reply.send(macos::look_up(&webview, &text, x, y, &style));
            })
            .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        match answer.await {
            Ok(result) => result.map_err(String::from),
            Err(_) => Err(String::from("E_LOOK_UP_FAILED")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, font);
        Err(String::from("E_LOOK_UP_UNSUPPORTED"))
    }
}

#[tauri::command]
pub async fn text_speak(
    window: tauri::WebviewWindow,
    action: String,
    text: Option<String>,
) -> Result<(), String> {
    let request = validate_speech(&action, text).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
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
        let _ = (window, request);
        Err(String::from("E_SPEECH_UNSUPPORTED"))
    }
}

const MAX_EDITOR_MENU_ITEMS: usize = 64;
const MAX_EDITOR_MENU_TEXT: usize = 200;
const MAX_SPELLING_WORD: usize = 100;
const MAX_EDITOR_MENU_POINT: f64 = 100_000.0;
const EDITOR_MENU_ID_PREFIX: &str = "devot.editor.";

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EditorMenuEntry {
    Item {
        id: String,
        text: String,
        #[serde(default)]
        accelerator: Option<String>,
        #[serde(default)]
        checked: Option<bool>,
    },
    Separator,
    Predefined {
        item: SystemItem,
    },
    Submenu {
        id: String,
        text: String,
        items: Vec<EditorMenuEntry>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum SystemItem {
    Cut,
    Copy,
    Paste,
    SelectAll,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EditorMenuPick {
    Item { id: String },
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

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct KeyEquivalent {
    pub key: String,
    pub command: bool,
    pub shift: bool,
    pub option: bool,
    pub control: bool,
}

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

#[tauri::command]
pub async fn editor_menu_popup(
    window: tauri::WebviewWindow,
    items: Vec<EditorMenuEntry>,
    x: f64,
    y: f64,
    word: Option<String>,
) -> Result<Option<EditorMenuPick>, String> {
    validate_editor_menu(&items, x, y, word.as_deref()).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
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
        let _ = (window, items, word);
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
        let look_up = [item(
            "devot.editor.lookUp",
            "Look Up \u{201C}[31mred [0m\u{201D}",
        )];
        assert_eq!(validate_editor_menu(&look_up, 0.0, 0.0, None), Ok(()));
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
        for text in [
            "",
            "  ",
            "a\nb",
            "Look Up \u{201C}\u{1b}[31mred\u{201D}",
            &"x".repeat(MAX_EDITOR_MENU_TEXT + 1),
        ] {
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
        assert!(!offers_to_format_menu(main));
    }

    #[test]
    fn leaves_other_windows_keys_alone() {
        let command = KeyDown {
            command: true,
            ..KeyDown::default()
        };
        assert!(!offers_to_format_menu(KeyDown {
            in_main_window: false,
            main_window_is_key: false,
            ..command
        }));
        assert!(!offers_to_format_menu(KeyDown {
            in_main_window: true,
            main_window_is_key: false,
            ..command
        }));
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
    fn ranks_weights_lightest_first_as_uikit_numbers_them() {
        let ranks: Vec<isize> = SYMBOL_WEIGHTS
            .iter()
            .map(|w| symbol_weight_rank(w))
            .collect();
        assert_eq!(ranks, (1..=9).collect::<Vec<isize>>());
        assert_eq!(symbol_weight_rank("regular"), 4);
        assert_eq!(symbol_weight_rank("black"), 9);
        assert_eq!(symbol_weight_rank("flimsy"), 4);
    }

    #[test]
    fn a_symbol_canvas_holds_the_whole_image_on_whole_pixels() {
        assert_eq!(symbol_canvas(33.0, 37.0), Some((33.0, 37.0)));
        assert_eq!(symbol_canvas(32.333, 25.667), Some((33.0, 26.0)));
        assert_eq!(symbol_canvas(0.5, 1e-9), Some((1.0, 1.0)));
        // Float noise on a whole size adds no blank column.
        assert_eq!(
            symbol_canvas(34.000_000_000_000_01, 51.0),
            Some((34.0, 51.0))
        );
        let most = MAX_SYMBOL_CANVAS;
        assert_eq!(symbol_canvas(most, most), Some((most, most)));
    }

    #[test]
    fn refuses_a_symbol_canvas_no_symbol_has() {
        for (width, height) in [
            (0.0, 10.0),
            (10.0, 0.0),
            (-1.0, 10.0),
            (f64::NAN, 10.0),
            (10.0, f64::INFINITY),
            (MAX_SYMBOL_CANVAS + 1.0, 10.0),
            (10.0, MAX_SYMBOL_CANVAS + 1.0),
        ] {
            assert_eq!(symbol_canvas(width, height), None, "{width} x {height}");
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

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn a_guarded_call_that_panics_gives_the_fallback() {
        let fell_back = guarded("W_NATIVE_TEST_PANIC", || -> Option<()> {
            panic!("E_NATIVE_TEST_PANIC")
        });
        assert_eq!(fell_back, None);
        assert_eq!(guarded("W_NATIVE_TEST", || Some(7)), Some(7));
    }

    /// As the command renders: on a blocking thread, one at a time, since tests run in parallel.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn render(name: &'static str, points: f64, weight: &'static str) -> Option<Vec<u8>> {
        tauri::async_runtime::block_on(render_one_at_a_time(move || {
            render_symbol(name, points, weight)
        }))
        .flatten()
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn png_size(png: &[u8]) -> (u32, u32) {
        let at = |i: usize| u32::from_be_bytes(png[i..i + 4].try_into().unwrap());
        (at(16), at(20))
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn draws_a_symbol_at_two_pixels_a_point() {
        // A circle symbol is a little larger than its point size (AppKit and UIKit pad it).
        for points in [14.0, 21.0, 64.0] {
            let png = render("checkmark.circle.fill", points, "regular").unwrap();
            let (width, height) = png_size(&png);
            assert_eq!(width, height, "{points} pt");
            let side = f64::from(width) / SYMBOL_PIXELS_PER_POINT;
            assert!(
                (points..=points * 1.25).contains(&side),
                "{points} pt: {side}"
            );
        }
        let heavy = render("trash", 21.0, "black").unwrap();
        let light = render("trash", 21.0, "ultralight").unwrap();
        assert!(png_size(&heavy).0 > png_size(&light).0);
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn renders_nothing_for_a_symbol_the_system_lacks() {
        assert_eq!(render("devot.no.such.symbol", 14.0, "regular"), None);
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn renders_a_known_symbol_as_png() {
        use base64::Engine as _;
        let png = render("square.and.pencil", 17.0, "light").expect("symbol renders");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
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
    fn look_up_reads_the_families_of_a_css_font_list_in_order() {
        use LookUpFamily::*;
        assert_eq!(
            look_up_families(
                "\"Devot Font My Hand ttf\", SFMono-Regular, ui-monospace, 'Courier New', Menlo, monospace"
            ),
            [
                Imported("My Hand.ttf".into()),
                Monospaced,
                Monospaced,
                Installed("Courier New".into()),
                Installed("Menlo".into()),
                Monospaced,
            ]
        );
        assert_eq!(
            look_up_families("-apple-system, BlinkMacSystemFont, system-ui, sans-serif"),
            [System, System, System, System]
        );
        assert_eq!(look_up_families(""), []);
    }

    #[test]
    fn look_up_skips_font_names_that_fail_the_checks() {
        use LookUpFamily::*;
        let long = "x".repeat(200);
        let list = format!(
            "\"A\\\"B\", 'It\'s', .Hidden, \"Devot Font a b c\", \"Devot Font ttf\", {long}, Menlo"
        );
        assert_eq!(look_up_families(&list), [Installed("Menlo".into())]);
        // An imported name keeps its stem's spaces; only the last one is the dot.
        assert_eq!(
            look_up_families("\"Devot Font a b otf\""),
            [Imported("a b.otf".into())]
        );
        // A list over the limit is not read at all; so many families are cut short.
        assert_eq!(look_up_families(&"a,".repeat(MAX_LOOK_UP_FONT_LIST)), []);
        assert_eq!(
            look_up_families(&"Menlo,".repeat(40)).len(),
            MAX_LOOK_UP_FAMILIES
        );
    }

    #[test]
    fn look_up_weights_follow_css_hundreds() {
        assert_eq!(css_weight_name(400.0), "regular");
        assert_eq!(css_weight_name(700.0), "bold");
        assert_eq!(css_weight_name(100.0), "ultralight");
        assert_eq!(css_weight_name(950.0), "black");
        assert_eq!(css_weight_name(0.0), "ultralight");
        assert_eq!(css_weight_name(f64::NAN), "regular");
        assert_eq!(css_weight_name(649.0), "semibold");
        assert_eq!(manager_weight(400.0), 5);
        assert_eq!(manager_weight(700.0), 9);
        assert_eq!(manager_weight(100.0), 2);
        assert_eq!(manager_weight(900.0), 11);
    }

    #[test]
    fn look_up_takes_the_closest_face_of_a_font_file() {
        let regular = Some((0.0, false));
        let bold = Some((0.4, false));
        let italic = Some((0.0, true));
        let bold_italic = Some((0.4, true));
        let faces = [regular, bold, italic, bold_italic];
        assert_eq!(closest_face(&faces, 0.0, false), 0);
        assert_eq!(closest_face(&faces, 0.4, false), 1);
        assert_eq!(closest_face(&faces, 0.0, true), 2);
        assert_eq!(closest_face(&faces, 0.3, true), 3);
        // A matching italic counts before a closer weight.
        assert_eq!(closest_face(&[bold, italic], 0.4, true), 1);
        assert_eq!(closest_face(&[regular, bold], 0.23, false), 1);
        assert_eq!(closest_face(&[bold, Some((-0.4, false))], 0.0, false), 0);
        assert_eq!(closest_face(&[None, bold], 0.0, false), 1);
        assert_eq!(closest_face(&[None, None], 0.4, true), 0);
        assert_eq!(closest_face(&[], 0.0, false), 0);
        assert_eq!(
            closest_face(&[Some((f64::NAN, false)), bold], 0.0, false),
            1
        );
    }

    #[test]
    fn look_up_style_tries_the_families_in_order_and_falls_back_to_the_system_font() {
        let font = |family: &str, size: f64| LookUpFont {
            family: family.into(),
            size,
            weight: 700.0,
            italic: true,
        };
        let read = |id: &str| (id == "Hand.ttf").then(|| vec![1, 2, 3]);
        let style = look_up_style(
            Some(&font(
                "\"Devot Font Gone ttf\", \"Devot Font Hand ttf\", Menlo, ui-monospace",
                24.0,
            )),
            read,
        );
        assert_eq!(
            style.sources,
            [
                FontSource::File(vec![1, 2, 3]),
                FontSource::Installed("Menlo".into()),
                FontSource::Monospaced,
            ]
        );
        assert_eq!(style.size, Some(24.0));
        assert_eq!(
            (style.weight, style.manager_weight, style.italic),
            ("bold", 9, true)
        );
        let system = look_up_style(None, read);
        assert_eq!(system.sources, []);
        assert_eq!(system.size, None);
        assert_eq!((system.weight, system.italic), ("regular", false));
        for size in [0.0, -3.0, 10_000.0, f64::NAN, f64::INFINITY] {
            assert_eq!(look_up_style(Some(&font("Menlo", size)), read), system);
        }
    }

    #[test]
    fn look_up_font_is_upright_unless_it_says_italic() {
        let font: LookUpFont = serde_json::from_value(serde_json::json!({
            "family": "Menlo", "size": 13.0, "weight": 400.0
        }))
        .unwrap();
        assert!(!font.italic);
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
