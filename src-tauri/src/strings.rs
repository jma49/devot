//! User-facing strings shown by Rust (native menus). English is the source
//! locale; when a second locale ships, these move to the shared catalog.

pub const APP_NAME: &str = "Devot";
pub const MENU_FILE: &str = "File";
pub const MENU_IMPORT: &str = "Import";
pub const IMPORT_MARKDOWN_FOLDER: &str = "Markdown Folder…";
pub const IMPORT_MARKDOWN_TITLE: &str = "Import a Markdown Folder";
pub const SAVE_IMAGE_TITLE: &str = "Save Image";
pub const SAVE_IMAGE_FILTER: &str = "Image";
pub const EXPORT_MARKDOWN_TITLE: &str = "Export as Markdown";
pub const EXPORT_MARKDOWN_FILTER: &str = "Markdown";
pub const EXPORT_HTML_TITLE: &str = "Export as HTML";
pub const EXPORT_HTML_FILTER: &str = "HTML";
pub const EXPORT_PDF_TITLE: &str = "Export as PDF";
pub const EXPORT_PDF_FILTER: &str = "PDF";
pub const MENU_EDIT: &str = "Edit";
pub const MENU_FORMAT: &str = "Format";
pub const FORMAT_BOLD: &str = "Bold";
pub const FORMAT_ITALIC: &str = "Italic";
pub const FORMAT_STRIKETHROUGH: &str = "Strikethrough";
pub const FORMAT_HIGHLIGHT: &str = "Highlight";
pub const FORMAT_INLINE_CODE: &str = "Inline Code";
pub const FORMAT_LINK: &str = "Link";
pub const FORMAT_HEADING: &str = "Heading";
pub const FORMAT_HEADING_1: &str = "Heading 1";
pub const FORMAT_HEADING_2: &str = "Heading 2";
pub const FORMAT_HEADING_3: &str = "Heading 3";
pub const FORMAT_HEADING_4: &str = "Heading 4";
pub const FORMAT_HEADING_5: &str = "Heading 5";
pub const FORMAT_HEADING_6: &str = "Heading 6";
pub const FORMAT_CODE_BLOCK: &str = "Code Block";
pub const FORMAT_BULLET_LIST: &str = "Bulleted List";
pub const FORMAT_NUMBERED_LIST: &str = "Numbered List";
pub const FORMAT_TASK_LIST: &str = "Task List";
pub const FORMAT_QUOTE: &str = "Quote";
pub const FORMAT_HORIZONTAL_RULE: &str = "Horizontal Rule";
pub const FORMAT_ALERT: &str = "Alert";
pub const FORMAT_ALERT_NOTE: &str = "Note";
pub const FORMAT_ALERT_TIP: &str = "Tip";
pub const FORMAT_ALERT_IMPORTANT: &str = "Important";
pub const FORMAT_ALERT_WARNING: &str = "Warning";
pub const FORMAT_ALERT_CAUTION: &str = "Caution";
pub const MENU_VIEW: &str = "View";
pub const REVISION_HISTORY: &str = "Revision History…";
pub const COMMAND_PALETTE: &str = "Command Palette…";
pub const ACTIVITY: &str = "Activity…";
pub const HIDE_SIDEBAR: &str = "Hide Sidebar";
pub const SHOW_SIDEBAR: &str = "Show Sidebar";
pub const TOGGLE_PREVIEW: &str = "Toggle Editor and Preview";
pub const SHOW_SPLIT: &str = "Show Editor and Preview";
pub const SYNC_SCROLL: &str = "Synced Scrolling";
pub const MENU_WINDOW: &str = "Window";
pub const MENU_HELP: &str = "Help";
pub const EXPORT_DIAGNOSTICS: &str = "Export Diagnostics…";
pub const QUIT: &str = "Quit Devot";
pub const SETTINGS: &str = "Settings…";
pub const BACKUPS: &str = "Backups…";
pub const SETTINGS_TITLE: &str = "Settings";
pub const MIRROR_FOLDER_TITLE: &str = "Choose a Folder for the Markdown Mirror";
pub const FONT_IMPORT_TITLE: &str = "Import a Font for the Editor";
/// The file type the font panel offers.
pub const FONT_FILTER: &str = "Fonts";
/// What a mirrored file edited outside Devot is kept as: `Plan (edited outside Devot).md`.
pub const MIRROR_EDITED_SUFFIX: &str = " (edited outside Devot)";
/// A launch that cannot open the notes (`startup.rs`): the alert's title,
/// what it says by the failure's kind, then where the notes are and the
/// code.
pub const STARTUP_FAILED_TITLE: &str = "Devot Can\u{2019}t Open Your Notes";
pub const STARTUP_IN_USE_TITLE: &str = "Devot Is Already Open";
pub const STARTUP_IN_USE: &str =
    "Another copy of Devot is using the same notes. Switch to it, or quit it and open Devot again.";
pub const STARTUP_NEWER_SCHEMA: &str =
    "They were saved by a newer version of Devot. Install the latest version to open them.";
pub const STARTUP_CORRUPT: &str = "The notes database is damaged. Devot keeps daily copies of it in the backups folder inside its data folder.";
pub const STARTUP_FULL: &str = "The disk is full. Free up some space, then open Devot again.";
pub const STARTUP_UNWRITABLE: &str = "Devot can\u{2019}t write to its data folder. Check that the disk is connected and that you may write to the folder.";
pub const STARTUP_BUSY: &str =
    "Another program kept the notes database busy. Open Devot again in a moment.";
pub const STARTUP_OTHER: &str = "Something went wrong while Devot was starting.";
/// The alert's last lines: the data folder (when its path is known) and the
/// code, filled in for `{folder}` and `{code}`.
pub const STARTUP_FOLDER: &str = "Data folder: {folder}";
pub const STARTUP_CODE: &str = "Code: {code}";
