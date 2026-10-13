//! Keyboard shortcuts the user changed (Settings > Keyboard Shortcuts). The
//! command registry (`src/renderer/src/commands/registry.ts`) declares every
//! command with its default keys; this keeps only the changes: a command's
//! keys in place of its defaults (an empty list: no key). They are kept on
//! this device only, in `<app data>/keyboard-shortcuts.json`, never in the
//! notes database, so they never sync and never go into backups.
//!
//! As with the editor settings, Rust holds them so every window reads the
//! same: the Settings window changes them, and after each change every window
//! gets `devot://keyboard-shortcuts-changed` with all of them (and a revision
//! number) and rebinds its keys and menus at once.
//!
//! Checked here: command IDs look like the registry's (`format.bold`), keys
//! are in the registry's key notation in canonical order (`Mod+Ctrl+Alt+Shift`
//! then a key), never a key macOS or the app menu keeps (`RESERVED`) nor
//! Escape, at most four per command, each once. What only the registry
//! knows (which commands exist, where their keys apply, clashes between
//! them) the UI checks, and it ignores a stored change it cannot use. A
//! change with anything invalid is refused as a whole; reading the file is
//! lenient instead (an invalid entry is dropped, the rest are kept).

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub const FILE: &str = "keyboard-shortcuts.json";
pub const CHANGED_EVENT: &str = "devot://keyboard-shortcuts-changed";

/// At most this many keys per command.
pub const MAX_KEYS: usize = 4;
/// At most this many changed commands (the registry has fewer than 100).
pub const MAX_COMMANDS: usize = 256;
const MAX_ID_LEN: usize = 64;

const INVALID: &str = "E_KEYBOARD_SHORTCUTS_INVALID";

/// Keys macOS or the app menu keep for themselves; the registry's
/// `RESERVED_KEYS` lists the same (a policy test compares them).
pub const RESERVED: &[&str] = &[
    "Mod+Q",
    "Mod+H",
    "Mod+Alt+H",
    "Mod+M",
    "Mod+W",
    "Mod+,",
    "Mod+Tab",
    "Mod+Space",
    "Mod+Ctrl+F",
    "Mod+Ctrl+Space",
    "Mod+Ctrl+Q",
    "Mod+Ctrl+D",
];

const MODIFIERS: [&str; 4] = ["Mod", "Ctrl", "Alt", "Shift"];

const NAMED: &[&str] = &[
    "Enter",
    "Backspace",
    "Delete",
    "Tab",
    "Space",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
];

/// Whether `key` is a key the notation writes (Escape is never a shortcut).
fn known_key(key: &str) -> bool {
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => {
            c.is_ascii_uppercase() || c.is_ascii_digit() || ".,/;'[]\\-=`".contains(c)
        }
        _ => {
            NAMED.contains(&key)
                || key
                    .strip_prefix('F')
                    .and_then(|n| n.parse::<u8>().ok())
                    .is_some_and(|n| (1..=12).contains(&n) && !key.starts_with("F0"))
        }
    }
}

/// Whether `shortcut` is a key in canonical notation a command may take.
pub fn valid_shortcut(shortcut: &str) -> bool {
    if shortcut.len() > MAX_ID_LEN || RESERVED.contains(&shortcut) {
        return false;
    }
    let (modifiers, key) = match shortcut.rsplit_once('+') {
        Some((modifiers, key)) => (Some(modifiers), key),
        None => (None, shortcut),
    };
    // Modifiers in canonical order, each once.
    let mut next = 0;
    for part in modifiers.into_iter().flat_map(|m| m.split('+')) {
        match MODIFIERS[next..].iter().position(|m| *m == part) {
            Some(at) => next += at + 1,
            None => return false,
        }
    }
    known_key(key)
}

/// Whether `id` looks like a registry command ID: dotted camelCase words.
pub fn valid_command_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.contains('.')
        && id.split('.').all(|word| {
            let mut chars = word.chars();
            chars.next().is_some_and(|c| c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_alphanumeric())
        })
}

/// A command's keys, checked.
fn keys_of(value: &Value) -> Result<Vec<String>, &'static str> {
    let list = value.as_array().ok_or(INVALID)?;
    if list.len() > MAX_KEYS {
        return Err(INVALID);
    }
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for key in list {
        let key = key.as_str().filter(|k| valid_shortcut(k)).ok_or(INVALID)?;
        if out.iter().any(|k| k == key) {
            return Err(INVALID);
        }
        out.push(key.to_owned());
    }
    Ok(out)
}

