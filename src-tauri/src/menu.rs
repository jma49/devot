//! The native menu bar. Quit is a custom item so it can run the save
//! handshake (see `exit`); Settings opens its own window (see `settings`);
//! Backups… asks the main window to show its backups dialog;
//! Check for Updates… checks for an update, and becomes Restart to Update
//! once one is downloaded (see `updates`);
//! Help > Export Diagnostics… writes a diagnostics file (see `diagnostics`);
//! File > Import > Markdown Files…, Markdown Folder… and HTML Files… ask for
//! what to import (see `import`);
//! View > Revision History… asks the main window to show the open note's history;
//! View > Command Palette… asks the main window to open its command palette;
//! the accelerators of both are the command registry's default keys
//! (`src/renderer/src/commands/registry.ts`, compared by a test) until the
//! main window sets the keys in effect (`command_menu_set`), which the user
//! may have changed;
//! View > Activity… asks the main window to show the activity heatmap;
//! View > Hide Sidebar asks the main window to hide or show its sidebar; its
//! accelerator is the registry's too, and the page relabels it Show Sidebar
//! while the sidebar is hidden (`sidebar_menu_set`);
//! View > Synced Scrolling turns synced scrolling in split mode on or off: a
//! check item for the `syncScroll` editor setting, stored here in Rust and
//! kept in line with the setting however it changes; it has no key unless
//! the user gives the command one, which the main window sets as the others;
//! the Format menu sends the editor's format commands (see `format_menu`);
//! everything else uses the standard items.

use crate::editor_settings::{self, EditorSettings, EditorSettingsStore, Snapshot};
use crate::{diagnostics, exit, format_menu, import, settings, strings, updates};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder,
    SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager, State, Window, Wry};

pub const QUIT_ID: &str = "devot.quit";
pub const SETTINGS_ID: &str = "devot.settings";
pub const DIAGNOSTICS_ID: &str = "devot.diagnostics";
pub const BACKUPS_ID: &str = "devot.backups";
pub const UPDATES_ID: &str = "devot.updates.check";
pub const IMPORT_MARKDOWN_ID: &str = "devot.import.markdown";
pub const IMPORT_MARKDOWN_FILES_ID: &str = "devot.import.markdownFiles";
pub const IMPORT_HTML_FILES_ID: &str = "devot.import.htmlFiles";
pub const EXPORT_ALL_MARKDOWN_ID: &str = "devot.export.allMarkdown";
pub const EXPORT_ALL_HTML_ID: &str = "devot.export.allHtml";
/// File > Export > All Notes: the window exports, in the format sent
/// (`markdown` or `html`).
pub const EXPORT_ALL_EVENT: &str = "devot://export-all";
pub const SHOW_BACKUPS_EVENT: &str = "devot://show-backups";
pub const HISTORY_ID: &str = "devot.history";
pub const SHOW_HISTORY_EVENT: &str = "devot://show-history";
pub const PALETTE_ID: &str = "devot.palette";
pub const SHOW_PALETTE_EVENT: &str = "devot://show-palette";
pub const ACTIVITY_ID: &str = "devot.activity";
pub const SHOW_ACTIVITY_EVENT: &str = "devot://show-activity";
pub const SIDEBAR_ID: &str = "devot.sidebar";
pub const TOGGLE_SIDEBAR_EVENT: &str = "devot://toggle-sidebar";
pub const TOGGLE_PREVIEW_ID: &str = "devot.togglePreview";
pub const TOGGLE_PREVIEW_EVENT: &str = "devot://toggle-preview";
pub const SPLIT_ID: &str = "devot.split";
pub const SHOW_SPLIT_EVENT: &str = "devot://show-split";

/// View > Hide Sidebar, kept to relabel it.
pub struct SidebarMenuItem(MenuItem<Wry>);

/// The menu a command item is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuPlace {
    /// The View menu.
    View,
    /// The app menu (Devot), the menu bar's first.
    App,
}

