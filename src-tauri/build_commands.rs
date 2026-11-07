// Every app command, by area: build.rs declares them all, and each needs a grant in capabilities/.
// A new command goes at the end of its area's list.

/// The window around the editor: native look, clipboard, menus, links, the iPhone's share sheet
/// and the app's exit.
const SHELL: &[&str] = &[
    "symbol_png",
    "haptic",
    "system_accent",
    "clipboard_write_text",
    "clipboard_read_text",
    "clipboard_write_secret",
    "text_look_up",
    "text_speak",
    "editor_menu_popup",
    "app_exit_ready",
    "app_exit_cancel",
    "open_external",
    "link_title",
    "github_snippet",
    "format_menu_set",
    "log_write",
    "clipboard_write_html",
    "sidebar_menu_set",
    "command_menu_set",
    "deep_link_take",
    "phone_share",
];

/// Notes, notebooks, tags, saved searches and their files.
const NOTES: &[&str] = &[
    "notes_list",
    "note_get",
    "note_open",
    "notes_bodies",
    "notes_summaries",
    "note_put",
    "notes_search",
    "note_backlinks",
    "notes_trash_list",
    "note_purge",
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
    "search_index_rebuild",
    "welcome_seed",
];

/// Revisions, activity, agent writes and usage.
const HISTORY: &[&str] = &[
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
    "usage_record",
    "usage_list",
    "usage_clear",
];

/// Backups, import, export, printing and the Markdown mirror.
const FILES: &[&str] = &[
    "backups_list",
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
];

/// Editor settings, fonts, shortcuts and crash reports.
const SETTINGS: &[&str] = &[
    "editor_settings_get",
    "editor_settings_set",
    "font_import",
    "fonts_list",
    "fonts_installed",
    "font_read",
    "keyboard_shortcuts_get",
    "keyboard_shortcuts_set",
    "crash_reports_get",
    "crash_reports_set",
];

/// Quick capture, note windows, background running and the main windows.
const WINDOWS: &[&str] = &[
    "quick_capture_save",
    "quick_capture_claim",
    "quick_capture_done",
    "quick_capture_close",
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
    "main_window_show",
];

/// Licence, purchases and updates.
const LICENCE: &[&str] = &[
    "licence_get",
    "licence_set",
    "licence_remove",
    "licence_refresh",
    "store_products",
    "store_purchase",
    "store_restore",
    "store_mac_key",
    "store_refund",
    "settings_open_licence",
    "update_status",
    "update_check",
    "update_download",
    "update_restart",
];

/// Sync.
const SYNC: &[&str] = &[
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
];

/// AI providers, AI access, MCP and the local HTTP API.
const AI: &[&str] = &[
    "ai_generate",
    "ai_settings_get",
    "ai_settings_set",
    "ai_key_set",
    "ai_key_clear",
    "http_api_get",
    "http_api_set",
    "http_api_token_rotate",
    "http_api_token_reveal",
    "http_api_done",
    "http_api_listening",
    "mcp_access_get",
    "mcp_access_set",
    "settings_mcp_setup",
    "settings_mcp_connect",
    "settings_mcp_disconnect",
    "settings_mcp_open_extension",
    "settings_ai_access_summary",
];

/// The command line tool.
const CLI: &[&str] = &[
    "cli_append_claim",
    "cli_append_done",
    "cli_append_take",
    "cli_tool_status",
    "cli_tool_install",
    "cli_tool_uninstall",
    "cli_export_source",
    "cli_export_finish",
    "cli_export_fail",
];

/// Plugins.
const PLUGINS: &[&str] = &[
    "plugins_list",
    "plugin_install_pick",
    "plugin_install_confirm",
    "plugin_install_cancel",
    "plugin_set_enabled",
    "plugin_remove",
    "plugin_import_pick",
    "plugin_export_save",
];

pub const AREAS: &[&[&str]] = &[
    SHELL, NOTES, HISTORY, FILES, SETTINGS, WINDOWS, LICENCE, SYNC, AI, CLI, PLUGINS,
];
