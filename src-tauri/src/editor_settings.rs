//! Editor settings (Settings > Editor): how the note editor looks and
//! behaves, plus the window's sidebar material (Settings > Appearance, see
//! `sidebar_material`). They are kept on this device only, in
//! `<app data>/editor-settings.json`, never in the notes database, so they
//! never sync and never go into backups.
//!
//! Rust holds them, so every window reads the same values: the Settings
//! window changes them, the main window changes the font size from the
//! keyboard, and after each change every window gets
//! `devot://editor-settings-changed` with the full settings (and a revision
//! number) and applies them at once. Each value is checked here (ranges for numbers, a fixed list for
//! the rest): a change with an unknown key or a bad value is refused as a
//! whole. Reading the file is lenient instead: a value that is missing or
//! out of range (a file from another Devot version, or edited by hand) falls
//! back to its default, and the other values are kept.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub const FILE: &str = "editor-settings.json";
pub const CHANGED_EVENT: &str = "devot://editor-settings-changed";

pub const FONT_SIZE_MIN: u64 = 10;
pub const FONT_SIZE_MAX: u64 = 32;
pub const LINE_HEIGHT_MIN: f64 = 1.0;
pub const LINE_HEIGHT_MAX: f64 = 2.5;
pub const TAB_WIDTH_MIN: u64 = 1;
pub const TAB_WIDTH_MAX: u64 = 8;
pub const CURSOR_SCROLL_MARGIN_MAX: u64 = 200;
/// The longest notebook ID the default notebook may name.
const NOTEBOOK_ID_MAX: usize = 64;

const INVALID: &str = "E_EDITOR_SETTINGS_INVALID";

/// The editor's font: the system font, one of the monospaced system fonts,
/// a font installed on this Mac (`installed_font`) or a font file the user
/// imported (`imported_font`, see `fonts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FontFamily {
    System,
    Mono,
    Menlo,
    Monaco,
    CourierNew,
    Installed,
    Imported,
}

/// What one level of indentation inserts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndentUnit {
    Tab,
    Spaces2,
    Spaces4,
}

/// The bullet a new list item gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ListMarker {
    #[serde(rename = "-")]
    Dash,
    #[serde(rename = "*")]
    Star,
    #[serde(rename = "+")]
    Plus,
}

/// The weight of the editor's text: the font's normal one or a CSS weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FontWeight {
    #[serde(rename = "normal")]
    Normal,
    #[serde(rename = "300")]
    W300,
    #[serde(rename = "400")]
    W400,
    #[serde(rename = "500")]
    W500,
    #[serde(rename = "600")]
    W600,
    #[serde(rename = "700")]
    W700,
}

/// How long lines wrap: never, always, everywhere but code blocks and
/// tables (prose), or everywhere but the code block or table under the caret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineWrapping {
    Off,
    All,
    Prose,
    UnwrapAtCursor,
}

/// What pasting a lone URL inserts: the URL as copied, an autolink
/// (`<url>`) or a link with empty text (`[](url)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PasteUrl {
    Plain,
    Autolink,
    Link,
}

/// The appearance the windows show (Settings > Appearance): the system's,
/// or always light or dark.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Appearance {
    System,
    Light,
    Dark,
}

/// The colour theme the windows show (Settings > Appearance): Devot's
/// default, or Ivory. The page applies it (the tokens read `data-theme` on
/// the root element); Rust validates and stores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    Default,
    Ivory,
}