/// A menu item that runs a registry command.
pub struct CommandItem {
    /// The menu the item is in.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub place: MenuPlace,
    /// The registry command's ID.
    pub command: &'static str,
    /// Every title the item can have (read on macOS to clear its key).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub titles: &'static [&'static str],
}

/// The menu items that run a registry command (View, and Devot > Backups...).
pub const COMMAND_ITEMS: &[CommandItem] = &[
    CommandItem {
        place: MenuPlace::View,
        command: "note.history",
        titles: &[strings::REVISION_HISTORY],
    },
    CommandItem {
        place: MenuPlace::View,
        command: "palette.open",
        titles: &[strings::COMMAND_PALETTE],
    },
    CommandItem {
        place: MenuPlace::View,
        command: "view.sidebar",
        titles: &[strings::HIDE_SIDEBAR, strings::SHOW_SIDEBAR],
    },
    CommandItem {
        place: MenuPlace::View,
        command: "view.togglePreview",
        titles: &[strings::TOGGLE_PREVIEW],
    },
    CommandItem {
        place: MenuPlace::View,
        command: "view.split",
        titles: &[strings::SHOW_SPLIT],
    },
    CommandItem {
        place: MenuPlace::View,
        command: "view.syncScroll",
        titles: &[strings::SYNC_SCROLL],
    },
    CommandItem {
        place: MenuPlace::App,
        command: "app.backups",
        titles: &[strings::BACKUPS],
    },
];

/// A command item: a plain item, or a check item (View > Synced Scrolling).
enum CommandMenuItem {
    Plain(MenuItem<Wry>),
    Check(CheckMenuItem<Wry>),
}

impl CommandMenuItem {
    fn set_accelerator(&self, accelerator: Option<&str>) -> tauri::Result<()> {
        match self {
            Self::Plain(item) => item.set_accelerator(accelerator),
            Self::Check(item) => item.set_accelerator(accelerator),
        }
    }
}

/// The items of `COMMAND_ITEMS`, kept to set their keys.
pub struct CommandMenu(Vec<(&'static str, CommandMenuItem)>);

/// Checks the keys the UI sends (command ID to accelerator, or none) and
/// gives every command item its key, or none (a command missing from the
/// map has none).
pub fn plan_command_keys(
    keys: &HashMap<String, Option<String>>,
) -> Result<Vec<(&'static str, Option<String>)>, &'static str> {
    let mut seen = Vec::new();
    for (command, accelerator) in keys {
        if !COMMAND_ITEMS.iter().any(|item| item.command == command) {
            return Err("E_COMMAND_MENU_COMMAND_UNKNOWN");
        }
        let Some(accelerator) = accelerator else {
            continue;
        };
        let parsed = format_menu::parse_accelerator(accelerator)
            .ok_or("E_COMMAND_MENU_ACCELERATOR_INVALID")?;
        if seen.contains(&parsed) {
            return Err("E_COMMAND_MENU_ACCELERATOR_DUPLICATE");
        }
        if format_menu::MENU_BAR_KEYS
            .iter()
            .any(|taken| format_menu::parse_accelerator(taken) == Some(parsed))
        {
            return Err("E_COMMAND_MENU_ACCELERATOR_TAKEN");
        }
        seen.push(parsed);
    }
    Ok(COMMAND_ITEMS
        .iter()
        .map(|item| (item.command, keys.get(item.command).cloned().flatten()))
        .collect())
}

/// Gives View > Revision History..., Command Palette..., Hide Sidebar and
/// Synced Scrolling, and Devot > Backups..., the keys their commands have now (main window only): the user may have changed
/// them (Settings > Keyboard Shortcuts). Keys are command ID to accelerator
/// (as `shortcutAccelerator` writes it), or null for no key.
#[tauri::command]
pub async fn command_menu_set(
    app: AppHandle,
    window: Window,
    menu: State<'_, CommandMenu>,
    keys: HashMap<String, Option<String>>,
) -> Result<(), String> {
    if window.label() != crate::MAIN_WINDOW {
        return Err(String::from("E_COMMAND_MENU_WINDOW"));
    }
    let plan = plan_command_keys(&keys).map_err(String::from)?;
    // Setting no accelerator leaves an item's old key in place, so the keys
    // come off natively first and only the planned ones go back on.
    let mut failed = !clear_command_keys(&app).await;
    for (command, accelerator) in plan {
        let Some((_, item)) = menu.0.iter().find(|(c, _)| *c == command) else {
            continue;
        };
        if accelerator.is_some() {
            failed |= item.set_accelerator(accelerator.as_deref()).is_err();
        }
    }
    if failed {
        log::warn!("W_COMMAND_MENU_UPDATE_FAILED");
        return Err(String::from("E_COMMAND_MENU_UPDATE_FAILED"));
    }
    Ok(())
}

/// Takes the keys off the command items (see `native::macos::clear_item_key_equivalents`).
async fn clear_command_keys(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let titles_in = |place: MenuPlace| -> Vec<&'static str> {
            COMMAND_ITEMS
                .iter()
                .filter(|item| item.place == place)
                .flat_map(|item| item.titles.iter().copied())
                .collect()
        };
        let (view, app_menu) = (titles_in(MenuPlace::View), titles_in(MenuPlace::App));
        let (reply, answer) = tokio::sync::oneshot::channel();
        let sent = app.run_on_main_thread(move || {
            let _ = reply.send(
                crate::native::macos::clear_item_key_equivalents(strings::MENU_VIEW, &view)
                    & crate::native::macos::clear_app_menu_key_equivalents(&app_menu),
            );
        });
        sent.is_ok() && answer.await.unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        true
    }
}

/// The label of View > Hide Sidebar while the sidebar shows (or not).
fn sidebar_label(shown: bool) -> &'static str {
    if shown {
        strings::HIDE_SIDEBAR
    } else {
        strings::SHOW_SIDEBAR
    }
}

