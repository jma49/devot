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

/// Read by `data_folder::Build::this`; a tag's release build without it stops here.
fn release_marker() {
    // xcodebuild gives an iPhone build no GITHUB_REF_TYPE; app-store.ts marker-check covers it.
    for key in ["DEVOT_RELEASE_BUILD", "GITHUB_REF_TYPE"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let ref_type = std::env::var("GITHUB_REF_TYPE").ok();
    let marker = std::env::var("DEVOT_RELEASE_BUILD").ok();
    if build_env::missing_release_marker(&profile, ref_type.as_deref(), marker.as_deref()) {
        panic!("E_RELEASE_BUILD_MARKER: a tag's release build needs DEVOT_RELEASE_BUILD=1");
    }
}

/// The StoreKit bridge's C functions (`native/ios.rs`), defined by the package in `apple/` that only
/// the iPhone app links.
const STORE_BRIDGE: &[&str] = &[
    "devot_store_products",
    "devot_store_purchase",
    "devot_store_restore",
    "devot_store_entitlements",
    "devot_store_finish",
    "devot_store_listen",
];

/// Xcode links the static library with that package. Cargo also links an iOS cdylib, which
/// nothing ships and which has no Swift, so there the bridge is left to be found at load.
fn store_bridge() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        for symbol in STORE_BRIDGE {
            println!("cargo:rustc-cdylib-link-arg=-Wl,-U,_{symbol}");
        }
    }
}

/// Read by `distribution::Distribution::this`; a value it would not read stops the build here.
fn distribution_marker() {
    println!("cargo:rerun-if-env-changed=DEVOT_DISTRIBUTION");
    let marker = std::env::var("DEVOT_DISTRIBUTION").ok();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if let Some(code) = build_env::distribution_marker_error(marker.as_deref(), &target_os) {
        panic!("{code}: DEVOT_DISTRIBUTION is unset, or app-store for an iPhone build");
    }
}

fn main() {
    sentry_dsn();
    release_marker();
    distribution_marker();
    store_bridge();
    // Declaring the app's commands makes each one need an explicit
    // permission in a capability file, so no window gets a command by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "symbol_png",
            "haptic",
            "system_accent",
            "clipboard_write_text",
            "clipboard_read_text",
            "clipboard_write_secret",
            "text_look_up",
            "text_speak",
            "editor_menu_popup",
            "notes_list",
            "note_get",
            "note_open",
            "notes_bodies",
            "note_put",
            "notes_search",
            "note_backlinks",
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
            "activity_notes_list",
            "agent_writes_list",
            "agent_writes_authored",
            "agent_writes_seen",
            "books_list",
            "book_put",
            "books_put",
            "book_is_live",
            "file_put",
            "files_copy",
            "image_copy",
            "image_save",
            "tags_list",
            "tag_put",
            "tag_rename",
            "note_tag_put",
            "note_tag_get",
            "saved_searches_list",
            "saved_search_put",
            "app_exit_ready",
            "app_exit_cancel",
            "open_external",
            "ai_generate",
            "ai_settings_get",
            "ai_settings_set",
            "ai_key_set",
            "ai_key_clear",
            "licence_get",
            "licence_set",
            "licence_remove",
            "licence_refresh",
            "store_products",
            "store_purchase",
            "store_restore",
            "store_mac_key",
            "sync_get",
            "sync_set",
            "sync_vault_create",
            "sync_vault_rotate",
            "sync_recovery_key",
            "sync_recovery_saved",
            "sync_pairing_open",
            "sync_pairing_check",
            "sync_pairing_cancel",
            "sync_join_code",
            "sync_join_recovery",
            "sync_devices",
            "sync_usage",
            "sync_device_remove",
            "sync_connect",
            "sync_pull",
            "sync_push",
            "sync_push_many",
            "sync_icloud_status",
            "sync_icloud_use",
            "sync_icloud_look",
            "sync_icloud_join",
            "sync_icloud_upload_again",
            "sync_icloud_leave",
            "sync_icloud_storage",
            "sync_disconnect",
            "sync_status_report",
            "sync_pending",
            "sync_pending_count",
            "sync_read",
            "sync_entry_put",
            "sync_state_get",
            "sync_state_put",
            "sync_reset",
            "sync_note_purge",
            "sync_file_data",
            "sync_file_put",
            "sync_file_delete",
            "link_title",
            "github_snippet",
            "format_menu_set",
            "log_write",
            "backups_list",
            "search_index_rebuild",
            "backup_now",
            "backup_restore",
            "backup_restore_ready",
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
            "quick_capture_save",
            "quick_capture_claim",
            "quick_capture_done",
            "quick_capture_close",
            "http_api_get",
            "http_api_set",
            "http_api_token_rotate",
            "http_api_token_reveal",
            "http_api_done",
            "http_api_listening",
            "mcp_access_get",
            "mcp_access_set",
            "background_state",
            "background_quit",
            "background_idle_answer",
            "note_relay_send",
            "note_window_open",
            "note_window_note",
            "note_window_close_ready",
            "note_window_close_cancel",
            "main_window_new",
            "main_windows_changed",
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
            "settings_open_licence",
            "crash_reports_get",
            "crash_reports_set",
            "update_status",
            "update_check",
            "update_download",
            "update_restart",
            "deep_link_take",
            "cli_append_claim",
            "cli_append_done",
            "cli_append_take",
            "settings_mcp_setup",
            "settings_mcp_connect",
            "settings_mcp_disconnect",
            "settings_mcp_open_extension",
            "settings_ai_access_summary",
            "main_window_show",
            "cli_tool_status",
            "cli_tool_install",
            "cli_tool_uninstall",
            "cli_export_source",
            "cli_export_finish",
            "cli_export_fail",
            "plugins_list",
            "plugin_install_pick",
            "plugin_install_confirm",
            "plugin_install_cancel",
            "plugin_set_enabled",
            "plugin_remove",
            "plugin_import_pick",
            "plugin_export_save",
        ]),
    ))
    .expect("E_TAURI_BUILD");
}
