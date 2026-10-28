//! Third-party plugins (ADR 0005): installed from a folder or `.zip` archive the user picks into `<app data>/plugins/<id>/`,
//! with `<app data>/plugins.json` recording which are on and the permissions the user approved. Rust serves an enabled
//! plugin's files on `devot-plugin://` (`serve`), builds its menu items (`menu`) and shows the panels for its import and export
//! formats; the main window runs it in a sandboxed frame.

pub mod manifest;
#[cfg(desktop)]
pub mod menu;
pub mod package;
pub mod serve;

use crate::atomic_file::{self, Folder, Place};
use manifest::Manifest;
use package::Package;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

pub const DIR: &str = "plugins";
pub const STATE_FILE: &str = "plugins.json";
pub const CHANGED_EVENT: &str = "devot://plugins-changed";
/// Staged packages kept for approval at once; an older one is dropped.
const STAGED_MAX: usize = 4;
pub const IMPORT_FILES_MAX: usize = 20;
pub const IMPORT_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const EXPORT_CHARS_MAX: usize = 20 * 1024 * 1024;
/// As the core's MAX_TITLE_CHARS.
const TITLE_CHARS_MAX: usize = 1000;

const NOT_FOUND: &str = "E_PLUGIN_NOT_FOUND";
const DISABLED: &str = "E_PLUGIN_DISABLED";
const DENIED: &str = "E_PLUGIN_PERMISSION_DENIED";
const FAILED: &str = "E_PLUGIN_INSTALL_FAILED";
const STAGED_GONE: &str = "E_PLUGIN_STAGED_MISSING";
const FORMAT_UNKNOWN: &str = "E_PLUGIN_FORMAT_UNKNOWN";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    enabled: bool,
    granted: Vec<String>,
    #[serde(default)]
    installed_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    plugins: BTreeMap<String, Entry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub manifest: Manifest,
    pub enabled: bool,
    /// Only what the manifest still asks for.
    pub granted: Vec<String>,
    /// Milliseconds since 1970; the window starts a plugin installed again afresh.
    pub installed_at: u64,
}

impl Installed {
    pub fn may(&self, permission: &str) -> bool {
        self.granted.iter().any(|p| p == permission)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Replaced {
    pub version: String,
    pub granted: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Staged {
    pub token: u64,
    pub manifest: Manifest,
    pub replaces: Option<Replaced>,
}

pub struct Plugins {
    data: PathBuf,
    staged: Mutex<Vec<(u64, Package)>>,
    next: Mutex<u64>,
    /// Changes of the state file and the plugins folder go one at a time.
    writing: Mutex<()>,
}

impl Plugins {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data: data_dir.to_path_buf(),
            staged: Mutex::new(Vec::new()),
            next: Mutex::new(1),
            writing: Mutex::new(()),
        }
    }

    fn state_path(&self) -> PathBuf {
        self.data.join(STATE_FILE)
    }

    fn stored(&self) -> Stored {
        self.read_stored().unwrap_or_default()
    }

    /// None when the state file cannot be read, or is damaged and no copy of it could be kept: nothing may write over it.
    fn read_stored(&self) -> Option<Stored> {
        let path = self.state_path();
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(stored) => Some(stored),
                Err(_) => {
                    log::warn!("W_PLUGINS_STATE_INVALID");
                    let kept = atomic_file::keep_damaged(&path, &bytes).is_ok();
                    if !kept {
                        log::warn!("W_PLUGINS_STATE_COPY_FAILED");
                    }
                    kept.then(Stored::default)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Stored::default()),
            Err(_) => {
                log::warn!("W_PLUGINS_STATE_READ_FAILED");
                None
            }
        }
    }