/// Relabels View > Hide Sidebar after the main window's sidebar is hidden or
/// shown (main window only).
#[tauri::command]
pub fn sidebar_menu_set(
    window: Window,
    item: State<'_, SidebarMenuItem>,
    shown: bool,
) -> Result<(), String> {
    if window.label() != crate::MAIN_WINDOW {
        return Err(String::from("E_SIDEBAR_MENU_WINDOW"));
    }
    item.0.set_text(sidebar_label(shown)).map_err(|_| {
        log::warn!("W_SIDEBAR_MENU_SET_FAILED");
        String::from("E_SIDEBAR_MENU_SET_FAILED")
    })
}
pub const SYNC_SCROLL_ID: &str = "devot.syncScroll";

/// View > Synced Scrolling, kept so its check mark can follow the setting,
/// with the revision of the settings it shows (changes may announce
/// themselves out of order; an older one never overrides a newer one) and
/// when a page last set the setting (see `MENU_ECHO`).
struct SyncScrollItem {
    item: CheckMenuItem<Wry>,
    shown: Mutex<u64>,
    set_by_page: Mutex<Option<Instant>>,
}

/// A View > Synced Scrolling toggle this soon after a page set the setting
/// is the key press that page ran the command for reaching the menu too
/// (the item has the command's key), and is dropped, as the page drops the
/// menu's echo of its sidebar key; otherwise the two would undo each other.
const MENU_ECHO: Duration = Duration::from_millis(500);

/// Notes that a page set synced scrolling (`editor_settings_set`), before
/// it is stored.
pub fn sync_scroll_set_by_page(app: &AppHandle) {
    let Some(state) = app.try_state::<SyncScrollItem>() else {
        return;
    };
    if let Ok(mut at) = state.set_by_page.lock() {
        *at = Some(Instant::now());
    }
}

/// Whether a menu toggle at `now` echoes a page's change at `set_by_page`.
fn is_echo(set_by_page: Option<Instant>, now: Instant) -> bool {
    set_by_page.is_some_and(|at| now.saturating_duration_since(at) < MENU_ECHO)
}

/// What View > Synced Scrolling stores: the opposite of the current value,
/// or no change for an echo (which still shows the stored value again).
fn sync_scroll_toggle(
    settings: &EditorSettings,
    echo: bool,
) -> serde_json::Map<String, serde_json::Value> {
    if echo {
        serde_json::Map::new()
    } else {
        editor_settings::toggle_sync_scroll(settings)
    }
}

