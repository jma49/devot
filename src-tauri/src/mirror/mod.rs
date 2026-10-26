//! The Markdown mirror (Settings > Markdown Mirror): Devot keeps a folder the user picked up to
//! date with every note as a Markdown file. The notes database stays the source of truth; the
//! folder is written by Devot and never read back.
//! The core worker plans what to write (`src/core/mirror.ts`); Rust holds the setting, the folder
//! and its manifest, and runs each planned operation after checking it again (`folder`). The web
//! view never names a path: the folder comes from the native folder panel.
//! The setting is a local preference like the editor settings: `<app data>/mirror-settings.json`,
//! never synced and never in backups. After every change of the setting or of what the mirror shows
//! every window gets `devot://mirror-changed` with the status and a revision number.
//! The folder is resolved once, when the user chooses it, and every call opens it by that path,
//! never through a link anywhere on it (`folder::Root`). A folder that goes missing, has a link put
//! in its place or cannot be written pauses the mirror; the main window checks again on focus and
//! every so often (`mirror_open`), which resumes it with a reconcile. Devot never makes the folder
//! itself.

mod folder;

use crate::commands::notes::valid_note_id;
use crate::storage::Db;
#[cfg(desktop)]
use crate::strings;
use folder::{
    Manifest, OpResult, Root, create_manifest, disk_state, has_entries, parse_manifest,
    probe_writable, read_manifest, save_manifest, sha256_hex,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;

pub use folder::Op;

pub const SETTINGS_FILE: &str = "mirror-settings.json";
pub const CHANGED_EVENT: &str = "devot://mirror-changed";

/// Operations one `mirror_apply` runs at most (the core sends 50).
pub const MAX_OPS: usize = 500;
/// Paths one `mirror_check` looks at at most (the core sends 2,000).
pub const MAX_PATHS: usize = 5_000;
pub const MAX_IDS: usize = 10_000;
/// Each is read whole, so few at a time.
pub const MAX_HASH_IDS: usize = 100;
/// Kept files the status names (it counts them all), so a status stays
/// small even when a tool changed every file in the folder.
pub const KEPT_NAMED: usize = 20;

const INVALID: &str = "E_MIRROR_SETTINGS_INVALID";
const READ_FAILED: &str = "E_MIRROR_SETTINGS_READ_FAILED";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    folder: Option<String>,
    include_attachments: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    library: Option<String>,
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            folder: None,
            include_attachments: true,
            library: None,
        }
    }
}