impl Appearance {
    /// The theme a window takes: `None` follows the system.
    pub fn window_theme(self) -> Option<tauri::Theme> {
        match self {
            Self::System => None,
            Self::Light => Some(tauri::Theme::Light),
            Self::Dark => Some(tauri::Theme::Dark),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    pub line_numbers: bool,
    pub line_wrapping: LineWrapping,
    pub readable_width: bool,
    pub font_size: u64,
    pub font_family: FontFamily,
    /// The family name of the installed font the editor uses.
    pub installed_font: Option<String>,
    /// The file name of the imported font the editor uses (in `fonts::DIR`).
    pub imported_font: Option<String>,
    pub line_height: f64,
    pub indent_unit: IndentUnit,
    pub tab_width: u64,
    pub list_marker: ListMarker,
    pub spell_check: bool,
    pub highlight_active_line: bool,
    /// The window shows the sidebar material; off, the sidebar is opaque.
    pub sidebar_material: bool,
    pub paste_url: PasteUrl,
    /// Split mode keeps the editor and the preview at the same line
    /// (View > Synced Scrolling).
    pub sync_scroll: bool,
    /// Images (attachments) show under their lines in the editor.
    pub inline_images: bool,
    /// Light, Dark, or the system's appearance (the default).
    pub appearance: Appearance,
    /// Devot's default colour theme, or Ivory (which ignores the system accent).
    pub theme: Theme,
    /// The accent follows the macOS accent colour instead of Devot's palette.
    pub system_accent: bool,
    /// The toolbar shows over selected text and above the current table row.
    pub toolbar: bool,
    /// The editor scrolls past the end of the note.
    pub scroll_past_end: bool,
    /// Pixels kept above and below the cursor when it nears the edge.
    pub cursor_scroll_margin: u64,
    pub font_weight: FontWeight,
    /// Spaces, tabs and line breaks are drawn.
    pub show_invisibles: bool,
    /// Spaces and tabs at the end of a line are tinted.
    pub highlight_trailing_whitespace: bool,
    /// The preview's font size, in CSS pixels.
    pub preview_font_size: u64,
    /// The notebook a new note goes to when the view has none.
    pub default_notebook: Option<String>,
}

impl Default for EditorSettings {
    /// The editor's defaults (SF Mono), the sidebar material on, synced
    /// scrolling on, images shown under their lines, and the system's
    /// appearance with Devot's own theme and accent. A default applies only to a
    /// setting the user never set (see `EditorSettingsStore`).
    fn default() -> Self {
        Self {
            line_numbers: false,
            line_wrapping: LineWrapping::UnwrapAtCursor,
            readable_width: false,
            font_size: 13,
            font_family: FontFamily::Mono,
            installed_font: None,
            imported_font: None,
            line_height: 1.5,
            indent_unit: IndentUnit::Spaces2,
            tab_width: 2,
            list_marker: ListMarker::Star,
            spell_check: true,
            highlight_active_line: false,
            sidebar_material: true,
            paste_url: PasteUrl::Link,
            sync_scroll: true,
            inline_images: true,
            appearance: Appearance::System,
            theme: Theme::Default,
            system_accent: false,
            toolbar: true,
            scroll_past_end: true,
            cursor_scroll_margin: 0,
            font_weight: FontWeight::Normal,
            show_invisibles: false,
            highlight_trailing_whitespace: false,
            preview_font_size: 15,
            default_notebook: None,
        }
    }
}

fn flag(value: &Value) -> Result<bool, &'static str> {
    value.as_bool().ok_or(INVALID)
}

fn whole(value: &Value, min: u64, max: u64) -> Result<u64, &'static str> {
    value
        .as_u64()
        .filter(|n| (min..=max).contains(n))
        .ok_or(INVALID)
}

/// A notebook ID (a short run of letters, digits, `-` and `_`) or null.
fn notebook_id(value: &Value) -> Result<Option<String>, &'static str> {
    match value {
        Value::Null => Ok(None),
        Value::String(id)
            if !id.is_empty()
                && id.len() <= NOTEBOOK_ID_MAX
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            Ok(Some(id.clone()))
        }
        _ => Err(INVALID),
    }
}

/// A string that `valid` accepts, or null.
fn name_or_null(value: &Value, valid: fn(&str) -> bool) -> Result<Option<String>, &'static str> {
    match value {
        Value::Null => Ok(None),
        Value::String(name) if valid(name) => Ok(Some(name.clone())),
        _ => Err(INVALID),
    }
}

fn choice<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, &'static str> {
    T::deserialize(value).map_err(|_| INVALID)
}

impl EditorSettings {
    /// Sets one value; refuses an unknown key or a value out of range.
    fn set(&mut self, key: &str, value: &Value) -> Result<(), &'static str> {
        match key {
            "lineNumbers" => self.line_numbers = flag(value)?,
            "lineWrapping" => self.line_wrapping = choice(value)?,
            "readableWidth" => self.readable_width = flag(value)?,
            "fontSize" => self.font_size = whole(value, FONT_SIZE_MIN, FONT_SIZE_MAX)?,
            "fontFamily" => self.font_family = choice(value)?,
            "installedFont" => {
                self.installed_font = name_or_null(value, crate::fonts::valid_family_name)?
            }
            "importedFont" => self.imported_font = name_or_null(value, crate::fonts::valid_id)?,
            "lineHeight" => {
                self.line_height = value
                    .as_f64()
                    .filter(|n| (LINE_HEIGHT_MIN..=LINE_HEIGHT_MAX).contains(n))
                    .ok_or(INVALID)?
            }
            "indentUnit" => self.indent_unit = choice(value)?,
            "tabWidth" => self.tab_width = whole(value, TAB_WIDTH_MIN, TAB_WIDTH_MAX)?,
            "listMarker" => self.list_marker = choice(value)?,
            "spellCheck" => self.spell_check = flag(value)?,
            "highlightActiveLine" => self.highlight_active_line = flag(value)?,
            "sidebarMaterial" => self.sidebar_material = flag(value)?,
            "pasteUrl" => self.paste_url = choice(value)?,
            "syncScroll" => self.sync_scroll = flag(value)?,
            "inlineImages" => self.inline_images = flag(value)?,
            "appearance" => self.appearance = choice(value)?,
            "theme" => self.theme = choice(value)?,
            "systemAccent" => self.system_accent = flag(value)?,
            "toolbar" => self.toolbar = flag(value)?,
            "scrollPastEnd" => self.scroll_past_end = flag(value)?,
            "cursorScrollMargin" => {
                self.cursor_scroll_margin = whole(value, 0, CURSOR_SCROLL_MARGIN_MAX)?
            }
            "fontWeight" => self.font_weight = choice(value)?,
            "showInvisibles" => self.show_invisibles = flag(value)?,
            "highlightTrailingWhitespace" => self.highlight_trailing_whitespace = flag(value)?,
            "previewFontSize" => {
                self.preview_font_size = whole(value, FONT_SIZE_MIN, FONT_SIZE_MAX)?
            }
            "defaultNotebook" => self.default_notebook = notebook_id(value)?,
            _ => return Err(INVALID),
        }
        Ok(())
    }

    /// These settings with every change in `patch`, or an error code when any
    /// key is unknown or any value is invalid (then nothing changes).
    pub fn with(&self, patch: &Map<String, Value>) -> Result<Self, &'static str> {
        let mut next = self.clone();
        for (key, value) in patch {
            next.set(key, value)?;
        }
        Ok(next)
    }

    /// Settings read from a stored file: each valid value is kept, anything
    /// else takes its default (the store itself keeps the valid values
    /// apart, see `EditorSettingsStore::read`).
    #[cfg(test)]
    pub fn from_stored(value: &Value) -> Self {
        let mut out = Self::default();
        if let Value::Object(map) = value {
            for (key, value) in map {
                // A bad value keeps the default; the rest still apply.
                let _ = out.set(key, value);
            }
        }
        out
    }
}

