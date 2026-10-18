#[path = "build_env.rs"]
mod build_env;

const ENV_FILE: &str = "../.env.local";

/// Crash reporting: a `DEVOT_SENTRY_DSN` in the environment wins (set it empty
/// to turn reporting off); otherwise the one in `.env.local` is compiled in.
fn sentry_dsn() {
    let text = std::fs::read_to_string(ENV_FILE).ok();
    for line in build_env::watch_lines(ENV_FILE, text.is_some()) {
        println!("{line}");
    }
    if let Some(text) = text
        && std::env::var_os("DEVOT_SENTRY_DSN").is_none()
        && let Some(dsn) = build_env::sentry_dsn(&text)
    {
        println!("cargo:rustc-env=DEVOT_SENTRY_DSN={dsn}");
    }
}

fn main() {
    sentry_dsn();
    // Declaring the app's commands makes each one need an explicit
    // permission in a capability file, so no window gets a command by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "symbol_png",
            "system_accent",
            "clipboard_write_text",
            "clipboard_read_text",
            "notes_list",
            "note_get",
            "note_put",
            "notes_search",
            "notes_trash_list",
            "note_purge",
            "revision_put",
            "revisions_list",
            "revision_get",
            "revisions_delete",
            "revisions_compactable",
            "revisions_compact",
            "revisions_last_compaction",
            "activity_list",
            "books_list",
            "book_put",
            "file_put",
            "files_copy",
            "image_copy",
            "image_save",
            "tags_list",
            "tag_put",
            "note_tag_put",
            "note_tag_get",
            "app_exit_ready",
            "app_exit_cancel",
            "open_external",
            "format_menu_set",
            "log_write",
            "backups_list",
            "backup_now",
            "backup_restore",
            "import_read",
            "import_attach",
            "import_finish",
            "import_pick",
            "export_begin",
            "export_attach",
            "export_write",
            "export_finish",
            "export_pdf",
            "note_print",
            "clipboard_write_html",
            "usage_record",
            "usage_list",
            "usage_clear",
            "editor_settings_get",
            "editor_settings_set",
            "font_import",
            "fonts_list",
            "fonts_installed",
            "font_read",
            "sidebar_material_sync",
            "sidebar_menu_set",
            "command_menu_set",
            "keyboard_shortcuts_get",
            "keyboard_shortcuts_set",
            "mirror_get",
            "mirror_set",
            "mirror_choose",
            "mirror_confirm",
            "mirror_open",
            "mirror_check",
            "mirror_apply",
            "mirror_bodies",
            "mirror_files",
            "mirror_hashes",
            "settings_open_data_folder",
            "settings_show_backups",
        ]),
    ))
    .expect("E_TAURI_BUILD");
}