impl Stored {
    fn from_value(value: &Value) -> Self {
        let folder = value
            .get("folder")
            .and_then(Value::as_str)
            .filter(|f| Path::new(f).is_absolute())
            .map(String::from);
        let include_attachments = value
            .get("includeAttachments")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let library = value
            .get("library")
            .and_then(Value::as_str)
            .filter(|l| folder::valid_uuid(l))
            .map(String::from);
        Self {
            folder,
            include_attachments,
            library,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: u64,
    /// Changes when the folder or Include Attachments changes, or the
    /// mirror resumes: a pass planned before must start again.
    pub generation: u64,
    pub folder: Option<String>,
    pub include_attachments: bool,
    pub paused: Option<&'static str>,
    /// None until the folder's manifest has been read (a folder just chosen, a launch).
    pub size: Option<u64>,
    /// Files kept under a new name because they were edited outside Devot, since the notice was
    /// last dismissed (the first `KEPT_NAMED`); `kept_count` counts them all.
    pub kept: Vec<String>,
    pub kept_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Choice {
    Chosen {
        status: Status,
    },
    /// The folder is not empty and has no manifest: the UI asks first, then
    /// sends the token back (`mirror_confirm`).
    Confirm {
        token: u64,
        name: String,
    },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub generation: u64,
    pub include_attachments: bool,
    pub manifest: Option<Manifest>,
}

#[derive(Default)]
struct Inner {
    /// False while the setting's file cannot be read: the mirror shows as off then, and nothing is
    /// written over the file, which would drop the folder it names.
    loaded: bool,
    /// A read failed: the setting read later is news to every window.
    read_failed: bool,
    folder: Option<PathBuf>,
    include_attachments: bool,
    /// Named in every manifest this mirror writes, so a folder another library mirrors is never
    /// taken for its own: going on from that manifest would delete the files it lists.
    library: Option<String>,
    generation: u64,
    revision: u64,
    paused: Option<&'static str>,
    manifest: Option<Manifest>,
    /// The manifest changed but could not be written back (the folder went
    /// away or could not be written): written on resume, never read again.
    dirty: bool,
    kept: Vec<String>,
    kept_count: u64,
    /// A manifest read anew (a folder chosen again, a launch) is told even when nothing is written.
    shown_size: Option<u64>,
    choices: HashMap<u64, PathBuf>,
    next_choice: u64,
}

pub type Notify<'a> = &'a dyn Fn(&Status);

pub struct Mirror {
    settings: PathBuf,
    home: Option<PathBuf>,
    inner: Mutex<Inner>,
}

fn display(path: &Path, home: Option<&Path>) -> String {
    match home.and_then(|home| path.strip_prefix(home).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~/{}", rest.to_string_lossy()),
        None => path.to_string_lossy().into_owned(),
    }
}

fn unopened(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
            "E_MIRROR_FOLDER_MISSING"
        }
        _ => "E_MIRROR_FOLDER_READ_ONLY",
    }
}

impl Mirror {
    pub fn new(settings: &Path, home: Option<PathBuf>) -> Self {
        Self {
            settings: settings.to_owned(),
            home,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn read_settings(&self) -> Option<Stored> {
        match std::fs::read(&self.settings) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value @ Value::Object(_)) => Some(Stored::from_value(&value)),
                _ => {
                    log::warn!("W_MIRROR_SETTINGS_UNREADABLE");
                    let kept = crate::atomic_file::keep_damaged(&self.settings, &bytes).is_ok();
                    if !kept {
                        log::warn!("W_MIRROR_SETTINGS_COPY_FAILED");
                    }
                    kept.then(Stored::default)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Stored::default()),
            Err(_) => {
                log::warn!("W_MIRROR_SETTINGS_READ_FAILED");
                None
            }
        }
    }

    /// Reads the setting at first use, and again on every use while it cannot be read.
    fn lock(&self, notify: Notify) -> Result<MutexGuard<'_, Inner>, &'static str> {
        let mut inner = self.inner.lock().map_err(|_| "E_MIRROR_LOCK_FAILED")?;
        if !inner.loaded {
            let read = self.read_settings();
            let stored = read.clone().unwrap_or_default();
            inner.loaded = read.is_some();
            inner.folder = stored.folder.map(PathBuf::from);
            inner.include_attachments = stored.include_attachments;
            inner.library = stored.library;
            if !inner.loaded {
                inner.read_failed = true;
            } else if inner.read_failed {
                inner.generation += 1;
                self.changed(&mut inner, notify);
            }
        }
        Ok(inner)
    }

    fn status(&self, inner: &Inner) -> Status {
        Status {
            revision: inner.revision,
            generation: inner.generation,
            folder: inner
                .folder
                .as_deref()
                .map(|f| display(f, self.home.as_deref())),
            include_attachments: inner.include_attachments,
            paused: inner.paused,
            size: inner.manifest.as_ref().map(Manifest::size),
            kept: inner.kept.clone(),
            kept_count: inner.kept_count,
        }
    }

    fn changed(&self, inner: &mut Inner, notify: Notify) -> Status {
        inner.revision += 1;
        let status = self.status(inner);
        inner.shown_size = status.size;
        notify(&status);
        status
    }

    fn size_changed(inner: &Inner) -> bool {
        inner.manifest.as_ref().map(Manifest::size) != inner.shown_size
    }