/// The commands the user changed, by ID, with their keys.
pub type Overrides = BTreeMap<String, Vec<String>>;

/// `overrides` with `patch` applied: new keys for a command, or null to give
/// it its defaults again. Anything invalid refuses the whole patch.
pub fn with_patch(
    overrides: &Overrides,
    patch: &Map<String, Value>,
) -> Result<Overrides, &'static str> {
    let mut next = overrides.clone();
    for (id, value) in patch {
        if !valid_command_id(id) {
            return Err(INVALID);
        }
        if value.is_null() {
            next.remove(id);
        } else {
            next.insert(id.clone(), keys_of(value)?);
        }
    }
    if next.len() > MAX_COMMANDS {
        return Err(INVALID);
    }
    Ok(next)
}

/// Overrides read from a stored file: each valid entry is kept, the rest dropped.
pub fn from_stored(value: &Value) -> Overrides {
    let mut out = Overrides::new();
    if let Value::Object(map) = value {
        for (id, keys) in map {
            if out.len() == MAX_COMMANDS {
                break;
            }
            if let (true, Ok(keys)) = (valid_command_id(id), keys_of(keys)) {
                out.insert(id.clone(), keys);
            }
        }
    }
    out
}

/// The overrides with their revision: it goes up by one with every stored
/// change (from 0 when Devot starts), so a window can tell which of two
/// events or answers is newer, whatever order they arrive in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub overrides: Overrides,
}

/// The shortcuts file. It is read on first use; a missing or unreadable
/// file means no changes.
pub struct KeyboardShortcutsStore {
    path: PathBuf,
    current: Mutex<Option<Snapshot>>,
}

impl KeyboardShortcutsStore {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
            current: Mutex::new(None),
        }
    }

    fn read(&self) -> Snapshot {
        let overrides = match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => from_stored(&value),
                Err(_) => {
                    log::warn!("W_KEYBOARD_SHORTCUTS_UNREADABLE");
                    Overrides::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Overrides::new(),
            Err(_) => {
                log::warn!("W_KEYBOARD_SHORTCUTS_READ_FAILED");
                Overrides::new()
            }
        };
        Snapshot {
            revision: 0,
            overrides,
        }
    }

    /// The current overrides.
    pub fn get(&self) -> Result<Snapshot, &'static str> {
        let mut held = self
            .current
            .lock()
            .map_err(|_| "E_KEYBOARD_SHORTCUTS_LOCK_FAILED")?;
        Ok(held.get_or_insert_with(|| self.read()).clone())
    }

    /// Applies `patch` and stores the result (see
    /// `atomic_file::write_replacing`). Returns the overrides now in effect.
    pub fn update(&self, patch: &Map<String, Value>) -> Result<Snapshot, &'static str> {
        let mut held = self
            .current
            .lock()
            .map_err(|_| "E_KEYBOARD_SHORTCUTS_LOCK_FAILED")?;
        let now = held.get_or_insert_with(|| self.read());
        let next = Snapshot {
            revision: now.revision + 1,
            overrides: with_patch(&now.overrides, patch)?,
        };
        let json = serde_json::to_vec_pretty(&next.overrides)
            .map_err(|_| "E_KEYBOARD_SHORTCUTS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_KEYBOARD_SHORTCUTS_WRITE_FAILED")?;
        *held = Some(next.clone());
        Ok(next)
    }
}

/// The keyboard shortcuts the user changed (main and Settings windows).
#[tauri::command]
pub async fn keyboard_shortcuts_get(
    store: State<'_, Arc<KeyboardShortcutsStore>>,
) -> Result<Snapshot, String> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || store.get())
        .await
        .map_err(|_| "E_KEYBOARD_SHORTCUTS_TASK".to_string())?
        .map_err(String::from)
}

