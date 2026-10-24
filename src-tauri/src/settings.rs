//! The Settings window (Cmd+,): a column of panes, one shown at a time in a window of a fixed size. Its capability (`capabilities/settings.json`) grants only what its panes need.

use std::path::Path;
use std::process::Command;

use crate::strings;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "settings";
pub const SHOW_BACKUPS_EVENT: &str = "devot://show-backups";
const PAGE: &str = "settings.html";

const WIDTH: f64 = 820.0;
const HEIGHT: f64 = 640.0;

pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        if crate::deep_link::unminimize(&window)
            .and(window.set_focus())
            .is_err()
        {
            log::warn!("W_SETTINGS_FOCUS_FAILED");
        }
        return;
    }
    let theme = app
        .try_state::<std::sync::Arc<crate::editor_settings::EditorSettingsStore>>()
        .and_then(|store| store.get().ok())
        .and_then(|stored| stored.settings.appearance.window_theme());
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()));
    // The same WebKit store as the main window (`data_folder`).
    if let Some(store) = crate::data_folder::this_build_web_data_store() {
        builder = builder.data_store_identifier(store);
    }
    let builder = builder
        .title(strings::SETTINGS_TITLE)
        .theme(theme)
        .inner_size(WIDTH, HEIGHT)
        .resizable(false);
    #[cfg(desktop)]
    let builder = builder.minimizable(false).maximizable(false);
    let built = builder.build();
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

/// Takes no path, so the page can open no other folder.
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

#[tauri::command]
pub fn settings_show_backups(app: AppHandle) -> Result<(), String> {
    let main = crate::main_windows::front_label(&app)
        .and_then(|label| app.get_webview_window(&label))
        .ok_or_else(|| String::from("E_SETTINGS_NO_MAIN_WINDOW"))?;
    // Shown too: in menu bar mode the main window may be hidden.
    if main
        .show()
        .and(crate::deep_link::unminimize(&main))
        .and(main.set_focus())
        .is_err()
    {
        log::warn!("W_SETTINGS_MAIN_FOCUS_FAILED");
    }
    app.emit_to(main.label(), SHOW_BACKUPS_EVENT, ())
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
