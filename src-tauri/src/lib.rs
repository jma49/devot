mod atomic_file;
mod backups;
#[cfg(test)]
#[path = "../build_env.rs"]
mod build_env;
mod commands;
mod crash;
#[doc(hidden)]
pub mod crash_reporter;
mod crash_scrub;
mod data_folder;
mod diagnostics;
mod editor_settings;
mod exit;
mod export;
mod external;
mod fonts;
mod format_menu;
mod import;
mod keyboard_shortcuts;
mod logs;
mod menu;
mod mirror;
#[doc(hidden)]
pub mod native;
mod settings;
mod sidebar_material;
mod startup;
mod storage;
mod strings;
#[cfg(test)]
mod test_log;
mod usage;
mod watch;

use startup::StartupError;
use std::path::Path;
use tauri::{Manager, WebviewWindowBuilder};

/// The main window's label; other windows (Settings) come and go.
pub(crate) const MAIN_WINDOW: &str = "main";

/// Runs the native crash reporter when the binary was started as one
/// (`crash_reporter`), returning its exit code; `None` for a normal launch.
pub fn crash_reporter_main() -> Option<i32> {
    crash::reporter_main(&std::env::args_os().collect::<Vec<_>>())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Sentry first, so its panic hook sees every panic; off without a DSN.
    let _crash_reporting = crash::init();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            native::symbol_png,
            native::system_accent,
            native::clipboard_write_text,
            native::clipboard_read_text,
            commands::notes::notes_list,
            commands::notes::note_get,
            commands::notes::note_put,
            commands::notes::notes_search,
            commands::notes::notes_trash_list,
            commands::notes::note_purge,
            commands::revisions::revision_put,
            commands::revisions::revisions_list,
            commands::revisions::revision_get,
            commands::revisions::revisions_delete,
            commands::revisions::revisions_compactable,
            commands::revisions::revisions_compact,
            commands::revisions::revisions_last_compaction,
            commands::activity::activity_list,
            commands::files::file_put,
            commands::files::files_copy,
            commands::images::image_copy,
            commands::images::image_save,
            commands::books::books_list,
            commands::books::book_put,
            commands::tags::tags_list,
            commands::tags::tag_put,
            commands::tags::note_tag_put,
            commands::tags::note_tag_get,
            exit::app_exit_ready,
            exit::app_exit_cancel,
            external::open_external,
            format_menu::format_menu_set,
            logs::log_write,
            backups::backups_list,
            backups::backup_now,
            backups::backup_restore,
            import::import_read,
            import::import_attach,
            import::import_finish,
            export::export_begin,
            export::export_attach,
            export::export_write,
            export::export_finish,
            export::export_pdf,
            export::note_print,
            export::clipboard_write_html,
            usage::usage_record,
            usage::usage_list,
            usage::usage_clear,
            settings::settings_open_data_folder,
            settings::settings_show_backups,
            editor_settings::editor_settings_get,
            editor_settings::editor_settings_set,
            fonts::font_import,
            fonts::fonts_list,
            fonts::fonts_installed,
            fonts::font_read,
            sidebar_material::sidebar_material_sync,
            menu::sidebar_menu_set,
            menu::command_menu_set,
            keyboard_shortcuts::keyboard_shortcuts_get,
            keyboard_shortcuts::keyboard_shortcuts_set,
            mirror::mirror_get,
            mirror::mirror_set,
            mirror::mirror_choose,
            mirror::mirror_confirm,
            mirror::mirror_open,
            mirror::mirror_check,
            mirror::mirror_apply,
            mirror::mirror_bodies,
            mirror::mirror_files,
            mirror::mirror_hashes,
        ])
        // Attachments: devot://file/<id>, read from the database.
        .register_asynchronous_uri_scheme_protocol("devot", |ctx, request, responder| {
            commands::files::serve(ctx.app_handle(), request, responder)
        })
        // The folder panel for import; no window is granted its commands.
        .plugin(tauri_plugin_dialog::init())
        .manage(exit::ExitGate::default())
        .manage(import::Imports::default())
        .manage(export::Exports::default())
        .on_window_event(exit::on_window_event)
        .setup(|app| {
            // A launch that fails ends here, explained, never in a panic.
            let Ok(data_dir) = app.path().app_data_dir() else {
                startup::fail(&StartupError::new("E_DATA_FOLDER_UNKNOWN"), None)
            };
            logs::install(&data_dir.join(logs::DIR));
            if let Err(error) = launch(app, &data_dir) {
                startup::fail(&error, Some(&data_dir));
            }
            Ok(())
        })
        .build(data_folder::context())
        .expect("E_TAURI_BUILD")
        .run(|app, event| exit::on_run_event(app, &event));
}