pub fn install(app: &App) -> tauri::Result<()> {
    let quit = MenuItemBuilder::with_id(QUIT_ID, strings::QUIT)
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let settings = MenuItemBuilder::with_id(SETTINGS_ID, strings::SETTINGS)
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let backups = MenuItemBuilder::with_id(BACKUPS_ID, strings::BACKUPS).build(app)?;
    let (title, enabled) = updates::menu_item(&app.state::<updates::Updates>().status().state);
    let check_updates = MenuItemBuilder::with_id(UPDATES_ID, title)
        .enabled(enabled)
        .build(app)?;
    app.manage(updates::UpdatesMenuItem(check_updates.clone()));
    let app_menu = SubmenuBuilder::new(app, strings::APP_NAME)
        .about(None)
        .item(&check_updates)
        .separator()
        .item(&settings)
        .item(&backups)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let import_markdown_files =
        MenuItemBuilder::with_id(IMPORT_MARKDOWN_FILES_ID, strings::IMPORT_MARKDOWN_FILES)
            .build(app)?;
    let import_markdown =
        MenuItemBuilder::with_id(IMPORT_MARKDOWN_ID, strings::IMPORT_MARKDOWN_FOLDER).build(app)?;
    let import_html =
        MenuItemBuilder::with_id(IMPORT_HTML_FILES_ID, strings::IMPORT_HTML_FILES).build(app)?;
    let import = SubmenuBuilder::new(app, strings::MENU_IMPORT)
        .item(&import_markdown_files)
        .item(&import_markdown)
        .item(&import_html)
        .build()?;
    let export_markdown =
        MenuItemBuilder::with_id(EXPORT_ALL_MARKDOWN_ID, strings::EXPORT_ALL_MARKDOWN)
            .build(app)?;
    let export_html =
        MenuItemBuilder::with_id(EXPORT_ALL_HTML_ID, strings::EXPORT_ALL_HTML).build(app)?;
    let export = SubmenuBuilder::new(app, strings::MENU_EXPORT)
        .item(&export_markdown)
        .item(&export_html)
        .build()?;
    let file = SubmenuBuilder::new(app, strings::MENU_FILE)
        .item(&import)
        .item(&export)
        .build()?;
    let edit = SubmenuBuilder::new(app, strings::MENU_EDIT)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let (format, format_items) = format_menu::build(app)?;
    app.manage(format_items);
    let history = MenuItemBuilder::with_id(HISTORY_ID, strings::REVISION_HISTORY)
        .accelerator("Alt+CmdOrCtrl+Y")
        .build(app)?;
    let palette = MenuItemBuilder::with_id(PALETTE_ID, strings::COMMAND_PALETTE)
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let activity = MenuItemBuilder::with_id(ACTIVITY_ID, strings::ACTIVITY).build(app)?;
    let sidebar = MenuItemBuilder::with_id(SIDEBAR_ID, strings::HIDE_SIDEBAR)
        .accelerator("CmdOrCtrl+/")
        .build(app)?;
    app.manage(SidebarMenuItem(sidebar.clone()));
    let stored = app
        .state::<Arc<EditorSettingsStore>>()
        .get()
        .unwrap_or_else(|_| Snapshot {
            revision: 0,
            settings: EditorSettings::default(),
        });
    let toggle_preview = MenuItemBuilder::with_id(TOGGLE_PREVIEW_ID, strings::TOGGLE_PREVIEW)
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let split = MenuItemBuilder::with_id(SPLIT_ID, strings::SHOW_SPLIT)
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let sync_scroll = CheckMenuItemBuilder::with_id(SYNC_SCROLL_ID, strings::SYNC_SCROLL)
        .checked(stored.settings.sync_scroll)
        .build(app)?;
    app.manage(SyncScrollItem {
        item: sync_scroll.clone(),
        shown: Mutex::new(stored.revision),
        set_by_page: Mutex::new(None),
    });
    // In `COMMAND_ITEMS` order (a test checks that order).
    app.manage(CommandMenu(
        COMMAND_ITEMS
            .iter()
            .map(|item| item.command)
            .zip([
                CommandMenuItem::Plain(history.clone()),
                CommandMenuItem::Plain(palette.clone()),
                CommandMenuItem::Plain(sidebar.clone()),
                CommandMenuItem::Plain(toggle_preview.clone()),
                CommandMenuItem::Plain(split.clone()),
                CommandMenuItem::Check(sync_scroll.clone()),
                CommandMenuItem::Plain(backups.clone()),
            ])
            .collect(),
    ));
    let view = SubmenuBuilder::new(app, strings::MENU_VIEW)
        .item(&palette)
        .separator()
        .item(&sidebar)
        .item(&toggle_preview)
        .item(&split)
        .item(&sync_scroll)
        .separator()
        .item(&history)
        .item(&activity)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, strings::MENU_WINDOW)
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;
    let diagnostics =
        MenuItemBuilder::with_id(DIAGNOSTICS_ID, strings::EXPORT_DIAGNOSTICS).build(app)?;
    let help = SubmenuBuilder::new(app, strings::MENU_HELP)
        .item(&diagnostics)
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &format, &view, &window, &help])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(on_menu_event);
    Ok(())
}