    fn store(
        &self,
        inner: &Inner,
        folder: Option<&Path>,
        include_attachments: bool,
    ) -> Result<(), &'static str> {
        if !inner.loaded {
            return Err(READ_FAILED);
        }
        let stored = Stored {
            folder: folder.map(|f| f.to_string_lossy().into_owned()),
            include_attachments,
            library: inner.library.clone(),
        };
        let json =
            serde_json::to_vec_pretty(&stored).map_err(|_| "E_MIRROR_SETTINGS_WRITE_FAILED")?;
        crate::atomic_file::write_replacing(&self.settings, &json)
            .map_err(|_| "E_MIRROR_SETTINGS_WRITE_FAILED")
    }

    fn library(&self, inner: &mut Inner) -> Result<String, &'static str> {
        if let Some(library) = &inner.library {
            return Ok(library.clone());
        }
        let library = uuid::Uuid::new_v4().hyphenated().to_string();
        inner.library = Some(library.clone());
        let folder = inner.folder.clone();
        if let Err(code) = self.store(inner, folder.as_deref(), inner.include_attachments) {
            inner.library = None;
            return Err(code);
        }
        Ok(library)
    }

    fn pause(&self, inner: &mut Inner, code: &'static str, notify: Notify) -> &'static str {
        if inner.paused != Some(code) {
            inner.paused = Some(code);
            log::warn!("W_MIRROR_PAUSED {code}");
            self.changed(inner, notify);
        }
        code
    }

    pub fn get(&self, notify: Notify) -> Result<Status, &'static str> {
        let inner = self.lock(notify)?;
        Ok(self.status(&inner))
    }

    /// `includeAttachments`, `turnOff` or `dismissKept` (true); anything else refuses the whole patch.
    pub fn set(&self, patch: &Map<String, Value>, notify: Notify) -> Result<Status, &'static str> {
        let mut include = None;
        let mut turn_off = false;
        let mut dismiss = false;
        for (key, value) in patch {
            match (key.as_str(), value) {
                ("includeAttachments", Value::Bool(on)) => include = Some(*on),
                ("turnOff", Value::Bool(true)) => turn_off = true,
                ("dismissKept", Value::Bool(true)) => dismiss = true,
                _ => return Err(INVALID),
            }
        }
        let mut inner = self.lock(notify)?;
        let folder = if turn_off { None } else { inner.folder.clone() };
        let include = include.unwrap_or(inner.include_attachments);
        let setting_changed = folder != inner.folder || include != inner.include_attachments;
        if setting_changed {
            self.store(&inner, folder.as_deref(), include)?;
            if folder != inner.folder {
                log::info!("I_MIRROR_OFF");
                inner.manifest = None;
                inner.dirty = false;
                inner.paused = None;
                inner.kept.clear();
                inner.kept_count = 0;
            }
            inner.folder = folder;
            inner.include_attachments = include;
            inner.generation += 1;
        }
        let dismissed = dismiss && inner.kept_count > 0;
        if dismissed {
            inner.kept.clear();
            inner.kept_count = 0;
        }
        Ok(if setting_changed || dismissed {
            self.changed(&mut inner, notify)
        } else {
            self.status(&inner)
        })
    }

    fn use_folder(
        &self,
        inner: &mut Inner,
        root: PathBuf,
        notify: Notify,
    ) -> Result<Status, &'static str> {
        self.store(inner, Some(&root), inner.include_attachments)?;
        log::info!("I_MIRROR_FOLDER_CHOSEN");
        inner.folder = Some(root);
        inner.manifest = None;
        inner.dirty = false;
        inner.paused = None;
        inner.kept.clear();
        inner.kept_count = 0;
        inner.generation += 1;
        Ok(self.changed(inner, notify))
    }

    pub fn choose(&self, picked: &Path, notify: Notify) -> Result<Choice, &'static str> {
        // Resolved once, here: a link the user picked is followed now, and
        // the folder is opened by that path, never through a link, from now on.
        let path = std::fs::canonicalize(picked).map_err(|_| "E_MIRROR_FOLDER_INVALID")?;
        let root = Root::open(&path).map_err(|_| "E_MIRROR_FOLDER_INVALID")?;
        probe_writable(&root).map_err(|_| "E_MIRROR_FOLDER_READ_ONLY")?;
        let (empty, owner) = match read_manifest(&root) {
            Ok(bytes) => (false, parse_manifest(&bytes).and_then(|m| m.library)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
                !has_entries(&root).map_err(|_| "E_MIRROR_FOLDER_INVALID")?,
                None,
            ),
            Err(_) => (false, None),
        };
        let mut inner = self.lock(notify)?;
        if !inner.loaded {
            return Err(READ_FAILED);
        }
        if empty || (owner.is_some() && owner == inner.library) {
            return Ok(Choice::Chosen {
                status: self.use_folder(&mut inner, path, notify)?,
            });
        }
        inner.next_choice += 1;
        let token = inner.next_choice;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        inner.choices.insert(token, path);
        Ok(Choice::Confirm { token, name })
    }

    pub fn confirm(&self, token: u64, notify: Notify) -> Result<Status, &'static str> {
        let mut inner = self.lock(notify)?;
        let path = inner
            .choices
            .remove(&token)
            .ok_or("E_MIRROR_CHOICE_UNKNOWN")?;
        let root = Root::open(&path).map_err(|_| "E_MIRROR_FOLDER_MISSING")?;
        let manifest = Manifest {
            library: Some(self.library(&mut inner)?),
            ..Manifest::default()
        };
        save_manifest(&root, &manifest).map_err(|_| "E_MIRROR_FOLDER_READ_ONLY")?;
        self.use_folder(&mut inner, path, notify)
    }

    pub fn open(&self, known: Option<u64>, notify: Notify) -> Result<Opened, &'static str> {
        let mut inner = self.lock(notify)?;
        let path = inner.folder.clone().ok_or("E_MIRROR_OFF")?;
        let root = match Root::open(&path) {
            Ok(root) => root,
            Err(e) => return Err(self.pause(&mut inner, unopened(&e), notify)),
        };
        if inner.paused.is_some() {
            inner.generation += 1;
            if inner.dirty
                && let Some(manifest) = &inner.manifest
            {
                // What the last batch did is only in memory: it goes back to
                // the folder first.
                if save_manifest(&root, manifest).is_err() {
                    return Err(self.pause(&mut inner, "E_MIRROR_FOLDER_READ_ONLY", notify));
                }
                inner.dirty = false;
            } else {
                // The folder may have been put back from elsewhere: its own
                // manifest is the one to go on from.
                inner.manifest = None;
            }
        }
        if inner.manifest.is_none() {
            let (mut manifest, fresh) = match read_manifest(&root) {
                Ok(bytes) => match parse_manifest(&bytes) {
                    Some(manifest) => (manifest, false),
                    None => {
                        return Err(self.pause(&mut inner, "E_MIRROR_MANIFEST_INVALID", notify));
                    }
                },
                // A link or a folder at the manifest's name: no manifest.
                Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                    return Err(self.pause(&mut inner, "E_MIRROR_MANIFEST_INVALID", notify));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if has_entries(&root).unwrap_or(true) {
                        return Err(self.pause(&mut inner, "E_MIRROR_MANIFEST_MISSING", notify));
                    }
                    (Manifest::default(), true)
                }
                Err(_) => return Err(self.pause(&mut inner, "E_MIRROR_FOLDER_READ_ONLY", notify)),
            };
            let library = self.library(&mut inner)?;
            // A manifest written before manifests named their library is this mirror's own: it
            // is in the folder this mirror already uses.
            let unnamed = match &manifest.library {
                None => true,
                Some(owner) if *owner == library => false,
                Some(_) => {
                    return Err(self.pause(&mut inner, "E_MIRROR_MANIFEST_FOREIGN", notify));
                }
            };
            manifest.library = Some(library);
            let written = probe_writable(&root).and_then(|()| {
                if fresh {
                    create_manifest(&root, &manifest)
                } else if unnamed {
                    save_manifest(&root, &manifest)
                } else {
                    Ok(())
                }
            });
            match written {
                Ok(()) => {}
                // A manifest appeared since the folder was found empty: it
                // stays, and the next pass reads it.
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err("E_MIRROR_STALE");
                }
                Err(_) => return Err(self.pause(&mut inner, "E_MIRROR_FOLDER_READ_ONLY", notify)),
            }
            inner.manifest = Some(manifest);
        }
        let resumed = inner.paused.take().is_some();
        if resumed {
            log::info!("I_MIRROR_RESUMED");
        }
        if resumed || Self::size_changed(&inner) {
            self.changed(&mut inner, notify);
        }
        Ok(Opened {
            generation: inner.generation,
            include_attachments: inner.include_attachments,
            manifest: (known != Some(inner.generation))
                .then(|| inner.manifest.clone())
                .flatten(),
        })
    }

    fn current(
        &self,
        inner: &mut Inner,
        generation: u64,
        notify: Notify,
    ) -> Result<Root, &'static str> {
        let path = inner.folder.clone().ok_or("E_MIRROR_OFF")?;
        if generation != inner.generation || inner.manifest.is_none() {
            return Err("E_MIRROR_STALE");
        }
        Root::open(&path).map_err(|e| self.pause(inner, unopened(&e), notify))
    }

    pub fn check(
        &self,
        generation: u64,
        paths: Option<&[String]>,
        notify: Notify,
    ) -> Result<HashMap<String, Option<String>>, &'static str> {
        if let Some(paths) = paths
            && (paths.len() > MAX_PATHS || !paths.iter().all(|p| crate::export::plain_rel_path(p)))
        {
            return Err("E_MIRROR_PATHS_INVALID");
        }
        let (root, listed) = {
            let mut inner = self.lock(notify)?;
            let root = self.current(&mut inner, generation, notify)?;
            let manifest = inner.manifest.as_ref().ok_or("E_MIRROR_STALE")?;
            let listed: Vec<(String, String)> = manifest
                .notes
                .values()
                .map(|e| (e.path.clone(), e.sha256.clone()))
                .chain(
                    manifest
                        .files
                        .values()
                        .filter_map(|e| Some((e.path.clone(), e.sha256.clone()?))),
                )
                .collect();
            (root, listed)
        };
        // Hashing runs without holding the state: the Settings window reads it meanwhile.
        Ok(match paths {
            Some(paths) => paths
                .iter()
                .map(|p| (p.clone(), disk_state(&root, p)))
                .collect(),
            None => listed
                .into_iter()
                .filter_map(|(path, sha256)| {
                    let state = disk_state(&root, &path);
                    (state.as_deref() != Some(sha256.as_str())).then_some((path, state))
                })
                .collect(),
        })
    }

    /// A failure that pauses the mirror stops the run (it is the last result). The manifest is
    /// written back once the operations have run.
    pub fn apply(
        &self,
        generation: u64,
        ops: &[Value],
        load: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
        notify: Notify,
    ) -> Result<Vec<OpResult>, &'static str> {
        if ops.len() > MAX_OPS {
            return Err("E_MIRROR_OPS_INVALID");
        }
        let mut inner = self.lock(notify)?;
        let root = self.current(&mut inner, generation, notify)?;
        let mut manifest = inner.manifest.take().ok_or("E_MIRROR_STALE")?;
        let kept_count = inner.kept_count;
        let mut changed = inner.dirty;
        let mut results = Vec::with_capacity(ops.len());
        let mut paused = None;
        for value in ops {
            let result = match serde_json::from_value::<Op>(value.clone()) {
                Ok(op) => folder::run(&root, &mut manifest, &op, load),
                Err(_) => OpResult {
                    code: Some("E_MIRROR_OP_INVALID"),
                    ..OpResult::default()
                },
            };
            changed |= result.code.is_none() || result.moved;
            if let Some(kept) = &result.kept {
                inner.kept_count += 1;
                if inner.kept.len() < KEPT_NAMED {
                    inner.kept.push(kept.clone());
                }
            }
            let stop = result.pauses();
            if stop {
                paused = result.code;
            }
            results.push(result);
            if stop {
                break;
            }
        }
        if changed {
            let written = save_manifest(&root, &manifest);
            inner.dirty = written.is_err();
            if written.is_err() {
                paused.get_or_insert(if root.is_missing() {
                    "E_MIRROR_FOLDER_MISSING"
                } else {
                    "E_MIRROR_FOLDER_READ_ONLY"
                });
            }
        }
        inner.manifest = Some(manifest);
        if let Some(code) = paused {
            self.pause(&mut inner, code, notify);
        } else if Self::size_changed(&inner) || inner.kept_count != kept_count {
            self.changed(&mut inner, notify);
        }
        Ok(results)
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "E_MIRROR_TASK".to_string())?
        .map_err(String::from)
}

