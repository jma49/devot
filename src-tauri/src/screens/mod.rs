//! The iPhone's native screens (docs/specs/iphone-screens.md): the bridge's messages and its state
//! between Swift and the page. The C calls are in `native::ios::screens`; this side holds no
//! `unsafe` and is tested off the phone.

pub mod hub;
pub mod message;

const MAX_LOG_LINE: usize = 200;

/// A line Swift logs: a code (`I_`, `W_` or `E_`), then IDs as `key=value`, in printable ASCII.
/// Anything else is refused, so a note's text cannot reach the log this way.
pub fn log_line(level: u8, line: &[u8]) -> Option<(log::Level, &str)> {
    let level = match level {
        0 => log::Level::Info,
        1 => log::Level::Warn,
        2 => log::Level::Error,
        _ => return None,
    };
    let line = std::str::from_utf8(line).ok()?;
    let coded = ["I_", "W_", "E_"].iter().any(|code| line.starts_with(code));
    let printable = line.bytes().all(|b| b.is_ascii_graphic() || b == b' ');
    (coded && printable && line.len() > 2 && line.len() <= MAX_LOG_LINE).then_some((level, line))
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn screens_post(message: String) -> Result<(), String> {
    crate::native::ios::screens_post(message.as_bytes()).map_err(String::from)
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn screens_take() -> hub::Taken {
    crate::native::ios::screens_take()
}

/// A reload loses what the page was handed; the next page takes what still waits.
#[cfg(target_os = "ios")]
pub fn on_page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if webview.label() == crate::MAIN_WINDOW
        && payload.event() == tauri::webview::PageLoadEvent::Started
    {
        crate::native::ios::screens_page_started();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_a_coded_line_of_printable_ascii_only() {
        assert_eq!(
            log_line(1, b"W_SCREENS_INSTALL_REFUSED reason=no-window"),
            Some((
                log::Level::Warn,
                "W_SCREENS_INSTALL_REFUSED reason=no-window"
            ))
        );
        assert_eq!(
            log_line(0, b"I_SCREENS_UP").map(|l| l.0),
            Some(log::Level::Info)
        );
        assert_eq!(log_line(2, b"E_X").map(|l| l.0), Some(log::Level::Error));
        for refused in [
            &b"Groceries: milk"[..],
            b"W_",
            b"W_TITLE \xc3\xa9",
            b"W_TITLE\nGroceries",
            b"W_\xff",
        ] {
            assert_eq!(log_line(1, refused), None, "{refused:?}");
        }
        assert_eq!(log_line(3, b"W_SCREENS"), None);
        let longest = format!("W_{}", "A".repeat(MAX_LOG_LINE - 2));
        assert!(log_line(1, longest.as_bytes()).is_some());
        assert_eq!(log_line(1, format!("{longest}A").as_bytes()), None);
    }

    #[test]
    fn grants_the_screens_commands_to_the_iphone() {
        let screens = ["screens_post", "screens_take"];
        let areas = include_str!("../../build_commands.rs");
        assert!(areas.contains(r#"const SCREENS: &[&str] = &["screens_post", "screens_take"];"#));
        let listed = areas.split("pub const AREAS").nth(1).unwrap_or_default();
        assert!(
            listed
                .split("];")
                .next()
                .unwrap_or_default()
                .contains("SCREENS")
        );
        let phone: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/phone.json")).unwrap();
        assert_eq!(phone["platforms"], serde_json::json!(["iOS"]));
        assert_eq!(phone["windows"], serde_json::json!(["main"]));
        let granted: Vec<&str> = phone["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect();
        for command in screens {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(granted.contains(&permission.as_str()), "{permission}");
        }
    }
}