/// The format File > Export > All Notes item `id` exports in, if it is one.
fn export_all_format(id: &str) -> Option<&'static str> {
    match id {
        EXPORT_ALL_MARKDOWN_ID => Some("markdown"),
        EXPORT_ALL_HTML_ID => Some("html"),
        _ => None,
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id() == QUIT_ID {
        exit::request_quit(app);
    } else if event.id() == SETTINGS_ID {
        settings::open(app);
    } else if event.id() == UPDATES_ID {
        updates::on_menu(app);
    } else if event.id() == BACKUPS_ID {
        if app.emit_to("main", SHOW_BACKUPS_EVENT, ()).is_err() {
            log::warn!("W_BACKUPS_MENU_EMIT_FAILED");
        }
    } else if event.id() == HISTORY_ID {
        if app.emit_to("main", SHOW_HISTORY_EVENT, ()).is_err() {
            log::warn!("W_HISTORY_MENU_EMIT_FAILED");
        }
    } else if event.id() == PALETTE_ID {
        if app.emit_to("main", SHOW_PALETTE_EVENT, ()).is_err() {
            log::warn!("W_PALETTE_MENU_EMIT_FAILED");
        }
    } else if event.id() == ACTIVITY_ID {
        if app.emit_to("main", SHOW_ACTIVITY_EVENT, ()).is_err() {
            log::warn!("W_ACTIVITY_MENU_EMIT_FAILED");
        }
    } else if event.id() == SIDEBAR_ID {
        if app.emit_to("main", TOGGLE_SIDEBAR_EVENT, ()).is_err() {
            log::warn!("W_SIDEBAR_MENU_EMIT_FAILED");
        }
    } else if event.id() == TOGGLE_PREVIEW_ID {
        if app.emit_to("main", TOGGLE_PREVIEW_EVENT, ()).is_err() {
            log::warn!("W_TOGGLE_PREVIEW_MENU_EMIT_FAILED");
        }
    } else if event.id() == SPLIT_ID {
        if app.emit_to("main", SHOW_SPLIT_EVENT, ()).is_err() {
            log::warn!("W_SPLIT_MENU_EMIT_FAILED");
        }
    } else if event.id() == SYNC_SCROLL_ID {
        toggle_sync_scroll(app);
    } else if event.id() == IMPORT_MARKDOWN_ID {
        import::pick(app, import::Pick::MarkdownFolders, None);
    } else if event.id() == IMPORT_MARKDOWN_FILES_ID {
        import::pick(app, import::Pick::MarkdownFiles, None);
    } else if event.id() == IMPORT_HTML_FILES_ID {
        import::pick(app, import::Pick::HtmlFiles, None);
    } else if let Some(format) = export_all_format(event.id().as_ref()) {
        if app.emit_to("main", EXPORT_ALL_EVENT, format).is_err() {
            log::warn!("W_EXPORT_MENU_EMIT_FAILED");
        }
    } else if event.id() == DIAGNOSTICS_ID {
        match diagnostics::export(app) {
            Ok(_) => log::info!("I_DIAGNOSTICS_EXPORTED"),
            Err(code) => log::warn!("W_DIAGNOSTICS_EXPORT_FAILED {code}"),
        }
    } else {
        format_menu::on_menu_event(app, event.id().as_ref());
    }
}