    fn store(&self, stored: &Stored) -> Result<(), &'static str> {
        let bytes = serde_json::to_vec_pretty(stored).map_err(|_| FAILED)?;
        atomic_file::write_replacing(&self.state_path(), &bytes).map_err(|_| FAILED)
    }

    fn folder(&self) -> std::io::Result<Folder> {
        Folder::open(&self.data.join(DIR))
    }

    /// A plugin folder's file, every folder on the way opened from the one before and never through a link.
    pub fn read_file(&self, id: &str, path: &str) -> Result<Vec<u8>, &'static str> {
        if !manifest::is_id(id) || !manifest::is_package_path(path) {
            return Err(NOT_FOUND);
        }
        let mut folder = self
            .folder()
            .and_then(|f| f.folder(id))
            .map_err(|_| NOT_FOUND)?;
        let mut parts: Vec<&str> = path.split('/').collect();
        let name = parts.pop().ok_or(NOT_FOUND)?;
        for part in parts {
            folder = folder.folder(part).map_err(|_| NOT_FOUND)?;
        }
        let mut bytes = Vec::new();
        folder
            .read_file(name)
            .map_err(|_| NOT_FOUND)?
            .take(package::MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| NOT_FOUND)?;
        if bytes.len() as u64 > package::MAX_FILE_BYTES {
            return Err(NOT_FOUND);
        }
        Ok(bytes)
    }

    fn installed(&self, id: &str, entry: &Entry) -> Result<Installed, &'static str> {
        let manifest = manifest::parse_bytes(&self.read_file(id, manifest::FILE)?)?;
        if manifest.id != id {
            return Err("E_PLUGIN_ID_INVALID");
        }
        let granted = entry
            .granted
            .iter()
            .filter(|p| manifest.asks(p))
            .cloned()
            .collect();
        Ok(Installed {
            manifest,
            enabled: entry.enabled,
            granted,
            installed_at: entry.installed_at,
        })
    }

    /// A plugin whose folder or manifest is missing or no longer valid is left out (and logged).
    pub fn list(&self) -> Vec<Installed> {
        self.stored()
            .plugins
            .iter()
            .filter_map(|(id, entry)| match self.installed(id, entry) {
                Ok(installed) => Some(installed),
                Err(code) => {
                    log::warn!("W_PLUGIN_UNREADABLE {id} {code}");
                    None
                }
            })
            .collect()
    }

    /// An installed plugin that is on.
    pub fn enabled(&self, id: &str) -> Result<Installed, &'static str> {
        if !manifest::is_id(id) {
            return Err(NOT_FOUND);
        }
        let stored = self.stored();
        let entry = stored.plugins.get(id).ok_or(NOT_FOUND)?;
        let installed = self.installed(id, entry)?;
        if installed.enabled {
            Ok(installed)
        } else {
            Err(DISABLED)
        }
    }

    fn allowed(&self, id: &str, permission: &str) -> Result<Installed, &'static str> {
        let installed = self.enabled(id)?;
        if installed.may(permission) {
            Ok(installed)
        } else {
            Err(DENIED)
        }
    }

    pub fn stage(&self, package: Package) -> Staged {
        let token = {
            let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
            let token = *next;
            *next += 1;
            token
        };
        let stored = self.stored();
        let replaces = stored
            .plugins
            .get(&package.manifest.id)
            .and_then(|entry| self.installed(&package.manifest.id, entry).ok())
            .map(|old| Replaced {
                version: old.manifest.version,
                granted: old.granted,
            });
        let manifest = package.manifest.clone();
        let mut staged = self.staged.lock().unwrap_or_else(|e| e.into_inner());
        staged.push((token, package));
        while staged.len() > STAGED_MAX {
            staged.remove(0);
        }
        Staged {
            token,
            manifest,
            replaces,
        }
    }

    pub fn cancel(&self, token: u64) {
        self.staged
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(t, _)| *t != token);
    }

    /// Writes the staged package to a new folder and renames it into place, replacing an installed plugin of the same ID
    /// whole. It is on, with every permission its manifest asks for: the user approved them.
    pub fn install(&self, token: u64) -> Result<Installed, &'static str> {
        let package = {
            let mut staged = self.staged.lock().unwrap_or_else(|e| e.into_inner());
            let at = staged
                .iter()
                .position(|(t, _)| *t == token)
                .ok_or(STAGED_GONE)?;
            staged.remove(at).1
        };
        let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.read_stored().ok_or(FAILED)?;
        std::fs::create_dir_all(self.data.join(DIR)).map_err(|_| FAILED)?;
        let plugins = self.folder().map_err(|_| FAILED)?;
        let id = package.manifest.id.clone();
        let new = atomic_file::temporary_name();
        plugins.make_folder(&new).map_err(|_| FAILED)?;
        let written = write_files(&plugins.folder(&new).map_err(|_| FAILED)?, &package);
        if written.is_err() {
            let _ = remove_tree(&plugins, &new);
            return Err(FAILED);
        }
        let aside = match plugins.entry(&id) {
            Ok(_) => {
                let aside = atomic_file::temporary_name();
                plugins
                    .rename(&id, &plugins, &aside, Place::New)
                    .map_err(|_| FAILED)?;
                Some(aside)
            }
            Err(_) => None,
        };
        if plugins.rename(&new, &plugins, &id, Place::New).is_err() {
            if let Some(aside) = &aside {
                let _ = plugins.rename(aside, &plugins, &id, Place::New);
            }
            let _ = remove_tree(&plugins, &new);
            return Err(FAILED);
        }
        if let Some(aside) = aside
            && remove_tree(&plugins, &aside).is_err()
        {
            log::warn!("W_PLUGIN_OLD_FOLDER_KEPT {id}");
        }
        let installed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let entry = Entry {
            enabled: true,
            granted: package.manifest.permissions.clone(),
            installed_at,
        };
        stored.plugins.insert(id.clone(), entry.clone());
        self.store(&stored)?;
        log::info!("I_PLUGIN_INSTALLED {id} {}", package.manifest.version);
        self.installed(&id, &entry)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), &'static str> {
        let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.read_stored().ok_or(FAILED)?;
        let entry = stored.plugins.get_mut(id).ok_or(NOT_FOUND)?;
        entry.enabled = enabled;
        self.store(&stored)?;
        log::info!("I_PLUGIN_ENABLED {id} {enabled}");
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<(), &'static str> {
        if !manifest::is_id(id) {
            return Err(NOT_FOUND);
        }
        let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.read_stored().ok_or(FAILED)?;
        let known = stored.plugins.remove(id).is_some();
        self.store(&stored)?;
        if let Ok(plugins) = self.folder()
            && plugins.entry(id).is_ok()
            && remove_tree(&plugins, id).is_err()
        {
            log::warn!("W_PLUGIN_FOLDER_KEPT {id}");
        }
        if !known {
            return Err(NOT_FOUND);
        }
        log::info!("I_PLUGIN_REMOVED {id}");
        Ok(())
    }

    /// Folders an install left behind when it was cut short.
    pub fn sweep(&self) {
        let Ok(plugins) = self.folder() else { return };
        for name in plugins.names().unwrap_or_default() {
            if name.to_str().is_some_and(atomic_file::is_temporary)
                && remove_tree(&plugins, &name).is_err()
            {
                log::warn!("W_PLUGIN_SWEEP_FAILED");
            }
        }
    }
}

