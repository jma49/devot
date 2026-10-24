// Desktop-only commands leave their helpers unused on a phone.
#![cfg_attr(mobile, allow(dead_code))]

mod atomic_file;
mod backups;
#[cfg(test)]
#[path = "../build_env.rs"]
mod build_env;
mod cli;
mod cli_export;
mod cli_tool;
mod commands;
mod crash;
#[doc(hidden)]
pub mod crash_reporter;
mod crash_scrub;
mod data_folder;
mod deep_link;
mod diagnostics;
mod editor_settings;
mod exit;
mod export;
mod external;
mod fonts;
#[cfg(desktop)]
mod format_menu;
mod import;
mod keyboard_shortcuts;
mod link_info;
mod logs;
#[cfg(desktop)]
mod menu;
#[cfg(desktop)]
mod menu_bar;
mod mirror;
#[doc(hidden)]
pub mod native;
mod net;
pub mod page_setup;
mod settings;
mod sidebar_material;
mod single_instance;
mod startup;
mod storage;
mod strings;
#[cfg(test)]
mod test_log;
#[cfg(desktop)]
mod updates;
mod usage;
mod watch;

use startup::StartupError;
use std::path::Path;
use tauri::{Manager, WebviewWindowBuilder};

pub(crate) const MAIN_WINDOW: &str = "main";

pub fn crash_reporter_main() -> Option<i32> {
    crash::reporter_main(&std::env::args_os().collect::<Vec<_>>())
}

/// The `devot` command's exit status; `None` for a normal launch.
pub fn cli_main() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    let is_cli = args.get(1).is_some_and(|arg| arg == cli::FLAG);
    is_cli.then(|| cli::main(&args[2..]))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Sentry first, so its panic hook sees every panic; off without a DSN.
    let _crash_reporting = crash::init();
    let context = data_folder::context();
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(single_instance::init())
        .plugin(menu_bar::global_shortcut_plugin())
        .manage(menu_bar::MenuBar::default())
        .manage(menu_bar::Captures::default());
    builder
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            native::symbol_png,
            native::system_accent,
            native::clipboard_write_text,
            native::clipboard_read_text,
            native::text_look_up,
            native::text_speak,
            native::editor_menu_popup,
            commands::notes::notes_list,
            commands::notes::note_get,
            commands::notes::notes_bodies,
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
            link_info::link_title,
            link_info::github_snippet,
            #[cfg(desktop)]
            format_menu::format_menu_set,
            logs::log_write,
            commands::search_index::search_index_rebuild,
            backups::backups_list,
            backups::backup_now,
            backups::backup_restore,
            import::import_read,
            import::import_attach,
            import::import_finish,
            import::import_pick,
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
            settings::settings_mcp_setup,
            cli_tool::cli_tool_status,
            cli_tool::cli_tool_install,
            cli_tool::cli_tool_uninstall,
            editor_settings::editor_settings_get,
            editor_settings::editor_settings_set,
            fonts::font_import,
            fonts::fonts_list,
            fonts::fonts_installed,
            fonts::font_read,
            sidebar_material::sidebar_material_sync,
            #[cfg(desktop)]
            menu::sidebar_menu_set,
            #[cfg(desktop)]
            menu::command_menu_set,
            #[cfg(desktop)]
            menu_bar::quick_capture_save,
            #[cfg(desktop)]
            menu_bar::quick_capture_done,
            #[cfg(desktop)]
            menu_bar::quick_capture_close,
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
            #[cfg(desktop)]
            updates::update_status,
            #[cfg(desktop)]
            updates::update_check,
            #[cfg(desktop)]
            updates::update_download,
            #[cfg(desktop)]
            updates::update_restart,
            deep_link::deep_link_take,
        ])
        .register_asynchronous_uri_scheme_protocol("devot", |ctx, request, responder| {
            commands::files::serve(ctx.app_handle(), request, responder)
        })
        // The folder panel for import; no window is granted its commands.
        .plugin(tauri_plugin_dialog::init())
        .manage(exit::ExitGate::default())
        .manage(import::Imports::default())
        .manage(export::Exports::default())
        .manage(deep_link::DeepLinks::default())
        .on_page_load(deep_link::on_page_load)
        .on_window_event(|window, event| {
            exit::on_window_event(window, event);
            deep_link::on_window_event(window, event);
            #[cfg(desktop)]
            updates::on_window_event(window, event);
        })
        .setup(|app| {
            // A launch that fails ends here, explained, never in a panic.
            let Ok(data_dir) = app.path().app_data_dir() else {
                startup::fail(&StartupError::new("E_DATA_FOLDER_UNKNOWN"), None)
            };
            logs::install(&data_dir.join(logs::DIR));
            deep_link::listen(app);
            if let Err(error) = launch(app, &data_dir) {
                startup::fail(&error, Some(&data_dir));
            }
            let args: Vec<String> = std::env::args_os()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            cli::receive_open(app.handle(), &args);
            Ok(())
        })
        .build(context)
        .expect("E_TAURI_BUILD")
        .run(|app, event| {
            exit::on_run_event(app, &event);
            #[cfg(desktop)]
            menu_bar::on_run_event(app, &event);
        });
}