/// The settings with their revision: it goes up by one with every stored
/// change (from 0 when Devot starts), so a window can tell which of two
/// events or answers is newer, whatever order they arrive in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub settings: EditorSettings,
}

/// The global a window's page starts its settings from.
pub const INITIAL_GLOBAL: &str = "devotInitialEditorSettings";

/// A script that runs before the page's own (an initialization script, which
/// the CSP does not apply to): it hands the page the settings the window was
/// built with, so its first paint matches them (the sidebar material, the
/// editor's font) instead of the defaults. The page still reads the settings
/// and takes any newer revision.
pub fn initial_script(snapshot: &Snapshot) -> String {
    // JSON is a JavaScript literal; the values are booleans, numbers, a few
    // fixed words and names checked when set (no quotes or backslashes), so
    // nothing in it can end the statement early.
    let json = serde_json::to_string(snapshot).unwrap_or_else(|_| String::from("null"));
    format!("window.{INITIAL_GLOBAL} = {json};")
}

/// What the store holds: the settings in effect and the values the user has
/// set (the only ones written to the file, so a default that changes later
/// still applies to every setting the user never touched).
struct Held {
    snapshot: Snapshot,
    stored: Map<String, Value>,
}

/// The settings file. It is read on first use; a missing or unreadable file
/// means the defaults.
pub struct EditorSettingsStore {
    path: PathBuf,
    current: Mutex<Option<Held>>,
}

impl EditorSettingsStore {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
            current: Mutex::new(None),
        }
    }

    fn read(&self) -> Held {
        let stored = match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Object(map)) => map,
                Ok(_) => Map::new(),
                Err(_) => {
                    log::warn!("W_EDITOR_SETTINGS_UNREADABLE");
                    Map::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
            Err(_) => {
                log::warn!("W_EDITOR_SETTINGS_READ_FAILED");
                Map::new()
            }
        };
        let mut stored = stored;
        // Line wrapping was on/off before it became a mode: on means
        // unwrap at cursor, off means off. The mode stays in `stored`, so
        // the next write replaces the old value.
        if let Some(old) = stored.get("lineWrapping").and_then(Value::as_bool) {
            let mode = if old { "unwrapAtCursor" } else { "off" };
            stored.insert("lineWrapping".into(), Value::from(mode));
        }
        // Only values that are valid and known stay in `stored`.
        let mut settings = EditorSettings::default();
        let stored = stored
            .into_iter()
            .filter(|(key, value)| settings.set(key, value).is_ok())
            .collect();
        Held {
            snapshot: Snapshot {
                revision: 0,
                settings,
            },
            stored,
        }
    }

    /// The current settings.
    pub fn get(&self) -> Result<Snapshot, &'static str> {
        let mut held = self
            .current
            .lock()
            .map_err(|_| "E_EDITOR_SETTINGS_LOCK_FAILED")?;
        Ok(held.get_or_insert_with(|| self.read()).snapshot.clone())
    }

    /// Applies `patch` and stores the result: a temporary file, flushed to
    /// disk, then renamed over the old one, so a crash or a power loss leaves
    /// either version whole. Returns the settings now in effect.
    pub fn update(&self, patch: &Map<String, Value>) -> Result<Snapshot, &'static str> {
        self.store_next(|_| patch.clone())
    }

    /// Like `update`, with the change made from the current settings while
    /// no other change can come between (a menu item that toggles one).
    pub fn update_from(
        &self,
        change: impl FnOnce(&EditorSettings) -> Map<String, Value>,
    ) -> Result<Snapshot, &'static str> {
        self.store_next(change)
    }

    /// Stores the change `patch_for` makes to the current settings (see
    /// `update`): the file holds the values the user set, and only those.
    fn store_next(
        &self,
        patch_for: impl FnOnce(&EditorSettings) -> Map<String, Value>,
    ) -> Result<Snapshot, &'static str> {
        let mut held = self
            .current
            .lock()
            .map_err(|_| "E_EDITOR_SETTINGS_LOCK_FAILED")?;
        let now = held.get_or_insert_with(|| self.read());
        let patch = patch_for(&now.snapshot.settings);
        let settings = now.snapshot.settings.with(&patch)?;
        let mut stored = now.stored.clone();
        stored.extend(patch);
        let next = Snapshot {
            revision: now.snapshot.revision + 1,
            settings,
        };
        let json =
            serde_json::to_vec_pretty(&stored).map_err(|_| "E_EDITOR_SETTINGS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_EDITOR_SETTINGS_WRITE_FAILED")?;
        *held = Some(Held {
            snapshot: next.clone(),
            stored,
        });
        Ok(next)
    }
}