fn write_files(root: &Folder, package: &Package) -> std::io::Result<()> {
    for (path, bytes) in &package.files {
        let mut folder = root.clone();
        let mut parts: Vec<&str> = path.split('/').collect();
        let name = parts.pop().unwrap_or_default();
        for part in parts {
            match folder.make_folder(part) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
            folder = folder.folder(part)?;
        }
        folder.write(name, bytes, Place::New)?;
    }
    Ok(())
}

/// A link inside is removed as a link, never followed.
fn remove_tree(parent: &Folder, name: impl AsRef<std::ffi::OsStr>) -> std::io::Result<()> {
    let name = name.as_ref();
    let folder = parent.folder(name)?;
    for child in folder.names()? {
        if folder.entry(&child)?.is_folder() {
            remove_tree(&folder, &child)?;
        } else {
            folder.remove_file(&child)?;
        }
    }
    parent.remove_folder(name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PickKind {
    Folder,
    Archive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PickedFile {
    pub name: String,
    pub text: String,
}

/// A file name for an exported note: what a file name cannot hold becomes `-`, at most 200 characters.
pub fn export_name(title: &str, extension: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | ':' | '\\' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .take(200)
        .collect();
    let stem = cleaned.trim().trim_start_matches('.');
    let stem = if stem.is_empty() {
        crate::strings::UNTITLED
    } else {
        stem
    };
    format!("{stem}.{extension}")
}

fn read_text(path: &Path) -> Result<PickedFile, &'static str> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("E_PLUGIN_IMPORT_UNREADABLE")?
        .to_string();
    let file = std::fs::File::open(path).map_err(|_| "E_PLUGIN_IMPORT_UNREADABLE")?;
    let mut bytes = Vec::new();
    file.take(IMPORT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "E_PLUGIN_IMPORT_UNREADABLE")?;
    if bytes.len() as u64 > IMPORT_FILE_BYTES {
        return Err("E_PLUGIN_IMPORT_TOO_LARGE");
    }
    let text = String::from_utf8(bytes).map_err(|_| "E_PLUGIN_IMPORT_NOT_TEXT")?;
    Ok(PickedFile { name, text })
}

fn read_picked(paths: &[PathBuf]) -> Result<Vec<PickedFile>, &'static str> {
    if paths.len() > IMPORT_FILES_MAX {
        return Err("E_PLUGIN_IMPORT_TOO_MANY");
    }
    paths.iter().map(|p| read_text(p)).collect()
}

fn check_export(title: &str, text: &str) -> Result<(), &'static str> {
    if text.len() > EXPORT_CHARS_MAX || title.chars().count() > TITLE_CHARS_MAX {
        return Err("E_PLUGIN_EXPORT_TOO_LARGE");
    }
    Ok(())
}

