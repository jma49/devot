//! Keyboard shortcuts the user changed (Settings > Keyboard Shortcuts). The command registry
//! (`src/renderer/src/commands/registry.ts`) declares every command with its default keys; this
//! keeps only the changes, on this device only in `<app data>/keyboard-shortcuts.json`, so they
//! never sync and never go into backups.
//! As with the editor settings, Rust holds them so every window reads the same: after each change
//! every window gets `devot://keyboard-shortcuts-changed` with all of them and a revision number.
//! Checked here: command IDs look like the registry's, keys are in canonical order
//! (`Mod+Ctrl+Alt+Shift` then a key), never a key macOS or the app menu keeps (`RESERVED`) nor
//! Escape, at most four per command, each once. What only the registry knows (which commands exist,
//! where keys apply, clashes) the UI checks. A change with anything invalid is refused as a whole;
//! reading the file is lenient (an invalid entry is dropped, the rest kept).

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub const FILE: &str = "keyboard-shortcuts.json";
pub const CHANGED_EVENT: &str = "devot://keyboard-shortcuts-changed";

pub const MAX_KEYS: usize = 4;
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
    // Quick capture's shortcut, the system's for Devot while menu bar mode is on (`menu_bar`).
    "Mod+Ctrl+Alt+N",
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

pub fn valid_shortcut(shortcut: &str) -> bool {
    if shortcut.len() > MAX_ID_LEN || RESERVED.contains(&shortcut) {
        return false;
    }
    let (modifiers, key) = match shortcut.rsplit_once('+') {
        Some((modifiers, key)) => (Some(modifiers), key),
        None => (None, shortcut),
    };
    let mut next = 0;
    for part in modifiers.into_iter().flat_map(|m| m.split('+')) {
        match MODIFIERS[next..].iter().position(|m| *m == part) {
            Some(at) => next += at + 1,
            None => return false,
        }
    }
    known_key(key)
}

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

pub type Overrides = BTreeMap<String, Vec<String>>;

/// A null value gives a command its defaults again; anything invalid refuses the whole patch.
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

/// The revision goes up by one with every stored change (from 0 when Devot starts), so a window can
/// tell which of two events or answers is newer, whatever order they arrive in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub overrides: Overrides,
}

struct Held {
    snapshot: Snapshot,
    /// False while the file cannot be read: nothing is written over it then, since a change would
    /// drop every key it holds.
    read: bool,
}

pub struct KeyboardShortcutsStore {
    path: PathBuf,
    current: Mutex<Option<Held>>,
}

