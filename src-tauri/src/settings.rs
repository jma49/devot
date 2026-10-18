//! The Settings window (Devot > Settings..., Cmd+,): a column of panes on
//! the left, one shown at a time in a window of a fixed size (a longer pane
//! scrolls). Its capability (`capabilities/settings.json`) grants
//! only what its panes need: the editor settings (see `editor_settings`),
//! the keyboard shortcuts, the Markdown mirror's setting, reading and
//! clearing the local usage events, opening the app's data folder in Finder
//! (`settings_open_data_folder`, which takes no path), showing the main
//! window's Backups dialog (`settings_show_backups`) and where devot-mcp
//! and the database are, for the Integrations pane's client configs
//! (`settings_mcp_setup`).

use std::path::Path;
use std::process::Command;

use crate::{menu, strings};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "settings";
const PAGE: &str = "settings.html";

/// The window's content width.
const WIDTH: f64 = 820.0;
/// Its content height; a longer pane scrolls.
const HEIGHT: f64 = 640.0;

/// Opens the Settings window, or brings it to the front when it is open.
pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.unminimize().and(window.set_focus()).is_err() {
            log::warn!("W_SETTINGS_FOCUS_FAILED");
        }
        return;
    }
    // The appearance chosen in Settings, or the system's.
    let theme = app
        .try_state::<std::sync::Arc<crate::editor_settings::EditorSettingsStore>>()
        .and_then(|store| store.get().ok())
        .and_then(|stored| stored.settings.appearance.window_theme());
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()));
    // The same WebKit store as the main window (`data_folder`).
    if let Some(store) = crate::data_folder::this_build_web_data_store() {
        builder = builder.data_store_identifier(store);
    }
    let built = builder
        .title(strings::SETTINGS_TITLE)
        .theme(theme)
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .build();
    match built {
        // Links from other apps wait until it closes (`deep_link`).
        Ok(_) => crate::deep_link::settings_opened(app),
        Err(_) => log::warn!("W_SETTINGS_OPEN_FAILED"),
    }
}

/// What opens `folder` in Finder. The folder is the app's own, never one
/// the page names; an absolute path cannot be read by `open` as a flag.
fn open_folder_command(folder: &Path) -> Result<Command, &'static str> {
    if !folder.is_absolute() {
        return Err("E_DATA_FOLDER_INVALID");
    }
    let mut open = Command::new("/usr/bin/open");
    open.arg(folder);
    Ok(open)
}

/// Settings > General > Open Data Folder: shows the folder Devot keeps its
/// notes, backups, logs and settings in (`data_folder`) in Finder. It takes
/// no path, so the page can open no other folder.
#[tauri::command]
pub fn settings_open_data_folder(app: AppHandle) -> Result<(), String> {
    let folder = app
        .path()
        .app_data_dir()
        .map_err(|_| String::from("E_DATA_FOLDER_UNAVAILABLE"))?;
    let open = open_folder_command(&folder)?;
    crate::external::spawn_reaped(open, "W_DATA_FOLDER_OPEN_EXITED")
        .map(drop)
        .map_err(|_| String::from("E_DATA_FOLDER_OPEN_FAILED"))
}

/// Settings > General > Backups: does what Devot > Backups... does (the
/// main window shows its Backups dialog) and brings the main window to the
/// front, where the dialog is.
#[tauri::command]
pub fn settings_show_backups(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window(crate::MAIN_WINDOW)
        .ok_or_else(|| String::from("E_SETTINGS_NO_MAIN_WINDOW"))?;
    if main.unminimize().and(main.set_focus()).is_err() {
        log::warn!("W_SETTINGS_MAIN_FOCUS_FAILED");
    }
    app.emit_to(crate::MAIN_WINDOW, menu::SHOW_BACKUPS_EVENT, ())
        .map_err(|_| String::from("E_SETTINGS_BACKUPS_FAILED"))
}

/// What Settings > Integrations writes devot-mcp's client configs with.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetup {
    /// devot-mcp as `pnpm mcp:build` writes it in the checkout this app was
    /// built from, when it is there; none for a build made elsewhere.
    script: Option<String>,
    /// The database to pass with `--db`: a debug build's only, since
    /// devot-mcp opens the release app's by default.
    db: Option<String>,
}

/// The setup for an app built from `checkout`, keeping its data in `data_dir`.
fn mcp_setup(checkout: &Path, data_dir: &Path, debug: bool) -> McpSetup {
    let script = checkout.join("dist-mcp").join("devot-mcp.mjs");
    let text = |path: &Path| path.to_str().map(String::from);
    McpSetup {
        script: if script.is_file() {
            text(&script)
        } else {
            None
        },
        db: if debug {
            text(&data_dir.join(crate::startup::DB_FILE))
        } else {
            None
        },
    }
}

/// Settings > Integrations: where devot-mcp and the database are, for the
/// configs the pane offers to copy. Takes no arguments.
#[tauri::command]
pub fn settings_mcp_setup(app: AppHandle) -> Result<McpSetup, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| String::from("E_DATA_FOLDER_UNAVAILABLE"))?;
    // The crate is `src-tauri` inside the checkout.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let checkout = manifest.parent().unwrap_or(manifest);
    Ok(mcp_setup(checkout, &data_dir, cfg!(debug_assertions)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn finds_devot_mcp_in_the_checkout_and_names_a_debug_database() {
        let checkout = tempfile::tempdir().unwrap();
        let data = Path::new("/Users/me/Library/Application Support/io.github.jma49.devot.dev");
        assert_eq!(
            mcp_setup(checkout.path(), data, false),
            McpSetup {
                script: None,
                db: None
            },
        );
        let dist = checkout.path().join("dist-mcp");
        std::fs::create_dir(&dist).unwrap();
        std::fs::write(dist.join("devot-mcp.mjs"), "").unwrap();
        let setup = mcp_setup(checkout.path(), data, true);
        assert_eq!(setup.script.as_deref(), dist.join("devot-mcp.mjs").to_str(),);
        assert_eq!(
            setup.db.as_deref(),
            Some("/Users/me/Library/Application Support/io.github.jma49.devot.dev/devot.sqlite"),
        );
    }

    #[test]
    fn opens_the_data_folder_itself_with_open() {
        let folder = Path::new("/Users/me/Library/Application Support/io.github.jma49.devot.dev");
        let open = open_folder_command(folder).unwrap();
        assert_eq!(open.get_program(), OsStr::new("/usr/bin/open"));
        let args: Vec<&OsStr> = open.get_args().collect();
        assert_eq!(args, [folder.as_os_str()]);
    }

    #[test]
    fn refuses_a_folder_open_could_read_as_a_flag() {
        for folder in ["-a Calculator", "relative/folder", ""] {
            assert!(open_folder_command(Path::new(folder)).is_err(), "{folder}");
        }
    }
}