fn changed(app: &AppHandle) {
    if app.emit(CHANGED_EVENT, ()).is_err() {
        log::warn!("W_PLUGINS_CHANGED_EMIT_FAILED");
    }
    #[cfg(desktop)]
    menu::refresh(app);
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| FAILED.to_string())?
        .map_err(String::from)
}

type Shared<'a> = State<'a, std::sync::Arc<Plugins>>;

#[tauri::command]
pub async fn plugins_list(plugins: Shared<'_>) -> Result<Vec<Installed>, String> {
    let plugins = std::sync::Arc::clone(&plugins);
    blocking(move || Ok(plugins.list())).await
}

/// None when the user cancelled the panel.
#[tauri::command]
pub async fn plugin_install_pick(
    window: WebviewWindow,
    plugins: Shared<'_>,
    kind: PickKind,
) -> Result<Option<Staged>, String> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    let dialog = window
        .dialog()
        .file()
        .set_title(crate::strings::PLUGIN_INSTALL_TITLE);
    #[cfg(desktop)]
    let dialog = dialog.set_parent(&window);
    match kind {
        #[cfg(desktop)]
        PickKind::Folder => dialog.pick_folder(move |path| {
            let _ = reply.send(path.map(|p| p.into_path()));
        }),
        #[cfg(mobile)]
        PickKind::Folder => return Err("E_PLUGIN_FOLDERS_UNSUPPORTED".into()),
        PickKind::Archive => dialog
            .add_filter(crate::strings::PLUGIN_ARCHIVE_FILTER, &["zip"])
            .pick_file(move |path| {
                let _ = reply.send(path.map(|p| p.into_path()));
            }),
    }
    let path = match answer.await {
        Ok(None) => return Ok(None),
        Ok(Some(Ok(path))) => path,
        _ => return Err("E_PLUGIN_PACKAGE_UNREADABLE".into()),
    };
    let plugins = std::sync::Arc::clone(&plugins);
    blocking(move || {
        let package = match kind {
            PickKind::Folder => package::read_folder(&path),
            PickKind::Archive => package::read_archive(&path),
        };
        package.map(|p| Some(plugins.stage(p))).inspect_err(|code| {
            log::warn!("W_PLUGIN_PACKAGE_REFUSED {code}");
        })
    })
    .await
}