/// Changes some commands' keys (null: back to the defaults), stores them and
/// tells every window (main and Settings windows). Returns the overrides now
/// in effect.
#[tauri::command]
pub async fn keyboard_shortcuts_set(
    app: AppHandle,
    store: State<'_, Arc<KeyboardShortcutsStore>>,
    patch: Map<String, Value>,
) -> Result<Snapshot, String> {
    let store = Arc::clone(&store);
    let next = tauri::async_runtime::spawn_blocking(move || store.update(&patch))
        .await
        .map_err(|_| "E_KEYBOARD_SHORTCUTS_TASK".to_string())?
        .map_err(String::from)?;
    if app.emit(CHANGED_EVENT, &next).is_err() {
        log::warn!("W_KEYBOARD_SHORTCUTS_EMIT_FAILED");
    }
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

    fn store(dir: &tempfile::TempDir) -> KeyboardShortcutsStore {
        KeyboardShortcutsStore::new(&dir.path().join(FILE))
    }

    #[test]
    fn accepts_keys_in_canonical_notation() {
        for key in [
            "Mod+B",
            "Mod+Ctrl+Alt+Shift+K",
            "Mod+Shift+[",
            "Mod+Alt+=",
            "Ctrl+Tab",
            "Shift+F3",
            "F12",
            "M",
            "/",
            "Backspace",
            "Mod+Backspace",
            "Alt+ArrowUp",
            "Mod+Enter",
            "Ctrl+Space",
            "Mod+\\",
            "Mod+`",
        ] {
            assert!(valid_shortcut(key), "{key}");
        }
    }

    #[test]
    fn refuses_other_notations_reserved_keys_and_escape() {
        for key in [
            "",
            "+",
            "Mod+",
            "Mod",
            "Shift+Mod+K",
            "Alt+Ctrl+K",
            "Mod+Mod+K",
            "Cmd+K",
            "CmdOrCtrl+K",
            "mod+k",
            "Mod+k",
            "Mod+KK",
            "Mod++",
            "Mod+F13",
            "Mod+F0",
            "Mod+F01",
            "Escape",
            "Mod+Escape",
            "Mod+\u{e9}",
            "Mod+K ",
            " Mod+K",
            "Mod+Q",
            "Mod+H",
            "Mod+,",
            "Mod+Tab",
            "Mod+Space",
            "Mod+Ctrl+F",
            &"Shift+".repeat(20),
        ] {
            assert!(!valid_shortcut(key), "{key:?}");
        }
    }

    #[test]
    fn knows_registry_command_ids() {
        for id in [
            "format.bold",
            "note.newFromTemplate",
            "view.fontBigger",
            "a.b.c1",
        ] {
            assert!(valid_command_id(id), "{id}");
        }
        for id in [
            "",
            "format",
            "Format.bold",
            "format.Bold",
            "format..bold",
            ".format",
            "format.",
            "format.bold-face",
            "format.1bold",
            "format.b\u{f6}ld",
            &format!("a.{}", "b".repeat(70)),
        ] {
            assert!(!valid_command_id(id), "{id:?}");
        }
    }

    #[test]
    fn applies_a_patch_and_refuses_a_bad_one_as_a_whole() {
        let start = with_patch(
            &Overrides::new(),
            &patch(json!({ "format.bold": ["Mod+Alt+B"], "note.copyId": ["Mod+Alt+I", "P"] })),
        )
        .unwrap();
        assert_eq!(start["format.bold"], ["Mod+Alt+B"]);
        assert_eq!(start["note.copyId"], ["Mod+Alt+I", "P"]);
        // Null gives the defaults back; an empty list means no key.
        let next = with_patch(
            &start,
            &patch(json!({ "format.bold": null, "format.italic": [] })),
        )
        .unwrap();
        assert!(!next.contains_key("format.bold"));
        assert_eq!(next["format.italic"], Vec::<String>::new());
        for bad in [
            json!({ "format.bold": "Mod+B" }),
            json!({ "format.bold": [1] }),
            json!({ "format.bold": ["Mod+B", "Mod+B"] }),
            json!({ "format.bold": ["Mod+1", "Mod+2", "Mod+3", "Mod+4", "Mod+5"] }),
            json!({ "format.bold": ["Mod+Q"] }),
            json!({ "format.bold": ["Escape"] }),
            json!({ "format.bold": {} }),
            json!({ "Bold": ["Mod+B"] }),
            // One bad entry spoils the good ones with it.
            json!({ "format.italic": ["Mod+I"], "format.bold": ["Hyper+B"] }),
        ] {
            assert_eq!(
                with_patch(&start, &patch(bad.clone())),
                Err(INVALID),
                "{bad}"
            );
        }
        let many: Map<String, Value> = (0..=MAX_COMMANDS)
            .map(|i| (format!("probe.c{i}"), json!([])))
            .collect();
        assert_eq!(with_patch(&Overrides::new(), &many), Err(INVALID));
    }

    #[test]
    fn reads_a_stored_file_entry_by_entry() {
        let read = from_stored(&json!({
            "format.bold": ["Mod+Alt+B"],
            "format.italic": ["Mod+Q"],
            "note.pin": "P",
            "Not An Id": ["Mod+J"],
            "note.copyId": [],
        }));
        assert_eq!(
            read,
            Overrides::from([
                ("format.bold".to_owned(), vec!["Mod+Alt+B".to_owned()]),
                ("note.copyId".to_owned(), vec![]),
            ])
        );
        assert_eq!(from_stored(&json!([1, 2])), Overrides::new());
    }

    #[test]
    fn sends_the_revision_with_the_overrides() {
        let snapshot = Snapshot {
            revision: 2,
            overrides: Overrides::from([("format.bold".to_owned(), vec!["Mod+Alt+B".to_owned()])]),
        };
        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            json!({ "revision": 2, "overrides": { "format.bold": ["Mod+Alt+B"] } })
        );
    }

    #[test]
    fn starts_without_changes_and_without_a_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            store(&dir).get().unwrap(),
            Snapshot {
                revision: 0,
                overrides: Overrides::new()
            }
        );
        assert!(!dir.path().join(FILE).exists());
    }

    #[test]
    fn stores_changes_and_reads_them_back_after_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let first = store(&dir);
        let next = first
            .update(&patch(json!({ "view.focus": ["Mod+Alt+J"] })))
            .unwrap();
        assert_eq!(next.revision, 1);
        let later = first
            .update(&patch(
                json!({ "palette.open": [], "format.bold": ["Mod+P"] }),
            ))
            .unwrap();
        assert_eq!(later.revision, 2);
        assert_eq!(later.overrides.len(), 3);
        let reopened = store(&dir).get().unwrap();
        assert_eq!(reopened.overrides, later.overrides);
        // Reset all: every change goes.
        let reset = first
            .update(&patch(
                json!({ "view.focus": null, "palette.open": null, "format.bold": null }),
            ))
            .unwrap();
        assert!(reset.overrides.is_empty());
        assert!(store(&dir).get().unwrap().overrides.is_empty());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [FILE]);
    }

    #[test]
    fn a_refused_change_leaves_memory_and_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        s.update(&patch(json!({ "view.focus": ["Mod+Alt+J"] })))
            .unwrap();
        let before = std::fs::read(dir.path().join(FILE)).unwrap();
        assert_eq!(
            s.update(&patch(json!({ "view.focus": ["Mod+H"] }))),
            Err(INVALID)
        );
        let now = s.get().unwrap();
        assert_eq!(now.revision, 1);
        assert_eq!(now.overrides["view.focus"], ["Mod+Alt+J"]);
        assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), before);
    }

    #[test]
    fn a_damaged_file_means_no_changes_and_is_replaced_on_the_next_change() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), b"{ not json").unwrap();
        let s = store(&dir);
        assert!(s.get().unwrap().overrides.is_empty());
        s.update(&patch(json!({ "format.bold": [] }))).unwrap();
        assert_eq!(
            store(&dir).get().unwrap().overrides["format.bold"],
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_failed_write_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(FILE)).unwrap();
        let s = store(&dir);
        assert_eq!(
            s.update(&patch(json!({ "format.bold": [] }))),
            Err("E_KEYBOARD_SHORTCUTS_WRITE_FAILED")
        );
        assert_eq!(s.get().unwrap().revision, 0);
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link_at_a_temporary_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        std::fs::write(&theirs, b"theirs").unwrap();
        // The name the changes once went to first.
        std::os::unix::fs::symlink(&theirs, dir.path().join(format!("{FILE}.partial"))).unwrap();
        store(&dir)
            .update(&patch(json!({ "format.bold": [] })))
            .unwrap();
        let path = dir.path().join(FILE);
        assert!(std::fs::symlink_metadata(&path).unwrap().is_file());
        assert_eq!(
            store(&dir).get().unwrap().overrides["format.bold"],
            Vec::<String>::new()
        );
        assert_eq!(std::fs::read(&theirs).unwrap(), b"theirs");
    }
}