fn announcer(app: &AppHandle) -> impl Fn(&Status) + Send + 'static {
    let app = app.clone();
    move |status| {
        if app.emit(CHANGED_EVENT, status).is_err() {
            log::warn!("W_MIRROR_EMIT_FAILED");
        }
    }
}

#[tauri::command]
pub async fn mirror_get(app: AppHandle, mirror: State<'_, Arc<Mirror>>) -> Result<Status, String> {
    let mirror = Arc::clone(&mirror);
    let notify = announcer(&app);
    blocking(move || mirror.get(&notify)).await
}

#[tauri::command]
pub async fn mirror_set(
    app: AppHandle,
    mirror: State<'_, Arc<Mirror>>,
    patch: Map<String, Value>,
) -> Result<Status, String> {
    let mirror = Arc::clone(&mirror);
    let notify = announcer(&app);
    blocking(move || mirror.set(&patch, &notify)).await
}

#[tauri::command]
pub async fn mirror_choose(
    app: AppHandle,
    window: WebviewWindow,
    mirror: State<'_, Arc<Mirror>>,
) -> Result<Choice, String> {
    let Some(picked) = pick_folder(&app, &window).await? else {
        return Ok(Choice::Cancelled);
    };
    let mirror = Arc::clone(&mirror);
    let notify = announcer(&app);
    blocking(move || mirror.choose(&picked, &notify)).await
}