#[tauri::command]
pub async fn plugin_install_confirm(
    app: AppHandle,
    plugins: Shared<'_>,
    token: u64,
) -> Result<Installed, String> {
    let plugins = std::sync::Arc::clone(&plugins);
    let installed = blocking(move || plugins.install(token)).await?;
    changed(&app);
    Ok(installed)
}

#[tauri::command]
pub fn plugin_install_cancel(plugins: Shared<'_>, token: u64) {
    plugins.cancel(token);
}

#[tauri::command]
pub async fn plugin_set_enabled(
    app: AppHandle,
    plugins: Shared<'_>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    if !manifest::is_id(&id) {
        return Err(NOT_FOUND.into());
    }
    let plugins = std::sync::Arc::clone(&plugins);
    blocking(move || plugins.set_enabled(&id, enabled)).await?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn plugin_remove(app: AppHandle, plugins: Shared<'_>, id: String) -> Result<(), String> {
    let plugins = std::sync::Arc::clone(&plugins);
    blocking(move || plugins.remove(&id)).await?;
    changed(&app);
    Ok(())
}

/// The files of an import format the user picks, as text; None when the panel was cancelled.
#[tauri::command]
pub async fn plugin_import_pick(
    window: WebviewWindow,
    plugins: Shared<'_>,
    plugin: String,
    format: String,
) -> Result<Option<Vec<PickedFile>>, String> {
    let installed = plugins.allowed(&plugin, "import")?;
    let found = installed
        .manifest
        .contributes
        .import_formats
        .iter()
        .find(|f| f.id == format)
        .ok_or(FORMAT_UNKNOWN)?;
    let extensions: Vec<&str> = found.extensions.iter().map(String::as_str).collect();
    let (reply, answer) = tokio::sync::oneshot::channel();
    let dialog = window
        .dialog()
        .file()
        .set_title(crate::strings::PLUGIN_IMPORT_TITLE)
        .add_filter(&found.title, &extensions);
    #[cfg(desktop)]
    let dialog = dialog.set_parent(&window);
    dialog.pick_files(move |files| {
        let _ = reply.send(files);
    });
    let Some(files) = answer.await.map_err(|_| "E_PLUGIN_IMPORT_UNREADABLE")? else {
        return Ok(None);
    };
    let paths = files
        .into_iter()
        .map(|f| f.into_path())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "E_PLUGIN_IMPORT_UNREADABLE")?;
    blocking(move || read_picked(&paths).map(Some)).await
}