/// The current editor settings (main and Settings windows).
#[tauri::command]
pub async fn editor_settings_get(
    store: State<'_, Arc<EditorSettingsStore>>,
) -> Result<Snapshot, String> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || store.get())
        .await
        .map_err(|_| "E_EDITOR_SETTINGS_TASK".to_string())?
        .map_err(String::from)
}

/// Tells every window about stored settings, and brings the menu bar's
/// check items (View > Synced Scrolling) in line with them. Every window
/// takes the chosen appearance, so its material, its controls and the page's
/// `prefers-color-scheme` match it.
pub fn announce(app: &AppHandle, next: &Snapshot) {
    if app.emit(CHANGED_EVENT, next).is_err() {
        log::warn!("W_EDITOR_SETTINGS_EMIT_FAILED");
    }
    let theme = next.settings.appearance.window_theme();
    for window in app.webview_windows().values() {
        if window.set_theme(theme).is_err() {
            log::warn!("W_WINDOW_THEME_FAILED");
        }
    }
    crate::menu::show_editor_settings(app, next);
}

/// The change View > Synced Scrolling stores: the opposite of the current value.
pub fn toggle_sync_scroll(settings: &EditorSettings) -> Map<String, Value> {
    let mut patch = Map::new();
    patch.insert("syncScroll".into(), Value::Bool(!settings.sync_scroll));
    patch
}

