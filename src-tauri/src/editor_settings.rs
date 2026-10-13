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
use tauri::{AppHandle, Emitter, State};

pub const FILE: &str = "editor-settings.json";
pub const CHANGED_EVENT: &str = "devot://editor-settings-changed";

pub const FONT_SIZE_MIN: u64 = 10;
pub const FONT_SIZE_MAX: u64 = 32;
pub const LINE_HEIGHT_MIN: f64 = 1.0;
pub const LINE_HEIGHT_MAX: f64 = 2.5;
pub const TAB_WIDTH_MIN: u64 = 1;
pub const TAB_WIDTH_MAX: u64 = 8;

const INVALID: &str = "E_EDITOR_SETTINGS_INVALID";

/// The editor's font: the system font or one of the monospaced system fonts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FontFamily {
    System,
    Mono,
    Menlo,
    Monaco,
    CourierNew,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    pub line_numbers: bool,
    pub line_wrapping: bool,
    pub readable_width: bool,
    pub font_size: u64,
    pub font_family: FontFamily,
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
}

impl Default for EditorSettings {
    /// The editor as it was before these settings existed (with SF Mono),
    /// the sidebar material on, synced scrolling on, and images shown under
    /// their lines.
    fn default() -> Self {
        Self {
            line_numbers: true,
            line_wrapping: true,
            readable_width: false,
            font_size: 13,
            font_family: FontFamily::Mono,
            line_height: 1.4,
            indent_unit: IndentUnit::Spaces2,
            tab_width: 4,
            list_marker: ListMarker::Dash,
            spell_check: false,
            highlight_active_line: true,
            sidebar_material: true,
            paste_url: PasteUrl::Plain,
            sync_scroll: true,
            inline_images: true,
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

fn choice<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, &'static str> {
    T::deserialize(value).map_err(|_| INVALID)
}

impl EditorSettings {
    /// Sets one value; refuses an unknown key or a value out of range.
    fn set(&mut self, key: &str, value: &Value) -> Result<(), &'static str> {
        match key {
            "lineNumbers" => self.line_numbers = flag(value)?,
            "lineWrapping" => self.line_wrapping = flag(value)?,
            "readableWidth" => self.readable_width = flag(value)?,
            "fontSize" => self.font_size = whole(value, FONT_SIZE_MIN, FONT_SIZE_MAX)?,
            "fontFamily" => self.font_family = choice(value)?,
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
    /// else takes its default.
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
    // JSON is a JavaScript literal; the values are booleans, numbers and a
    // few fixed words, so nothing in it can end the statement early.
    let json = serde_json::to_string(snapshot).unwrap_or_else(|_| String::from("null"));
    format!("window.{INITIAL_GLOBAL} = {json};")
}

/// The settings file. It is read on first use; a missing or unreadable file
/// means the defaults.
pub struct EditorSettingsStore {
    path: PathBuf,
    current: Mutex<Option<Snapshot>>,
}

impl EditorSettingsStore {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
            current: Mutex::new(None),
        }
    }

    fn read(&self) -> Snapshot {
        let settings = match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => EditorSettings::from_stored(&value),
                Err(_) => {
                    log::warn!("W_EDITOR_SETTINGS_UNREADABLE");
                    EditorSettings::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => EditorSettings::default(),
            Err(_) => {
                log::warn!("W_EDITOR_SETTINGS_READ_FAILED");
                EditorSettings::default()
            }
        };
        Snapshot {
            revision: 0,
            settings,
        }
    }

    /// The current settings.
    pub fn get(&self) -> Result<Snapshot, &'static str> {
        let mut held = self
            .current
            .lock()
            .map_err(|_| "E_EDITOR_SETTINGS_LOCK_FAILED")?;
        Ok(held.get_or_insert_with(|| self.read()).clone())
    }