/// True once saved; false when the user cancelled the panel.
#[tauri::command]
pub async fn plugin_export_save(
    window: WebviewWindow,
    plugins: Shared<'_>,
    plugin: String,
    format: String,
    title: String,
    text: String,
) -> Result<bool, String> {
    let installed = plugins.allowed(&plugin, "export")?;
    let found = installed
        .manifest
        .contributes
        .export_formats
        .iter()
        .find(|f| f.id == format)
        .ok_or(FORMAT_UNKNOWN)?;
    check_export(&title, &text)?;
    let (reply, answer) = tokio::sync::oneshot::channel();
    let dialog = window
        .dialog()
        .file()
        .set_title(crate::strings::PLUGIN_EXPORT_TITLE)
        .set_file_name(export_name(&title, &found.extension))
        .add_filter(&found.title, &[found.extension.as_str()]);
    #[cfg(desktop)]
    let dialog = dialog.set_parent(&window);
    dialog.save_file(move |path| {
        let _ = reply.send(path);
    });
    let Some(path) = answer.await.map_err(|_| "E_PLUGIN_EXPORT_FAILED")? else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|_| "E_PLUGIN_EXPORT_FAILED")?;
    let path = crate::commands::images::save_path(&path).map_err(|_| "E_PLUGIN_EXPORT_FAILED")?;
    blocking(move || {
        atomic_file::write_replacing(&path, text.as_bytes()).map_err(|_| "E_PLUGIN_EXPORT_FAILED")
    })
    .await?;
    log::info!("I_PLUGIN_EXPORTED {plugin} {format}");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_picked_text_file_up_to_its_limit() {
        let dir = tempfile::tempdir().unwrap();
        let fine = dir.path().join("a.org");
        std::fs::write(&fine, "* heading\n").unwrap();
        let read = read_text(&fine).unwrap();
        assert_eq!(
            (read.name.as_str(), read.text.as_str()),
            ("a.org", "* heading\n")
        );

        let exact = dir.path().join("exact.org");
        std::fs::write(&exact, vec![b'a'; IMPORT_FILE_BYTES as usize]).unwrap();
        assert_eq!(
            read_text(&exact).unwrap().text.len() as u64,
            IMPORT_FILE_BYTES
        );

        let large = dir.path().join("large.org");
        std::fs::write(&large, vec![b'a'; IMPORT_FILE_BYTES as usize + 1]).unwrap();
        assert_eq!(read_text(&large).err(), Some("E_PLUGIN_IMPORT_TOO_LARGE"));

        let binary = dir.path().join("binary.org");
        std::fs::write(&binary, [0x66, 0xff, 0xfe]).unwrap();
        assert_eq!(read_text(&binary).err(), Some("E_PLUGIN_IMPORT_NOT_TEXT"));

        assert_eq!(
            read_text(&dir.path().join("gone.org")).err(),
            Some("E_PLUGIN_IMPORT_UNREADABLE")
        );
    }

    #[test]
    fn refuses_more_picked_files_than_the_limit_and_fails_on_any_bad_one() {
        let dir = tempfile::tempdir().unwrap();
        let paths: Vec<PathBuf> = (0..=IMPORT_FILES_MAX)
            .map(|i| {
                let path = dir.path().join(format!("{i}.org"));
                std::fs::write(&path, "x").unwrap();
                path
            })
            .collect();
        assert_eq!(read_picked(&paths).err(), Some("E_PLUGIN_IMPORT_TOO_MANY"));
        assert_eq!(
            read_picked(&paths[..IMPORT_FILES_MAX]).unwrap().len(),
            IMPORT_FILES_MAX
        );

        let binary = dir.path().join("binary.org");
        std::fs::write(&binary, [0xff]).unwrap();
        let mixed = [paths[0].clone(), binary];
        assert_eq!(read_picked(&mixed).err(), Some("E_PLUGIN_IMPORT_NOT_TEXT"));
    }

    #[test]
    fn refuses_an_export_past_its_size_or_title_limit() {
        let text = "a".repeat(EXPORT_CHARS_MAX);
        assert_eq!(check_export("Plan", &text), Ok(()));
        let longer = "a".repeat(EXPORT_CHARS_MAX + 1);
        assert_eq!(
            check_export("Plan", &longer),
            Err("E_PLUGIN_EXPORT_TOO_LARGE")
        );
        let title = "t".repeat(TITLE_CHARS_MAX + 1);
        assert_eq!(check_export(&title, "x"), Err("E_PLUGIN_EXPORT_TOO_LARGE"));
        assert_eq!(check_export(&"t".repeat(TITLE_CHARS_MAX), "x"), Ok(()));
    }

    const MANIFEST: &str = r#"{"id":"com.example.hello","name":"Hello","version":"1.0.0","apiVersion":1,"main":"main.js","permissions":["commands","import"],"contributes":{"commands":[{"id":"hi","title":"Say Hi"}],"importFormats":[{"id":"org","title":"Org","extensions":["org"]}]}}"#;

    fn package(version: &str, main: &[u8]) -> Package {
        let manifest = MANIFEST.replace("1.0.0", version);
        let mut files = BTreeMap::new();
        files.insert(manifest::FILE.to_string(), manifest.as_bytes().to_vec());
        files.insert("main.js".to_string(), main.to_vec());
        files.insert("lib/a/b.js".to_string(), b"b".to_vec());
        Package {
            manifest: manifest::parse_bytes(manifest.as_bytes()).unwrap(),
            files,
        }
    }

    #[test]
    fn installs_a_staged_package_on_with_what_it_asks_for() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let staged = plugins.stage(package("1.0.0", b"one"));
        assert_eq!(staged.replaces, None);
        let installed = plugins.install(staged.token).unwrap();
        assert!(installed.enabled);
        assert_eq!(installed.granted, ["commands", "import"]);
        assert_eq!(plugins.list(), vec![installed]);
        assert_eq!(
            plugins.read_file("com.example.hello", "main.js").unwrap(),
            b"one"
        );
        assert_eq!(
            plugins
                .read_file("com.example.hello", "lib/a/b.js")
                .unwrap(),
            b"b"
        );
        assert_eq!(plugins.install(staged.token).err(), Some(STAGED_GONE));
    }

    #[test]
    fn replaces_an_installed_plugin_whole_and_says_what_it_replaces() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let first = plugins.stage(package("1.0.0", b"one"));
        plugins.install(first.token).unwrap();
        let second = plugins.stage(package("2.0.0", b"two"));
        assert_eq!(
            second.replaces,
            Some(Replaced {
                version: "1.0.0".into(),
                granted: vec!["commands".into(), "import".into()],
            })
        );
        plugins.install(second.token).unwrap();
        assert_eq!(
            plugins.read_file("com.example.hello", "main.js").unwrap(),
            b"two"
        );
        let names: Vec<_> = Folder::open(&data.path().join(DIR))
            .unwrap()
            .names()
            .unwrap();
        assert_eq!(names, vec![std::ffi::OsString::from("com.example.hello")]);
    }

    #[test]
    fn a_cancelled_package_is_never_installed() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let staged = plugins.stage(package("1.0.0", b"one"));
        plugins.cancel(staged.token);
        assert_eq!(plugins.install(staged.token).err(), Some(STAGED_GONE));
        assert!(plugins.list().is_empty());
    }

    #[test]
    fn turns_plugins_off_and_on_and_checks_permissions() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let staged = plugins.stage(package("1.0.0", b"one"));
        plugins.install(staged.token).unwrap();
        assert!(plugins.allowed("com.example.hello", "import").is_ok());
        assert_eq!(
            plugins.allowed("com.example.hello", "export").err(),
            Some(DENIED)
        );
        plugins.set_enabled("com.example.hello", false).unwrap();
        assert_eq!(plugins.enabled("com.example.hello").err(), Some(DISABLED));
        assert_eq!(
            plugins.allowed("com.example.hello", "import").err(),
            Some(DISABLED)
        );
        plugins.set_enabled("com.example.hello", true).unwrap();
        assert!(plugins.enabled("com.example.hello").is_ok());
        assert_eq!(plugins.enabled("com.example.other").err(), Some(NOT_FOUND));
        assert_eq!(
            plugins.set_enabled("com.example.other", true),
            Err(NOT_FOUND)
        );
    }

    #[test]
    fn grants_only_what_the_manifest_on_disk_still_asks_for() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let staged = plugins.stage(package("1.0.0", b"one"));
        plugins.install(staged.token).unwrap();
        let mut stored = plugins.stored();
        stored.plugins.get_mut("com.example.hello").unwrap().granted =
            vec!["commands".into(), "import".into(), "note.edit".into()];
        plugins.store(&stored).unwrap();
        assert_eq!(plugins.list()[0].granted, ["commands", "import"]);
    }

    #[test]
    fn removes_a_plugin_and_its_folder() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let staged = plugins.stage(package("1.0.0", b"one"));
        plugins.install(staged.token).unwrap();
        plugins.remove("com.example.hello").unwrap();
        assert!(plugins.list().is_empty());
        assert!(!data.path().join(DIR).join("com.example.hello").exists());
        assert_eq!(plugins.remove("com.example.hello"), Err(NOT_FOUND));
    }

    #[test]
    fn never_reads_outside_a_plugin_folder_or_through_a_link() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let staged = plugins.stage(package("1.0.0", b"one"));
        plugins.install(staged.token).unwrap();
        std::fs::write(data.path().join("secret.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(
            data.path().join("secret.txt"),
            data.path()
                .join(DIR)
                .join("com.example.hello")
                .join("link.js"),
        )
        .unwrap();
        for path in [
            "../secret.txt",
            "link.js",
            "/etc/hosts",
            "lib/../main.js",
            "",
        ] {
            assert_eq!(
                plugins.read_file("com.example.hello", path).err(),
                Some(NOT_FOUND),
                "{path}"
            );
        }
        assert_eq!(plugins.read_file("..", "secret.txt").err(), Some(NOT_FOUND));
    }

    #[test]
    fn a_plugin_whose_manifest_was_damaged_is_left_out() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let staged = plugins.stage(package("1.0.0", b"one"));
        plugins.install(staged.token).unwrap();
        std::fs::write(
            data.path()
                .join(DIR)
                .join("com.example.hello")
                .join(manifest::FILE),
            b"{}",
        )
        .unwrap();
        assert!(plugins.list().is_empty());
    }

    #[test]
    fn keeps_a_damaged_state_file_before_writing_a_new_one() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let first = plugins.stage(package("1.0.0", b"one"));
        plugins.install(first.token).unwrap();
        let damaged = b"{\"plugins\":{\"com.example.other\":";
        std::fs::write(data.path().join(STATE_FILE), damaged).unwrap();
        assert!(plugins.list().is_empty());
        let again = plugins.stage(package("1.0.0", b"one"));
        plugins.install(again.token).unwrap();
        let mut copy = data.path().join(STATE_FILE).into_os_string();
        copy.push(atomic_file::DAMAGED_SUFFIX);
        assert_eq!(std::fs::read(copy).unwrap(), damaged);
    }

    #[test]
    fn refuses_to_write_over_a_state_file_it_cannot_read() {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let staged = plugins.stage(package("1.0.0", b"one"));
        plugins.install(staged.token).unwrap();
        let state = data.path().join(STATE_FILE);
        let before = std::fs::read(&state).unwrap();
        std::fs::remove_file(&state).unwrap();
        std::fs::create_dir(&state).unwrap();
        let again = plugins.stage(package("2.0.0", b"two"));
        assert_eq!(plugins.install(again.token).err(), Some(FAILED));
        assert_eq!(
            plugins.read_file("com.example.hello", "main.js").unwrap(),
            b"one"
        );
        assert_eq!(plugins.set_enabled("com.example.hello", false), Err(FAILED));
        assert_eq!(plugins.remove("com.example.hello"), Err(FAILED));
        assert!(data.path().join(DIR).join("com.example.hello").exists());
        std::fs::remove_dir(&state).unwrap();
        std::fs::write(&state, &before).unwrap();
        assert!(plugins.enabled("com.example.hello").is_ok());
    }

    #[test]
    fn sweeps_folders_an_install_left_behind() {
        let data = tempfile::tempdir().unwrap();
        let left = data.path().join(DIR).join(atomic_file::temporary_name());
        std::fs::create_dir_all(left.join("sub")).unwrap();
        std::fs::write(left.join("sub/a.js"), b"x").unwrap();
        Plugins::new(data.path()).sweep();
        assert!(!left.exists());
    }

    #[test]
    fn names_an_exported_file_after_the_note() {
        assert_eq!(export_name("Plan: 2026/10", "org"), "Plan- 2026-10.org");
        assert_eq!(
            export_name("  ", "org"),
            format!("{}.org", crate::strings::UNTITLED)
        );
        assert_eq!(export_name(".hidden", "txt"), "hidden.txt");
    }
}