/// Any failure has a code: `startup::fail` explains it and exits.
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
    let editor_settings =
        editor_settings::EditorSettingsStore::new(&data_dir.join(editor_settings::FILE));
    #[cfg(target_os = "macos")]
    let editor_settings = editor_settings.with_default_paper(native::macos::system_paper);
    let editor_settings = std::sync::Arc::new(editor_settings);
    app.manage(std::sync::Arc::clone(&editor_settings));
    app.manage(std::sync::Arc::new(fonts::Fonts::new(data_dir)));
    app.manage(std::sync::Arc::new(
        keyboard_shortcuts::KeyboardShortcutsStore::new(&data_dir.join(keyboard_shortcuts::FILE)),
    ));
    mirror::manage(app, data_dir);
    let now = std::time::SystemTime::now();
    export::sweep_pdf_folders(&data_dir.join(export::PDF_DIR), now);
    if let Ok(caches) = app.path().app_cache_dir() {
        export::sweep_pdf_folders(&caches.join(export::PDF_DIR), now);
    }
    backups::start(app.handle());
    watch::start(app.handle());
    #[cfg(desktop)]
    install_desktop(app)?;
    // Built here rather than from the config alone, to route pop-ups.
    let mut main = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .ok_or_else(|| StartupError::new("E_MAIN_WINDOW_CONFIG_MISSING"))?
        .clone();
    // The sidebar material as stored: an opaque sidebar starts without the window effect, and the page starts from the same settings, so its first paint matches the window.
    let stored = editor_settings
        .get()
        .unwrap_or_else(|_| editor_settings::Snapshot {
            revision: 0,
            settings: editor_settings::EditorSettings::default(),
        });
    let configured = main.window_effects.take();
    let material = stored.settings.sidebar_material;
    main.window_effects = sidebar_material::effects_for(material, configured.as_ref());
    main.theme = stored.settings.appearance.window_theme();
    // A debug build keeps its web data apart from the release app's.
    main.data_store_identifier = data_folder::this_build_web_data_store();
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
    #[cfg(desktop)]
    menu_bar::apply(app.handle(), stored.settings.menu_bar);
    #[cfg(desktop)]
    updates::start(app.handle());
    Ok(())
}

#[cfg(desktop)]
fn install_desktop(app: &mut tauri::App) -> Result<(), StartupError> {
    // The updater, only with the public key the release workflow builds in.
    let with_updater = updates::configured(app.config().plugins.0.get("updater"))
        && app
            .handle()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .is_ok();
    let version = app.package_info().version.to_string();
    app.manage(updates::Updates::new(with_updater, version));
    menu::install(app).map_err(|_| StartupError::new("E_MENU_FAILED"))
}