impl KeyboardShortcutsStore {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
            current: Mutex::new(None),
        }
    }

    fn read(&self) -> Held {
        let overrides = match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value @ Value::Object(_)) => Some(from_stored(&value)),
                _ => {
                    log::warn!("W_KEYBOARD_SHORTCUTS_UNREADABLE");
                    let kept = crate::atomic_file::keep_damaged(&self.path, &bytes).is_ok();
                    if !kept {
                        log::warn!("W_KEYBOARD_SHORTCUTS_COPY_FAILED");
                    }
                    kept.then(Overrides::new)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Overrides::new()),
            Err(_) => {
                log::warn!("W_KEYBOARD_SHORTCUTS_READ_FAILED");
                None
            }
        };
        Held {
            read: overrides.is_some(),
            snapshot: Snapshot {
                revision: 0,
                overrides: overrides.unwrap_or_default(),
            },
        }
    }

    /// Read at first use, and again on every use while the file cannot be read; once a read
    /// works, its keys take a newer revision than the defaults shown meanwhile.
    fn held<'a>(&self, current: &'a mut Option<Held>) -> &'a mut Held {
        let held = match current.take() {
            Some(held) if held.read => held,
            Some(unread) => {
                let mut read = self.read();
                if read.read {
                    read.snapshot.revision = unread.snapshot.revision + 1;
                    read
                } else {
                    unread
                }
            }
            None => self.read(),
        };
        current.insert(held)
    }

    pub fn get(&self) -> Result<Snapshot, &'static str> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "E_KEYBOARD_SHORTCUTS_LOCK_FAILED")?;
        Ok(self.held(&mut current).snapshot.clone())
    }

    pub fn update(&self, patch: &Map<String, Value>) -> Result<Snapshot, &'static str> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "E_KEYBOARD_SHORTCUTS_LOCK_FAILED")?;
        let now = self.held(&mut current);
        if !now.read {
            return Err("E_KEYBOARD_SHORTCUTS_READ_FAILED");
        }
        let next = Snapshot {
            revision: now.snapshot.revision + 1,
            overrides: with_patch(&now.snapshot.overrides, patch)?,
        };
        let json = serde_json::to_vec_pretty(&next.overrides)
            .map_err(|_| "E_KEYBOARD_SHORTCUTS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_KEYBOARD_SHORTCUTS_WRITE_FAILED")?;
        now.snapshot = next.clone();
        Ok(next)
    }
}

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
    use crate::atomic_file::DAMAGED_SUFFIX;
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
    fn a_damaged_file_means_no_changes_and_is_replaced_on_the_next_change_after_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        for damaged in [&b"{ not json"[..], b"[1, 2]"] {
            std::fs::write(dir.path().join(FILE), damaged).unwrap();
            let s = store(&dir);
            assert!(s.get().unwrap().overrides.is_empty());
            s.update(&patch(json!({ "format.bold": [] }))).unwrap();
            assert_eq!(
                store(&dir).get().unwrap().overrides["format.bold"],
                Vec::<String>::new()
            );
            let copy = dir.path().join(format!("{FILE}{DAMAGED_SUFFIX}"));
            assert_eq!(std::fs::read(copy).unwrap(), damaged);
        }
    }

    #[test]
    fn a_damaged_file_that_cannot_be_copied_is_never_written_over() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), b"{ not json").unwrap();
        std::fs::create_dir(dir.path().join(format!("{FILE}{DAMAGED_SUFFIX}"))).unwrap();
        assert_eq!(
            store(&dir).update(&patch(json!({ "format.bold": [] }))),
            Err("E_KEYBOARD_SHORTCUTS_READ_FAILED")
        );
        assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), b"{ not json");
    }

    #[test]
    fn a_failed_write_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let s = KeyboardShortcutsStore::new(&dir.path().join("gone").join(FILE));
        assert_eq!(
            s.update(&patch(json!({ "format.bold": [] }))),
            Err("E_KEYBOARD_SHORTCUTS_WRITE_FAILED")
        );
        assert_eq!(s.get().unwrap().revision, 0);
    }

    #[test]
    fn a_file_that_cannot_be_read_is_never_written_over() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(FILE)).unwrap();
        let s = store(&dir);
        assert!(s.get().unwrap().overrides.is_empty());
        assert_eq!(
            s.update(&patch(json!({ "format.bold": [] }))),
            Err("E_KEYBOARD_SHORTCUTS_READ_FAILED")
        );
        assert!(dir.path().join(FILE).is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn a_change_after_a_failed_read_keeps_the_other_shortcuts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        let before = br#"{ "view.focus": ["Mod+Alt+J"], "palette.open": [] }"#;
        std::fs::write(&path, before).unwrap();
        let mode = |bits| std::fs::set_permissions(&path, std::fs::Permissions::from_mode(bits));
        mode(0o000).unwrap();
        if std::fs::read(&path).is_ok() {
            return; // root reads it anyway
        }
        let s = store(&dir);
        let shown = s.get().unwrap();
        assert!(shown.overrides.is_empty());
        assert_eq!(
            s.update(&patch(json!({ "format.bold": ["Mod+P"] }))),
            Err("E_KEYBOARD_SHORTCUTS_READ_FAILED")
        );
        mode(0o600).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let next = s
            .update(&patch(json!({ "format.bold": ["Mod+P"] })))
            .unwrap();
        assert!(next.revision > shown.revision);
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            written,
            json!({ "view.focus": ["Mod+Alt+J"], "palette.open": [], "format.bold": ["Mod+P"] })
        );
        assert_eq!(serde_json::to_value(&next.overrides).unwrap(), written);
    }

    #[cfg(unix)]
    #[test]
    fn a_read_that_works_again_shows_the_stored_keys_as_newer() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        std::fs::write(&path, br#"{ "view.focus": ["Mod+Alt+J"] }"#).unwrap();
        let mode = |bits| std::fs::set_permissions(&path, std::fs::Permissions::from_mode(bits));
        mode(0o000).unwrap();
        if std::fs::read(&path).is_ok() {
            return; // root reads it anyway
        }
        let s = store(&dir);
        let shown = s.get().unwrap();
        mode(0o600).unwrap();
        let now = s.get().unwrap();
        assert!(now.revision > shown.revision);
        assert_eq!(now.overrides["view.focus"], ["Mod+Alt+J"]);
        assert_eq!(s.get().unwrap(), now);
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link_at_a_temporary_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        std::fs::write(&theirs, b"theirs").unwrap();
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