#[cfg(desktop)]
async fn pick_folder(app: &AppHandle, window: &WebviewWindow) -> Result<Option<PathBuf>, String> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(strings::MIRROR_FOLDER_TITLE)
        .set_parent(window)
        .set_can_create_directories(true)
        .pick_folder(move |path| {
            let _ = reply.send(path.map(|p| p.into_path()));
        });
    match answer.await {
        Ok(None) => Ok(None),
        Ok(Some(Ok(path))) => Ok(Some(path)),
        _ => Err("E_MIRROR_FOLDER_INVALID".into()),
    }
}

#[cfg(mobile)]
async fn pick_folder(_app: &AppHandle, _window: &WebviewWindow) -> Result<Option<PathBuf>, String> {
    Err("E_MIRROR_FOLDER_UNSUPPORTED".into())
}

#[tauri::command]
pub async fn mirror_confirm(
    app: AppHandle,
    mirror: State<'_, Arc<Mirror>>,
    token: u64,
) -> Result<Status, String> {
    let mirror = Arc::clone(&mirror);
    let notify = announcer(&app);
    blocking(move || mirror.confirm(token, &notify)).await
}

#[tauri::command]
pub async fn mirror_open(
    app: AppHandle,
    mirror: State<'_, Arc<Mirror>>,
    known: Option<u64>,
) -> Result<Opened, String> {
    let mirror = Arc::clone(&mirror);
    let notify = announcer(&app);
    blocking(move || mirror.open(known, &notify)).await
}