/// View > Synced Scrolling: stores the opposite of the current setting and
/// tells every window, as a change from the Settings window would. AppKit
/// has toggled the check mark already; `show_editor_settings` sets it to
/// what was stored. An echo of a page's key (see `MENU_ECHO`) changes
/// nothing; it is told apart while no other change can come between, so a
/// page's change stored first is always seen.
fn toggle_sync_scroll(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = Arc::clone(&app.state::<Arc<EditorSettingsStore>>());
        let echo = || {
            let state = app.state::<SyncScrollItem>();
            let Ok(mut at) = state.set_by_page.lock() else {
                return false;
            };
            is_echo(at.take(), Instant::now())
        };
        match store.update_from(|now| sync_scroll_toggle(now, echo())) {
            Ok(next) => editor_settings::announce(&app, &next),
            Err(code) => {
                log::warn!("W_SYNC_SCROLL_TOGGLE_FAILED {code}");
                if let Ok(now) = store.get() {
                    show_editor_settings(&app, &now);
                }
            }
        }
    });
}

/// Brings the menu bar's check items in line with stored editor settings,
/// unless they show newer ones already.
pub fn show_editor_settings(app: &AppHandle, snapshot: &Snapshot) {
    let Some(state) = app.try_state::<SyncScrollItem>() else {
        return;
    };
    let Ok(mut shown) = state.shown.lock() else {
        return;
    };
    if !is_newer(snapshot.revision, *shown) {
        return;
    }
    *shown = snapshot.revision;
    if state
        .item
        .set_checked(snapshot.settings.sync_scroll)
        .is_err()
    {
        log::warn!("W_SYNC_SCROLL_MENU_FAILED");
    }
}