/// Changes some editor settings, stores them and tells every window (main
/// and Settings windows). Returns the settings now in effect. Two changes
/// may announce themselves out of order; their revisions tell them apart.
/// A change to synced scrolling is noted first, so the menu bar can tell
/// its echo of the key that made it (see `menu::MENU_ECHO`).
#[tauri::command]
pub async fn editor_settings_set(
    app: AppHandle,
    store: State<'_, Arc<EditorSettingsStore>>,
    patch: Map<String, Value>,
) -> Result<Snapshot, String> {
    if patch.contains_key("syncScroll") {
        crate::menu::sync_scroll_set_by_page(&app);
    }
    let store = Arc::clone(&store);
    let next = tauri::async_runtime::spawn_blocking(move || store.update(&patch))
        .await
        .map_err(|_| "E_EDITOR_SETTINGS_TASK".to_string())?
        .map_err(String::from)?;
    announce(&app, &next);
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    fn store(dir: &tempfile::TempDir) -> EditorSettingsStore {
        EditorSettingsStore::new(&dir.path().join(FILE))
    }

    #[test]
    fn defaults_are_roomy_and_helpful() {
        let d = EditorSettings::default();
        assert!(!d.line_numbers && !d.highlight_active_line);
        // Everything wraps except the code block or table under the caret.
        assert_eq!(d.line_wrapping, LineWrapping::UnwrapAtCursor);
        assert!(!d.readable_width && d.spell_check);
        assert_eq!(d.font_size, 13);
        assert_eq!(d.line_height, 1.5);
        assert_eq!(d.indent_unit, IndentUnit::Spaces2);
        assert_eq!(d.tab_width, 2);
        assert_eq!(d.list_marker, ListMarker::Star);
        // The window shows the sidebar material unless turned off.
        assert!(d.sidebar_material);
        assert_eq!(d.paste_url, PasteUrl::Link);
        assert!(d.toolbar && d.scroll_past_end);
        assert_eq!(d.cursor_scroll_margin, 0);
        assert_eq!(d.font_weight, FontWeight::Normal);
        assert!(!d.show_invisibles && !d.highlight_trailing_whitespace);
        assert_eq!(d.preview_font_size, 15);
        assert_eq!(d.default_notebook, None);
        // Split mode scrolls the editor and the preview together.
        assert!(d.sync_scroll);
        // Images show under their lines unless turned off.
        assert!(d.inline_images);
        // The system's appearance, with Devot's own accent.
        assert_eq!(d.appearance, Appearance::System);
        // Devot's own theme.
        assert_eq!(d.theme, Theme::Default);
        assert!(!d.system_accent);
    }

    #[test]
    fn serializes_with_the_names_the_ui_reads() {
        let value = serde_json::to_value(EditorSettings::default()).unwrap();
        assert_eq!(
            value,
            json!({
                "lineNumbers": false,
                "lineWrapping": "unwrapAtCursor",
                "readableWidth": false,
                "fontSize": 13,
                "fontFamily": "mono",
                "installedFont": null,
                "importedFont": null,
                "lineHeight": 1.5,
                "indentUnit": "spaces2",
                "tabWidth": 2,
                "listMarker": "*",
                "spellCheck": true,
                "highlightActiveLine": false,
                "sidebarMaterial": true,
                "pasteUrl": "link",
                "syncScroll": true,
                "inlineImages": true,
                "appearance": "system",
                "theme": "default",
                "systemAccent": false,
                "toolbar": true,
                "scrollPastEnd": true,
                "cursorScrollMargin": 0,
                "fontWeight": "normal",
                "showInvisibles": false,
                "highlightTrailingWhitespace": false,
                "previewFontSize": 15,
                "defaultNotebook": null,
            })
        );
    }

    #[test]
    fn accepts_every_valid_value() {
        let next = EditorSettings::default()
            .with(&patch(json!({
                "lineNumbers": false,
                "lineWrapping": "off",
                "readableWidth": true,
                "fontSize": 32,
                "fontFamily": "courierNew",
                "lineHeight": 2.5,
                "indentUnit": "tab",
                "tabWidth": 8,
                "listMarker": "*",
                "spellCheck": true,
                "highlightActiveLine": false,
                "sidebarMaterial": false,
                "pasteUrl": "link",
                "syncScroll": false,
                "inlineImages": false,
                "appearance": "dark",
                "theme": "ivory",
                "systemAccent": true,
                "toolbar": false,
                "scrollPastEnd": false,
                "cursorScrollMargin": 200,
                "fontWeight": "700",
                "showInvisibles": true,
                "highlightTrailingWhitespace": true,
                "previewFontSize": 32,
                "defaultNotebook": "0b0c-1d_2",
            })))
            .unwrap();
        assert_eq!(next.appearance, Appearance::Dark);
        assert_eq!(next.theme, Theme::Ivory);
        assert!(next.system_accent);
        for (appearance, theme) in [
            ("light", Some(tauri::Theme::Light)),
            ("dark", Some(tauri::Theme::Dark)),
            ("system", None),
        ] {
            let read = EditorSettings::default()
                .with(&patch(json!({ "appearance": appearance })))
                .unwrap();
            assert_eq!(read.appearance.window_theme(), theme);
        }
        assert!(!next.toolbar && !next.scroll_past_end);
        assert_eq!(next.cursor_scroll_margin, 200);
        assert_eq!(next.font_weight, FontWeight::W700);
        assert!(next.show_invisibles && next.highlight_trailing_whitespace);
        assert_eq!(next.preview_font_size, 32);
        assert_eq!(next.default_notebook.as_deref(), Some("0b0c-1d_2"));
        let plus = EditorSettings::default()
            .with(&patch(
                json!({ "listMarker": "+", "defaultNotebook": null }),
            ))
            .unwrap();
        assert_eq!(plus.list_marker, ListMarker::Plus);
        assert_eq!(plus.default_notebook, None);
        assert_eq!(next.paste_url, PasteUrl::Link);
        assert!(!next.inline_images);
        assert!(!next.line_numbers && !next.highlight_active_line);
        assert_eq!(next.line_wrapping, LineWrapping::Off);
        for (name, mode) in [
            ("off", LineWrapping::Off),
            ("all", LineWrapping::All),
            ("prose", LineWrapping::Prose),
            ("unwrapAtCursor", LineWrapping::UnwrapAtCursor),
        ] {
            let read = EditorSettings::default()
                .with(&patch(json!({ "lineWrapping": name })))
                .unwrap();
            assert_eq!(read.line_wrapping, mode);
        }
        assert!(!next.sidebar_material);
        assert!(!next.sync_scroll);
        assert!(next.readable_width && next.spell_check);
        assert_eq!(next.font_size, 32);
        assert_eq!(next.font_family, FontFamily::CourierNew);
        assert_eq!(next.line_height, 2.5);
        assert_eq!(next.indent_unit, IndentUnit::Tab);
        assert_eq!(next.tab_width, 8);
        assert_eq!(next.list_marker, ListMarker::Star);
        assert_eq!(
            EditorSettings::default()
                .with(&patch(json!({ "pasteUrl": "autolink" })))
                .unwrap()
                .paste_url,
            PasteUrl::Autolink
        );
        for family in ["system", "mono", "menlo", "monaco", "installed", "imported"] {
            assert!(
                EditorSettings::default()
                    .with(&patch(json!({ "fontFamily": family })))
                    .is_ok()
            );
        }
        let low = EditorSettings::default()
            .with(&patch(
                json!({ "fontSize": 10, "lineHeight": 1, "tabWidth": 1 }),
            ))
            .unwrap();
        assert_eq!(
            (low.font_size, low.line_height, low.tab_width),
            (10, 1.0, 1)
        );
    }

    #[test]
    fn takes_an_installed_or_imported_font_and_clears_it_with_null() {
        let next = EditorSettings::default()
            .with(&patch(json!({
                "fontFamily": "imported",
                "installedFont": "Fira Code",
                "importedFont": "\u{9716}\u{9e5c} Mono.woff2",
            })))
            .unwrap();
        assert_eq!(next.font_family, FontFamily::Imported);
        assert_eq!(next.installed_font.as_deref(), Some("Fira Code"));
        assert_eq!(
            next.imported_font.as_deref(),
            Some("\u{9716}\u{9e5c} Mono.woff2")
        );
        let cleared = next
            .with(&patch(
                json!({ "installedFont": null, "importedFont": null }),
            ))
            .unwrap();
        assert_eq!(
            (cleared.installed_font, cleared.imported_font),
            (None, None)
        );
    }

    #[test]
    fn refuses_unknown_keys_and_bad_values_as_a_whole() {
        let bad = [
            json!({ "theme": "dark" }),
            json!({ "lineNumbers": "yes" }),
            json!({ "lineNumbers": 1 }),
            json!({ "fontSize": 9 }),
            json!({ "fontSize": 33 }),
            json!({ "fontSize": 13.5 }),
            json!({ "fontSize": -13 }),
            json!({ "fontSize": "13" }),
            json!({ "fontFamily": "Comic Sans MS" }),
            json!({ "fontFamily": "url(https://example.com/x.woff)" }),
            json!({ "fontFamily": null }),
            json!({ "installedFont": "" }),
            json!({ "installedFont": "Fira\"; } body { color: red" }),
            json!({ "installedFont": ".AppleSystemUIFont" }),
            json!({ "installedFont": 3 }),
            json!({ "importedFont": "../editor-settings.json" }),
            json!({ "importedFont": "font.exe" }),
            json!({ "importedFont": "Fira Code.TTF" }),
            json!({ "lineHeight": 0.9 }),
            json!({ "lineHeight": 2.6 }),
            json!({ "lineHeight": "1.5" }),
            json!({ "indentUnit": "spaces3" }),
            json!({ "indentUnit": 2 }),
            json!({ "tabWidth": 0 }),
            json!({ "tabWidth": 9 }),
            json!({ "listMarker": "#" }),
            json!({ "toolbar": "on" }),
            json!({ "scrollPastEnd": null }),
            json!({ "cursorScrollMargin": 201 }),
            json!({ "cursorScrollMargin": -1 }),
            json!({ "fontWeight": "bold" }),
            json!({ "fontWeight": 400 }),
            json!({ "showInvisibles": 1 }),
            json!({ "highlightTrailingWhitespace": "yes" }),
            json!({ "previewFontSize": 9 }),
            json!({ "previewFontSize": 33 }),
            json!({ "defaultNotebook": "" }),
            json!({ "defaultNotebook": "a b" }),
            json!({ "defaultNotebook": 5 }),
            json!({ "defaultNotebook": "x".repeat(65) }),
            json!({ "listMarker": "- " }),
            json!({ "pasteUrl": "markdown" }),
            json!({ "pasteUrl": "Plain" }),
            json!({ "pasteUrl": true }),
            json!({ "spellCheck": null }),
            json!({ "highlightActiveLine": [] }),
            json!({ "sidebarMaterial": "off" }),
            json!({ "sidebarMaterial": 0 }),
            json!({ "sidebarMaterial": null }),
            json!({ "syncScroll": "off" }),
            json!({ "syncScroll": 0 }),
            json!({ "inlineImages": "on" }),
            json!({ "inlineImages": 1 }),
            json!({ "inlineImages": null }),
            json!({ "appearance": "auto" }),
            json!({ "appearance": "Dark" }),
            json!({ "appearance": true }),
            json!({ "theme": "Ivory" }),
            json!({ "theme": "dark" }),
            json!({ "theme": "" }),
            json!({ "theme": null }),
            json!({ "theme": 1 }),
            json!({ "systemAccent": "on" }),
            // Line wrapping is a mode; the old on/off values are refused.
            json!({ "lineWrapping": true }),
            json!({ "lineWrapping": false }),
            json!({ "lineWrapping": "unwrap-at-cursor" }),
            json!({ "lineWrapping": "On" }),
            json!({ "lineWrapping": null }),
            // One bad value spoils the good ones with it.
            json!({ "lineNumbers": false, "fontSize": 99 }),
        ];
        for value in bad {
            assert_eq!(
                EditorSettings::default().with(&patch(value.clone())),
                Err(INVALID),
                "{value}"
            );
        }
    }

    #[test]
    fn reads_a_stored_file_value_by_value() {
        let stored = json!({
            "lineNumbers": false,
            "fontSize": 99,
            "fontFamily": "menlo",
            "listMarker": "#",
            "sidebarMaterial": "no",
            "pasteUrl": "html",
            "syncScroll": false,
            "someFutureSetting": true,
        });
        let read = EditorSettings::from_stored(&stored);
        assert!(!read.line_numbers);
        assert!(read.sidebar_material);
        assert!(!read.sync_scroll);
        assert_eq!(read.font_family, FontFamily::Menlo);
        // Bad values take their defaults.
        assert_eq!(read.font_size, 13);
        assert_eq!(read.list_marker, ListMarker::Star);
        assert_eq!(read.paste_url, PasteUrl::Link);
        assert_eq!(
            EditorSettings::from_stored(&json!([1, 2])),
            EditorSettings::default()
        );
    }

    #[test]
    fn sends_the_revision_with_the_settings() {
        let snapshot = Snapshot {
            revision: 3,
            settings: EditorSettings::default(),
        };
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["revision"], json!(3));
        assert_eq!(value["settings"]["fontSize"], json!(13));
    }

    #[test]
    fn hands_the_page_the_settings_the_window_was_built_with() {
        let snapshot = Snapshot {
            revision: 0,
            settings: EditorSettings {
                sidebar_material: false,
                ..EditorSettings::default()
            },
        };
        let script = initial_script(&snapshot);
        let json = script
            .strip_prefix("window.devotInitialEditorSettings = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .expect("one assignment");
        let value: Value = serde_json::from_str(json).unwrap();
        assert_eq!(value, serde_json::to_value(&snapshot).unwrap());
        assert_eq!(value["settings"]["sidebarMaterial"], json!(false));
    }

    #[test]
    fn starts_from_the_defaults_without_a_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            store(&dir).get().unwrap(),
            Snapshot {
                revision: 0,
                settings: EditorSettings::default()
            }
        );
        assert!(!dir.path().join(FILE).exists());
    }

    #[test]
    fn keeps_the_chosen_theme_after_reopening() {
        let dir = tempfile::tempdir().unwrap();
        store(&dir)
            .update(&patch(json!({ "theme": "ivory", "appearance": "dark" })))
            .unwrap();
        let read = store(&dir).get().unwrap().settings;
        assert_eq!(read.theme, Theme::Ivory);
        assert_eq!(read.appearance, Appearance::Dark);
        // A refused theme changes nothing.
        let held = store(&dir);
        assert_eq!(
            held.update(&patch(json!({ "theme": "other" }))),
            Err(INVALID)
        );
        assert_eq!(held.get().unwrap().settings.theme, Theme::Ivory);
    }

    #[test]
    fn reads_an_unknown_stored_theme_as_the_default_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(FILE),
            br#"{ "theme": "other", "appearance": "light" }"#,
        )
        .unwrap();
        let held = store(&dir);
        let read = held.get().unwrap().settings;
        assert_eq!(read.theme, Theme::Default);
        // The settings beside it still apply.
        assert_eq!(read.appearance, Appearance::Light);
        // The stored value is dropped, not carried into the next write.
        held.update(&patch(json!({ "lineNumbers": true }))).unwrap();
        let file = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(!file.contains("other"), "{file}");
        // A stored file reads the same value by value.
        assert_eq!(
            EditorSettings::from_stored(&json!({ "theme": "ivory", "fontSize": 99 })).theme,
            Theme::Ivory
        );
        assert_eq!(
            EditorSettings::from_stored(&json!({ "theme": 7 })).theme,
            Theme::Default
        );
    }

    #[test]
    fn reads_an_old_on_off_line_wrapping_as_a_mode_and_stores_it() {
        let dir = tempfile::tempdir().unwrap();
        for (old, mode, name) in [
            ("true", LineWrapping::UnwrapAtCursor, "unwrapAtCursor"),
            ("false", LineWrapping::Off, "off"),
        ] {
            std::fs::write(
                dir.path().join(FILE),
                format!(r#"{{ "lineWrapping": {old}, "tabWidth": 4 }}"#),
            )
            .unwrap();
            let held = store(&dir);
            let read = held.get().unwrap().settings;
            assert_eq!(read.line_wrapping, mode, "{old}");
            assert_eq!(read.tab_width, 4);
            // The next write stores the mode in place of the old value.
            held.update(&patch(json!({ "lineNumbers": true }))).unwrap();
            let written: Value =
                serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
            assert_eq!(
                written,
                json!({ "lineWrapping": name, "tabWidth": 4, "lineNumbers": true })
            );
        }
        // An unknown stored mode takes the default and is dropped.
        std::fs::write(dir.path().join(FILE), br#"{ "lineWrapping": "sometimes" }"#).unwrap();
        let held = store(&dir);
        assert_eq!(
            held.get().unwrap().settings.line_wrapping,
            LineWrapping::UnwrapAtCursor
        );
        held.update(&patch(json!({ "lineNumbers": true }))).unwrap();
        let file = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(!file.contains("sometimes"), "{file}");
    }

    #[test]
    fn keeps_the_chosen_font_after_reopening() {
        let dir = tempfile::tempdir().unwrap();
        store(&dir)
            .update(&patch(
                json!({ "fontFamily": "installed", "installedFont": "PT Mono" }),
            ))
            .unwrap();
        let read = store(&dir).get().unwrap().settings;
        assert_eq!(read.font_family, FontFamily::Installed);
        assert_eq!(read.installed_font.as_deref(), Some("PT Mono"));
        assert_eq!(read.imported_font, None);
    }

    #[test]
    fn stores_changes_and_reads_them_back_after_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let first = store(&dir);
        let next = first
            .update(&patch(json!({ "fontSize": 16, "listMarker": "*" })))
            .unwrap();
        assert_eq!(next.revision, 1);
        assert_eq!(next.settings.font_size, 16);
        assert_eq!(first.get().unwrap(), next);
        let later = first.update(&patch(json!({ "spellCheck": true }))).unwrap();
        // Each change counts, and earlier changes stay.
        assert_eq!(later.revision, 2);
        assert_eq!(later.settings.font_size, 16);
        assert!(later.settings.spell_check);
        let reopened = store(&dir).get().unwrap();
        assert_eq!(reopened.settings, later.settings);
        // No temporary file is left behind.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [FILE]);
    }

    #[test]
    fn writes_only_what_the_user_set_so_new_defaults_apply_to_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        store(&dir)
            .update(&patch(json!({ "fontSize": 16 })))
            .unwrap();
        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(written, json!({ "fontSize": 16 }));
        // Another change adds its key and keeps the first.
        store(&dir)
            .update(&patch(json!({ "lineHeight": 1.8 })))
            .unwrap();
        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(written, json!({ "fontSize": 16, "lineHeight": 1.8 }));
        // A value stored by an older Devot is kept; unset ones take the defaults.
        std::fs::write(
            dir.path().join(FILE),
            br#"{ "lineHeight": 1.4, "tabWidth": 4 }"#,
        )
        .unwrap();
        let read = store(&dir).get().unwrap().settings;
        assert_eq!((read.line_height, read.tab_width), (1.4, 4));
        assert_eq!(read.list_marker, ListMarker::Star);
        assert!(read.spell_check);
    }

    #[test]
    fn remembers_an_opaque_sidebar() {
        let dir = tempfile::tempdir().unwrap();
        let next = store(&dir)
            .update(&patch(json!({ "sidebarMaterial": false })))
            .unwrap();
        assert!(!next.settings.sidebar_material);
        assert!(!store(&dir).get().unwrap().settings.sidebar_material);
        // A file written before the setting existed keeps the material.
        std::fs::write(dir.path().join(FILE), br#"{ "fontSize": 15 }"#).unwrap();
        let older = store(&dir).get().unwrap().settings;
        assert!(older.sidebar_material);
        assert_eq!(older.font_size, 15);
    }

    #[test]
    fn toggles_synced_scrolling_from_the_stored_value() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        let off = s.update_from(toggle_sync_scroll).unwrap();
        assert!(!off.settings.sync_scroll);
        assert!(!store(&dir).get().unwrap().settings.sync_scroll);
        let on = s.update_from(toggle_sync_scroll).unwrap();
        assert!(on.settings.sync_scroll);
        assert_eq!(on.revision, 2);
    }

    #[test]
    fn a_refused_change_leaves_memory_and_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        s.update(&patch(json!({ "fontSize": 18 }))).unwrap();
        let before = std::fs::read(dir.path().join(FILE)).unwrap();
        assert_eq!(
            s.update(&patch(json!({ "fontSize": 20, "tabWidth": 0 }))),
            Err(INVALID)
        );
        let now = s.get().unwrap();
        assert_eq!((now.revision, now.settings.font_size), (1, 18));
        assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), before);
    }

    #[test]
    fn a_damaged_file_means_the_defaults_and_is_replaced_on_the_next_change() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), b"{ not json").unwrap();
        let s = store(&dir);
        assert_eq!(s.get().unwrap().settings, EditorSettings::default());
        s.update(&patch(json!({ "lineNumbers": false }))).unwrap();
        assert!(!store(&dir).get().unwrap().settings.line_numbers);
    }

    #[test]
    fn a_failed_write_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        // The settings "file" is a folder: it cannot be replaced.
        std::fs::create_dir(dir.path().join(FILE)).unwrap();
        let s = store(&dir);
        assert_eq!(
            s.update(&patch(json!({ "fontSize": 20 }))),
            Err("E_EDITOR_SETTINGS_WRITE_FAILED")
        );
        let now = s.get().unwrap();
        assert_eq!((now.revision, now.settings.font_size), (0, 13));
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link_at_a_temporary_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        std::fs::write(&theirs, b"theirs").unwrap();
        // The name the settings once went to first.
        std::os::unix::fs::symlink(&theirs, dir.path().join(format!("{FILE}.partial"))).unwrap();
        store(&dir)
            .update(&patch(json!({ "fontSize": 16 })))
            .unwrap();
        let path = dir.path().join(FILE);
        assert!(std::fs::symlink_metadata(&path).unwrap().is_file());
        assert_eq!(store(&dir).get().unwrap().settings.font_size, 16);
        assert_eq!(std::fs::read(&theirs).unwrap(), b"theirs");
    }
}
