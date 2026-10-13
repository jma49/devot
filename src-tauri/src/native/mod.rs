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

/// Checks a symbol request before it reaches native code.
fn validate_symbol_request(name: &str, point_size: f64) -> Result<(), &'static str> {
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
    Ok(())
}

/// Renders an SF Symbol as a base64 PNG at twice `point_size` pixels.
#[tauri::command]
pub fn symbol_png(name: String, point_size: f64) -> Result<String, String> {
    validate_symbol_request(&name, point_size).map_err(String::from)?;
    #[cfg(target_os = "macos")]
    {
        use base64::Engine as _;
        macos::symbol_png(&name, point_size)
            .map(|png| base64::engine::general_purpose::STANDARD.encode(png))
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(validate_symbol_request("square.and.pencil", 17.0).is_ok());
        assert!(validate_symbol_request("rectangle.split.2x1", 15.0).is_ok());
    }

    #[test]
    fn rejects_malformed_names() {
        for name in ["", "Square", "a/b", "a b", "../x", &"a".repeat(65)] {
            assert_eq!(
                validate_symbol_request(name, 17.0),
                Err("E_SYMBOL_NAME_INVALID")
            );
        }
    }

    #[test]
    fn rejects_out_of_range_sizes() {
        for size in [0.0, -1.0, 129.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                validate_symbol_request("pin", size),
                Err("E_SYMBOL_SIZE_INVALID")
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn renders_a_known_symbol_as_png() {
        let png = macos::symbol_png("square.and.pencil", 17.0).expect("symbol renders");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
