//! The Settings window (Cmd+,): a column of panes, one shown at a time in a window of a fixed size. Its capability (`capabilities/settings.json`) grants only what its panes need.

use std::path::Path;
use std::process::Command;

use crate::storage::{BookRecord, Db};
use crate::strings;
use tauri::utils::config::WindowEffectsConfig;
use tauri::utils::{WindowEffect, WindowEffectState};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, State, TitleBarStyle, WebviewUrl,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "settings";
pub const SHOW_BACKUPS_EVENT: &str = "devot://show-backups";
const PAGE: &str = "settings.html";

const WIDTH: f64 = 900.0;
const HEIGHT: f64 = 680.0;
/// The traffic lights sit on the 52 px toolbar's centre line, as in the main window.
const TRAFFIC_LIGHTS: LogicalPosition<f64> = LogicalPosition::new(20.0, 28.0);

/// Tells an open Settings window which pane to show (`settings_open_licence`).
pub const PANE_EVENT: &str = "devot://settings-pane";
const LICENCE_PANE: &str = "licence";

pub fn open(app: &AppHandle) {
    open_at(app, None);
}

/// `pane` is one of this module's, never one a page names.
fn open_at(app: &AppHandle, pane: Option<&'static str>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Some(pane) = pane
            && window.emit_to(LABEL, PANE_EVENT, pane).is_err()
        {
            log::warn!("W_SETTINGS_PANE_FAILED");
        }
        if crate::deep_link::unminimize(&window)
            .and(window.set_focus())
            .is_err()
        {
            log::warn!("W_SETTINGS_FOCUS_FAILED");
        }
        return;
    }
    let page = pane.map_or_else(|| PAGE.to_owned(), page_at);
    let theme = app
        .try_state::<std::sync::Arc<crate::editor_settings::EditorSettingsStore>>()
        .and_then(|store| store.get().ok())
        .and_then(|stored| stored.settings.appearance.window_theme());
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(page.into()));
    // The same WebKit store as the main window (`data_folder`).
    if let Some(store) = crate::data_folder::this_build_web_data_store() {
        builder = builder.data_store_identifier(store);
    }
    let builder = builder
        .title(strings::SETTINGS_TITLE)
        .theme(theme)
        .inner_size(WIDTH, HEIGHT)
        // The page draws the toolbar and the sidebar itself, over the system's sidebar material.
        .transparent(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(TRAFFIC_LIGHTS)
        .effects(WindowEffectsConfig {
            effects: vec![WindowEffect::Sidebar],
            state: Some(WindowEffectState::FollowsWindowActiveState),
            ..Default::default()
        })
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

fn page_at(pane: &str) -> String {
    format!("{PAGE}?pane={pane}")
}

/// Add Licence in the windows' trial notices: Settings, at the Licence pane.
#[tauri::command]
pub fn settings_open_licence(app: AppHandle) {
    open_at(&app, Some(LICENCE_PANE));
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

/// Matches `TEMPLATES_BOOK_ID` in src/core/books.ts: the Templates notebook never counts.
const TEMPLATES_BOOK_ID: &str = "00000000-0000-7000-8000-000000000001";

/// What Settings > Integrations tells the owner about AI access, and whether to offer the picker.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAccessSummary {
    /// Live notebooks, the Templates one left out.
    notebooks: u32,
    /// How many of them allow AI access.
    allowed: u32,
}

fn ai_access_summary(books: &[BookRecord]) -> AiAccessSummary {
    let live = books
        .iter()
        .filter(|book| book.deleted_at.is_none() && book.id != TEMPLATES_BOOK_ID);
    let mut summary = AiAccessSummary {
        notebooks: 0,
        allowed: 0,
    };
    for book in live {
        summary.notebooks += 1;
        if book.ai_access {
            summary.allowed += 1;
        }
    }
    summary
}

#[tauri::command]
pub async fn settings_ai_access_summary(db: State<'_, Db>) -> Result<AiAccessSummary, String> {
    let books = db
        .call(|store| store.list_books())
        .await
        .map_err(|e| e.to_string())?;
    Ok(ai_access_summary(&books))
}

/// Focuses a main window (shown again if hidden, unminimised if needed), or opens one:
/// Settings asks for the AI access picker, which lives in the main window.
#[tauri::command]
pub fn main_window_show(app: AppHandle) -> Result<(), String> {
    let Some(window) =
        crate::main_windows::front_label(&app).and_then(|label| app.get_webview_window(&label))
    else {
        return crate::main_windows::open(&app).map_err(String::from);
    };
    if window
        .show()
        .and(crate::deep_link::unminimize(&window))
        .and(window.set_focus())
        .is_err()
    {
        log::warn!("W_MAIN_WINDOW_FOCUS_FAILED");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn add_licence_opens_settings_at_the_licence_pane() {
        assert_eq!(page_at(LICENCE_PANE), "settings.html?pane=licence");
    }

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

    fn book(id: &str, ai_access: bool, deleted: bool) -> BookRecord {
        const HLC: &str = "0001728000000000-0000-node";
        BookRecord {
            id: id.into(),
            name: "Notebook".into(),
            name_hlc: HLC.into(),
            parent_id: None,
            parent_hlc: String::new(),
            created_at: 1,
            updated_at: 2,
            deleted_at: deleted.then_some(3),
            deleted_hlc: deleted.then(|| HLC.to_string()),
            ai_access,
            ai_access_hlc: if ai_access { HLC.into() } else { String::new() },
            sort_key: "a0".into(),
            sort_key_hlc: HLC.into(),
            icon: None,
            icon_color: None,
            icon_hlc: String::new(),
        }
    }

    #[test]
    fn counts_live_notebooks_and_those_that_allow_ai_access() {
        let books = [
            book("0192a6f0-0000-7000-8000-0000000000b1", true, false),
            book("0192a6f0-0000-7000-8000-0000000000b2", false, false),
            book("0192a6f0-0000-7000-8000-0000000000b3", true, true),
            book(TEMPLATES_BOOK_ID, true, false),
        ];
        assert_eq!(
            ai_access_summary(&books),
            AiAccessSummary {
                notebooks: 2,
                allowed: 1
            },
        );
    }
}