#[tauri::command]
pub async fn mirror_check(
    app: AppHandle,
    mirror: State<'_, Arc<Mirror>>,
    generation: u64,
    paths: Option<Vec<String>>,
) -> Result<HashMap<String, Option<String>>, String> {
    let mirror = Arc::clone(&mirror);
    let notify = announcer(&app);
    blocking(move || mirror.check(generation, paths.as_deref(), &notify)).await
}

/// Bytes are read one at a time from a blocking task, so they never cross IPC.
fn attachments(db: Db) -> impl FnMut(&str) -> Option<Vec<u8>> {
    move |id: &str| {
        let id = id.to_owned();
        tauri::async_runtime::block_on(db.call(move |store| store.get_file(&id)))
            .ok()
            .flatten()
            .map(|file| file.data)
    }
}

#[tauri::command]
pub async fn mirror_apply(
    app: AppHandle,
    mirror: State<'_, Arc<Mirror>>,
    db: State<'_, Db>,
    generation: u64,
    ops: Vec<Value>,
) -> Result<Vec<OpResult>, String> {
    let mirror = Arc::clone(&mirror);
    let mut load = attachments(db.inner().clone());
    let notify = announcer(&app);
    blocking(move || mirror.apply(generation, &ops, &mut load, &notify)).await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub id: String,
    pub body_md: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileName {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileHash {
    pub id: String,
    pub sha256: String,
}

fn valid_ids(ids: &[String], max: usize, valid: fn(&str) -> bool) -> bool {
    ids.len() <= max && ids.iter().all(|id| valid(id))
}

fn file_hashes(ids: &[String], load: &mut dyn FnMut(&str) -> Option<Vec<u8>>) -> Vec<FileHash> {
    ids.iter()
        .filter_map(|id| {
            Some(FileHash {
                id: id.clone(),
                sha256: sha256_hex(&load(id)?),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn mirror_bodies(db: State<'_, Db>, ids: Vec<String>) -> Result<Vec<Body>, String> {
    if !valid_ids(&ids, MAX_IDS, valid_note_id) {
        return Err("E_MIRROR_IDS_INVALID".into());
    }
    let found = db
        .call(move |store| store.note_bodies(&ids))
        .await
        .map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .map(|(id, body_md)| Body { id, body_md })
        .collect())
}

#[tauri::command]
pub async fn mirror_files(db: State<'_, Db>, ids: Vec<String>) -> Result<Vec<FileName>, String> {
    // Any UUID a link holds: one that is no attachment is simply not found.
    if !valid_ids(&ids, MAX_IDS, folder::valid_uuid) {
        return Err("E_MIRROR_IDS_INVALID".into());
    }
    let found = db
        .call(move |store| store.file_names(&ids))
        .await
        .map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .map(|(id, name, mime)| FileName {
            id,
            name: crate::export::attachment_name(&name, &mime),
        })
        .collect())
}

/// The SHA-256 of attachments' bytes (main window): the plan asks for it
/// only when a file is in the way of a copy, to tell a copy Devot wrote but
/// never listed (taken back) from someone else's file. Each attachment is
/// read on its own, and only its hash crosses IPC.
#[tauri::command]
pub async fn mirror_hashes(db: State<'_, Db>, ids: Vec<String>) -> Result<Vec<FileHash>, String> {
    if !valid_ids(&ids, MAX_HASH_IDS, folder::valid_uuid) {
        return Err("E_MIRROR_IDS_INVALID".into());
    }
    let mut load = attachments(db.inner().clone());
    blocking(move || Ok(file_hashes(&ids, &mut load))).await
}

pub fn manage(app: &tauri::App, data_dir: &Path) {
    let home = app.path().home_dir().ok();
    app.manage(Arc::new(Mirror::new(&data_dir.join(SETTINGS_FILE), home)));
}

#[cfg(test)]
mod tests;