/// Opens the data folder in `data_dir` (held for this process alone) and
/// its database, then sets up the app's state, menus and main window. Any
/// failure has a code: `startup::fail` explains it and exits.
fn launch(app: &mut tauri::App, data_dir: &Path) -> Result<(), StartupError> {
    // One Devot per data folder, for the life of the process.
    let (held, db) = startup::open_data(data_dir, crash::start_native)?;
    app.manage(held);
    let db_path = data_dir.join(startup::DB_FILE);
    app.manage(db);
    app.manage(backups::Backups::new(data_dir, &db_path));
    // Usage events: a separate file, outside sync, backups and devot-mcp.
    app.manage(std::sync::Arc::new(usage::UsageLog::new(
        &data_dir.join(usage::FILE),
        usage::Limits::DEFAULT,
    )));
    // Editor settings: a small file, local to this device.
    let editor_settings = std::sync::Arc::new(editor_settings::EditorSettingsStore::new(
        &data_dir.join(editor_settings::FILE),
    ));
    app.manage(std::sync::Arc::clone(&editor_settings));
    app.manage(std::sync::Arc::new(fonts::Fonts::new(data_dir)));
    app.manage(std::sync::Arc::new(
        keyboard_shortcuts::KeyboardShortcutsStore::new(&data_dir.join(keyboard_shortcuts::FILE)),
    ));
    // The Markdown mirror: a folder and its setting, local to this device.
    mirror::manage(app, data_dir);
    backups::start(app.handle());
    // devot-mcp writes while Devot runs: the window takes the changes in.
    watch::start(app.handle());
    menu::install(app).map_err(|_| StartupError::new("E_MENU_FAILED"))?;
    // Built here rather than from the config alone, to route pop-ups.
    let mut main = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .ok_or_else(|| StartupError::new("E_MAIN_WINDOW_CONFIG_MISSING"))?
        .clone();
    // The sidebar material, as stored: an opaque sidebar starts without the
    // window effect, and changes follow at run time
    // (`sidebar_material_sync`). The page starts from the same settings, so
    // its first paint matches the window.
    let stored = editor_settings
        .get()
        .unwrap_or_else(|_| editor_settings::Snapshot {
            revision: 0,
            settings: editor_settings::EditorSettings::default(),
        });
    let configured = main.window_effects.take();
    let material = stored.settings.sidebar_material;
    main.window_effects = sidebar_material::effects_for(material, configured.as_ref());
    // The appearance chosen in Settings, or the system's.
    main.theme = stored.settings.appearance.window_theme();
    app.manage(sidebar_material::SidebarMaterial::new(
        configured,
        sidebar_material::Shown {
            revision: stored.revision,
            material,
        },
    ));
    WebviewWindowBuilder::from_config(app.handle(), &main)
        .map_err(|_| StartupError::new("E_MAIN_WINDOW_FAILED"))?
        .on_new_window(external::on_new_window)
        .initialization_script(editor_settings::initial_script(&stored))
        .build()
        .map_err(|_| StartupError::new("E_MAIN_WINDOW_FAILED"))?;
    native::configure_main_window(app);
    Ok(())
}