    /// Applies `patch` and stores the result: a temporary file, flushed to
    /// disk, then renamed over the old one, so a crash or a power loss leaves
    /// either version whole. Returns the settings now in effect.
    pub fn update(&self, patch: &Map<String, Value>) -> Result<Snapshot, &'static str> {
        self.store_next(|now| now.with(patch))
    }

    /// Like `update`, with the change made from the current settings while
    /// no other change can come between (a menu item that toggles one).
    pub fn update_from(
        &self,
        change: impl FnOnce(&EditorSettings) -> Map<String, Value>,
    ) -> Result<Snapshot, &'static str> {
        self.store_next(|now| now.with(&change(now)))
    }

    /// Stores the settings `next` makes from the current ones (see `update`).
    fn store_next(
        &self,
        next: impl FnOnce(&EditorSettings) -> Result<EditorSettings, &'static str>,
    ) -> Result<Snapshot, &'static str> {
        let mut held = self
            .current
            .lock()
            .map_err(|_| "E_EDITOR_SETTINGS_LOCK_FAILED")?;
        let now = held.get_or_insert_with(|| self.read());
        let next = Snapshot {
            revision: now.revision + 1,
            settings: next(&now.settings)?,
        };
        let json = serde_json::to_vec_pretty(&next.settings)
            .map_err(|_| "E_EDITOR_SETTINGS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_EDITOR_SETTINGS_WRITE_FAILED")?;
        *held = Some(next.clone());
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
/// check items (View > Synced Scrolling) in line with them.
pub fn announce(app: &AppHandle, next: &Snapshot) {
    if app.emit(CHANGED_EVENT, next).is_err() {
        log::warn!("W_EDITOR_SETTINGS_EMIT_FAILED");
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
    fn defaults_keep_the_editor_as_it_was() {
        let d = EditorSettings::default();
        assert!(d.line_numbers && d.line_wrapping && d.highlight_active_line);
        assert!(!d.readable_width && !d.spell_check);
        assert_eq!(d.font_size, 13);
        assert_eq!(d.line_height, 1.4);
        assert_eq!(d.indent_unit, IndentUnit::Spaces2);
        assert_eq!(d.tab_width, 4);
        assert_eq!(d.list_marker, ListMarker::Dash);
        // The window shows the sidebar material unless turned off.
        assert!(d.sidebar_material);
        assert_eq!(d.paste_url, PasteUrl::Plain);
        // Split mode scrolls the editor and the preview together.
        assert!(d.sync_scroll);
        // Images show under their lines unless turned off.
        assert!(d.inline_images);
    }

    #[test]
    fn serializes_with_the_names_the_ui_reads() {
        let value = serde_json::to_value(EditorSettings::default()).unwrap();
        assert_eq!(
            value,
            json!({
                "lineNumbers": true,
                "lineWrapping": true,
                "readableWidth": false,
                "fontSize": 13,
                "fontFamily": "mono",
                "lineHeight": 1.4,
                "indentUnit": "spaces2",
                "tabWidth": 4,
                "listMarker": "-",
                "spellCheck": false,
                "highlightActiveLine": true,
                "sidebarMaterial": true,
                "pasteUrl": "plain",
                "syncScroll": true,
                "inlineImages": true,
            })
        );
    }

    #[test]
    fn accepts_every_valid_value() {
        let next = EditorSettings::default()
            .with(&patch(json!({
                "lineNumbers": false,
                "lineWrapping": false,
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
            })))
            .unwrap();
        assert_eq!(next.paste_url, PasteUrl::Link);
        assert!(!next.inline_images);
        assert!(!next.line_numbers && !next.line_wrapping && !next.highlight_active_line);
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
        for family in ["system", "mono", "menlo", "monaco"] {
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
            json!({ "lineHeight": 0.9 }),
            json!({ "lineHeight": 2.6 }),
            json!({ "lineHeight": "1.5" }),
            json!({ "indentUnit": "spaces3" }),
            json!({ "indentUnit": 2 }),
            json!({ "tabWidth": 0 }),
            json!({ "tabWidth": 9 }),
            json!({ "listMarker": "+" }),
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
            "listMarker": "+",
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
        assert_eq!(read.list_marker, ListMarker::Dash);
        assert_eq!(read.paste_url, PasteUrl::Plain);
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
