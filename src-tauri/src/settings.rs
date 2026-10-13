//! The Settings window (Devot > Settings..., Cmd+,). Its capability
//! (`capabilities/settings.json`) grants only what its sections need: the
//! editor settings (see `editor_settings`), and reading and clearing the
//! local usage events.

use crate::strings;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "settings";
const PAGE: &str = "settings.html";

/// Opens the Settings window, or brings it to the front when it is open.
pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.unminimize().and(window.set_focus()).is_err() {
            log::warn!("W_SETTINGS_FOCUS_FAILED");
        }
        return;
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title(strings::SETTINGS_TITLE)
        .inner_size(560.0, 620.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .build();
    if built.is_err() {
        log::warn!("W_SETTINGS_OPEN_FAILED");
    }
}