/// Whether settings of `revision` may replace those of `shown` in the menu
/// (the same revision too: a failed toggle shows the stored value again).
fn is_newer(revision: u64, shown: u64) -> bool {
    revision >= shown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_items_that_run_a_command() {
        let commands: Vec<_> = COMMAND_ITEMS.iter().map(|item| item.command).collect();
        assert_eq!(
            commands,
            [
                "note.history",
                "palette.open",
                "view.sidebar",
                "view.togglePreview",
                "view.split",
                "view.syncScroll",
                "app.backups"
            ]
        );
        // Backups is in the app menu; the others are in View.
        let places: Vec<_> = COMMAND_ITEMS.iter().map(|item| item.place).collect();
        assert_eq!(
            places,
            [
                MenuPlace::View,
                MenuPlace::View,
                MenuPlace::View,
                MenuPlace::View,
                MenuPlace::View,
                MenuPlace::View,
                MenuPlace::App
            ]
        );
        assert_eq!(COMMAND_ITEMS[6].titles, [strings::BACKUPS]);
        // The sidebar item is found by either label.
        let sidebar = COMMAND_ITEMS[2].titles;
        assert!(sidebar.contains(&sidebar_label(true)) && sidebar.contains(&sidebar_label(false)));
    }

    fn keys(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(c, a)| ((*c).to_owned(), a.map(str::to_owned)))
            .collect()
    }

    #[test]
    fn plans_the_command_keys() {
        let plan = plan_command_keys(&keys(&[
            ("note.history", Some("Alt+CmdOrCtrl+Y")),
            ("palette.open", None),
            ("view.sidebar", Some("Shift+Alt+CmdOrCtrl+S")),
        ]))
        .unwrap();
        assert_eq!(
            plan,
            [
                ("note.history", Some("Alt+CmdOrCtrl+Y".to_owned())),
                ("palette.open", None),
                ("view.sidebar", Some("Shift+Alt+CmdOrCtrl+S".to_owned())),
                ("view.togglePreview", None),
                ("view.split", None),
                ("view.syncScroll", None),
                ("app.backups", None),
            ]
        );
        // A command left out has no key.
        let plan = plan_command_keys(&keys(&[("palette.open", Some("Ctrl+F5"))])).unwrap();
        assert_eq!(plan[0], ("note.history", None));
        assert_eq!(plan[1], ("palette.open", Some("Ctrl+F5".to_owned())));
        // The check item takes a key as the others do.
        let plan =
            plan_command_keys(&keys(&[("view.syncScroll", Some("Shift+CmdOrCtrl+J"))])).unwrap();
        assert_eq!(
            plan[5],
            ("view.syncScroll", Some("Shift+CmdOrCtrl+J".to_owned()))
        );
        // Backups takes a key like the others.
        let plan = plan_command_keys(&keys(&[("app.backups", Some("Shift+CmdOrCtrl+B"))])).unwrap();
        assert_eq!(
            plan[6],
            ("app.backups", Some("Shift+CmdOrCtrl+B".to_owned()))
        );
    }

    #[test]
    fn refuses_bad_command_keys() {
        assert_eq!(
            plan_command_keys(&keys(&[("format.bold", Some("CmdOrCtrl+B"))])),
            Err("E_COMMAND_MENU_COMMAND_UNKNOWN")
        );
        for bad in ["", "P", "Shift+P", "Cmd+P", "CmdOrCtrl+p", "CmdOrCtrl+F13"] {
            assert_eq!(
                plan_command_keys(&keys(&[("palette.open", Some(bad))])),
                Err("E_COMMAND_MENU_ACCELERATOR_INVALID"),
                "{bad}"
            );
        }
        for taken in ["CmdOrCtrl+Q", "CmdOrCtrl+,", "CmdOrCtrl+Z", "CmdOrCtrl+V"] {
            assert_eq!(
                plan_command_keys(&keys(&[("palette.open", Some(taken))])),
                Err("E_COMMAND_MENU_ACCELERATOR_TAKEN"),
                "{taken}"
            );
        }
        assert_eq!(
            plan_command_keys(&keys(&[
                ("palette.open", Some("CmdOrCtrl+J")),
                ("view.sidebar", Some("CmdOrCtrl+J")),
            ])),
            Err("E_COMMAND_MENU_ACCELERATOR_DUPLICATE")
        );
    }

    #[test]
    fn labels_the_sidebar_item_by_what_it_does() {
        assert_eq!(sidebar_label(true), "Hide Sidebar");
        assert_eq!(sidebar_label(false), "Show Sidebar");
    }

    #[test]
    fn drops_the_menu_echo_of_a_page_key_once_and_only_soon_after() {
        let set = Instant::now();
        assert!(is_echo(Some(set), set));
        assert!(is_echo(Some(set), set + MENU_ECHO / 2));
        assert!(!is_echo(Some(set), set + MENU_ECHO));
        assert!(!is_echo(None, set));
        // An echo stores nothing; any other toggle the opposite value.
        let on = EditorSettings::default();
        assert!(on.sync_scroll);
        assert!(sync_scroll_toggle(&on, true).is_empty());
        assert_eq!(
            sync_scroll_toggle(&on, false).get("syncScroll"),
            Some(&serde_json::Value::Bool(false))
        );
    }

    #[test]
    fn an_older_change_never_overrides_a_newer_one_in_the_menu() {
        assert!(is_newer(6, 5));
        assert!(is_newer(5, 5));
        assert!(!is_newer(5, 6));
    }

    #[test]
    fn file_export_items_name_the_format_the_window_exports_in() {
        assert_eq!(export_all_format(EXPORT_ALL_MARKDOWN_ID), Some("markdown"));
        assert_eq!(export_all_format(EXPORT_ALL_HTML_ID), Some("html"));
        assert_eq!(export_all_format(IMPORT_MARKDOWN_ID), None);
        assert_eq!(export_all_format("devot.export"), None);
    }
}
