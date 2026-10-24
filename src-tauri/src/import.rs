//! Markdown and HTML import (File > Import, and a notebook's Import menu). Rust picks what to
//! import, lists the files and reads them; the core worker turns them into notebooks and notes
//! (`src/core/import.ts`).
//! The web view never names a path: the user picks folders or files in a native panel and Rust
//! keeps them as an import session. The UI asks for files by session ID and a path relative to what
//! was picked, and Rust only reads files inside it: hidden files and folders are skipped, the scan
//! never walks symbolic links (an image may be reached through one, but only to a visible file
//! inside the folder), and files over 10 MB are left out. Images are stored as attachments straight
//! from disk, so their bytes never cross IPC.
//! A folder scan runs on its own thread; closing the session (`import_finish`) cancels a scan still
//! running. Nothing is written until the UI imports the scan.

use crate::commands::files::{MAX_FILE_BYTES, Upload, store_upload};
use crate::commands::notes::valid_note_id;
use crate::storage::Db;
use crate::strings;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Markdown files and images share the attachments' size cap.
pub const MAX_NOTE_BYTES: u64 = MAX_FILE_BYTES as u64;
pub const MAX_FILES: usize = 10_000;
/// Directory entries one scan looks at, so picking a huge folder fails fast.
pub const MAX_ENTRIES: usize = 200_000;
pub const MAX_DEPTH: usize = 64;
const MAX_PATH_BYTES: usize = 4096;
const MAX_NAME_CHARS: usize = 200;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

pub const SCANNING_EVENT: &str = "devot://import-scanning";
pub const PROGRESS_EVENT: &str = "devot://import-progress";
pub const READY_EVENT: &str = "devot://import-ready";
pub const FAILED_EVENT: &str = "devot://import-failed";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub path: String,
    pub code: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Folder,
    Folders,
    Files,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub prefix: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub roots: Vec<Root>,
    pub name: String,
    pub kind: Kind,
    pub files: Vec<Item>,
    pub images: Vec<Item>,
    pub skipped: Vec<Problem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Scan {
    pub id: u64,
    pub name: String,
    pub kind: Kind,
    pub files: Vec<Item>,
    pub images: Vec<Item>,
    pub skipped: Vec<Problem>,
    /// None from File > Import; set when started from a notebook's menu (the sheet then skips
    /// choosing one).
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Scanning<'a> {
    id: u64,
    name: &'a str,
    kind: Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub files: usize,
    pub images: usize,
}

#[derive(Debug, Clone, Serialize)]
struct ProgressEvent {
    id: u64,
    files: usize,
    images: usize,
}

/// Why a scan failed; `id` is null when it failed before it had one.
#[derive(Debug, Clone, Serialize)]
struct Failed {
    id: Option<u64>,
    code: &'static str,
}

fn has_extension(name: &str, extensions: &[&str]) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| extensions.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

const MARKDOWN: &[&str] = &["md", "markdown"];
const HTML: &[&str] = &["html", "htm"];
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif"];

pub(crate) fn is_markdown(name: &str) -> bool {
    has_extension(name, MARKDOWN)
}

pub(crate) fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_owned()
    } else {
        format!("{rel}/{name}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub files: usize,
    pub entries: usize,
    pub depth: usize,
}

impl Limits {
    pub const DEFAULT: Limits = Limits {
        files: MAX_FILES,
        entries: MAX_ENTRIES,
        depth: MAX_DEPTH,
    };
}

pub struct Watch<'a> {
    pub cancelled: &'a AtomicBool,
    pub progress: &'a dyn Fn(Progress),
}

#[cfg(test)]
impl Watch<'_> {
    fn idle<T>(f: impl FnOnce(&Watch<'_>) -> T) -> T {
        let cancelled = AtomicBool::new(false);
        f(&Watch {
            cancelled: &cancelled,
            progress: &|_| {},
        })
    }
}

#[cfg(test)]
pub fn scan(root: &Path) -> Result<Found, &'static str> {
    scan_with(root, Limits::DEFAULT)
}

#[cfg(test)]
pub fn scan_with(root: &Path, limits: Limits) -> Result<Found, &'static str> {
    Watch::idle(|watch| scan_folders(&[root.to_path_buf()], limits, watch))
}

fn unique(name: &str, taken: &mut HashSet<String>) -> String {
    // A path component the UI sends back must not be hidden.
    let base = match name.trim_start_matches('.') {
        "" => "Folder",
        rest => rest,
    };
    let mut candidate = base.to_owned();
    let mut n = 1;
    while !taken.insert(candidate.to_lowercase()) {
        n += 1;
        candidate = format!("{base} {n}");
    }
    candidate
}

fn folder_name(root: &Path) -> Result<String, &'static str> {
    Ok(root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("E_IMPORT_ROOT_INVALID")?
        .to_owned())
}

/// One folder's paths are relative to it; several folders' start with each one's name (made
/// unique). `limits` hold for all of them together.
pub fn scan_folders(
    roots: &[PathBuf],
    limits: Limits,
    watch: &Watch<'_>,
) -> Result<Found, &'static str> {
    let mut picked = Vec::new();
    let mut taken = HashSet::new();
    for root in roots {
        let path = std::fs::canonicalize(root).map_err(|_| "E_IMPORT_ROOT_INVALID")?;
        if !path.is_dir() {
            return Err("E_IMPORT_ROOT_INVALID");
        }
        let name = folder_name(&path)?;
        let prefix = if roots.len() == 1 {
            String::new()
        } else {
            unique(&name, &mut taken)
        };
        picked.push((Root { prefix, path }, name));
    }
    let name = picked.first().ok_or("E_IMPORT_ROOT_INVALID")?.1.clone();
    let mut lists = Lists::default();
    for (root, _) in &picked {
        walk(root, limits, watch, &mut lists)?;
    }
    (watch.progress)(lists.progress());
    Ok(lists.found(
        picked.into_iter().map(|(root, _)| root).collect(),
        name,
        if roots.len() == 1 {
            Kind::Folder
        } else {
            Kind::Folders
        },
    ))
}

#[derive(Default)]
struct Lists {
    files: Vec<Item>,
    images: Vec<Item>,
    skipped: Vec<Problem>,
    entries: usize,
    reported: Option<Instant>,
}

impl Lists {
    fn progress(&self) -> Progress {
        Progress {
            files: self.files.len(),
            images: self.images.len(),
        }
    }

    fn found(mut self, roots: Vec<Root>, name: String, kind: Kind) -> Found {
        self.files.sort_by(|a, b| a.path.cmp(&b.path));
        self.images.sort_by(|a, b| a.path.cmp(&b.path));
        self.skipped.sort_by(|a, b| a.path.cmp(&b.path));
        Found {
            roots,
            name,
            kind,
            files: self.files,
            images: self.images,
            skipped: self.skipped,
        }
    }
}

fn walk(
    root: &Root,
    limits: Limits,
    watch: &Watch<'_>,
    lists: &mut Lists,
) -> Result<(), &'static str> {
    let mut stack = vec![(root.path.clone(), root.prefix.clone(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        if watch.cancelled.load(Ordering::Relaxed) {
            return Err("E_IMPORT_CANCELLED");
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            lists.skipped.push(Problem {
                path: rel,
                code: "E_IMPORT_UNREADABLE",
            });
            continue;
        };
        // Counted and checked while listing, so one huge folder fails fast
        // and a cancel is seen before it has all been read.
        let mut list = Vec::new();
        for entry in read.flatten() {
            lists.entries += 1;
            if lists.entries > limits.entries {
                return Err("E_IMPORT_FOLDER_TOO_LARGE");
            }
            if watch.cancelled.load(Ordering::Relaxed) {
                return Err("E_IMPORT_CANCELLED");
            }
            list.push(entry);
        }
        list.sort_by_key(|e| e.file_name());
        for entry in list {
            if lists
                .reported
                .is_none_or(|at| at.elapsed() >= PROGRESS_EVERY)
            {
                lists.reported = Some(Instant::now());
                (watch.progress)(lists.progress());
            }
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                lists.skipped.push(Problem {
                    path: join(&rel, &file_name.to_string_lossy()),
                    code: "E_IMPORT_NAME_INVALID",
                });
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let child = join(&rel, name);
            let Ok(kind) = entry.file_type() else {
                lists.skipped.push(Problem {
                    path: child,
                    code: "E_IMPORT_UNREADABLE",
                });
                continue;
            };
            let image = has_extension(name, IMAGES);
            if kind.is_symlink() {
                if let Some(code) = link_problem(&root.path, &entry.path(), name) {
                    lists.skipped.push(Problem { path: child, code });
                }
            } else if kind.is_dir() {
                if depth + 1 > limits.depth {
                    lists.skipped.push(Problem {
                        path: child,
                        code: "E_IMPORT_TOO_DEEP",
                    });
                } else {
                    stack.push((entry.path(), child, depth + 1));
                }
            } else if kind.is_file() && (is_markdown(name) || image) {
                match entry.metadata() {
                    Ok(meta) if meta.len() > MAX_NOTE_BYTES => lists.skipped.push(Problem {
                        path: child,
                        code: "E_IMPORT_FILE_TOO_LARGE",
                    }),
                    Ok(meta) if image => lists.images.push(Item {
                        path: child,
                        bytes: meta.len(),
                    }),
                    Ok(meta) => {
                        lists.files.push(Item {
                            path: child,
                            bytes: meta.len(),
                        });
                        if lists.files.len() > limits.files {
                            return Err("E_IMPORT_TOO_MANY_FILES");
                        }
                    }
                    Err(_) => lists.skipped.push(Problem {
                        path: child,
                        code: "E_IMPORT_UNREADABLE",
                    }),
                }
            }
        }
    }
    Ok(())
}

/// Each file is read from its folder, which is also where its images may be. From several folders,
/// each path starts with its folder's name (made unique).
pub fn pick_found(paths: &[PathBuf], html: bool) -> Result<Found, &'static str> {
    let extensions = if html { HTML } else { MARKDOWN };
    let mut parents: Vec<PathBuf> = Vec::new();
    let mut picked = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        let shown = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let checked = std::fs::canonicalize(path)
            .ok()
            .and_then(|p| std::fs::metadata(&p).ok().map(|m| (p, m)));
        let Some((real, meta)) = checked.filter(|(_, m)| m.is_file()) else {
            skipped.push((None, shown, "E_IMPORT_UNREADABLE"));
            continue;
        };
        let (Some(parent), Some(name)) = (
            real.parent().map(Path::to_path_buf),
            real.file_name().and_then(|n| n.to_str()).map(str::to_owned),
        ) else {
            skipped.push((None, shown, "E_IMPORT_NAME_INVALID"));
            continue;
        };
        let at = match parents.iter().position(|p| *p == parent) {
            Some(at) => at,
            None => {
                parents.push(parent);
                parents.len() - 1
            }
        };
        if name.starts_with('.') {
            skipped.push((Some(at), name, "E_IMPORT_PATH_INVALID"));
        } else if !has_extension(&name, extensions) {
            skipped.push((Some(at), name, "E_IMPORT_FILE_TYPE"));
        } else if meta.len() > MAX_NOTE_BYTES {
            skipped.push((Some(at), name, "E_IMPORT_FILE_TOO_LARGE"));
        } else {
            picked.push((at, name, meta.len()));
            if picked.len() > MAX_FILES {
                return Err("E_IMPORT_TOO_MANY_FILES");
            }
        }
    }
    let mut taken = HashSet::new();
    let mut roots: Vec<Root> = parents
        .into_iter()
        .map(|path| Root {
            prefix: String::new(),
            path,
        })
        .collect();
    if roots.len() > 1 {
        for root in &mut roots {
            let name = folder_name(&root.path).unwrap_or_default();
            root.prefix = unique(&name, &mut taken);
        }
    }
    let rel = |at: usize, name: &str| join(&roots[at].prefix, name);
    let mut lists = Lists::default();
    for (at, name, bytes) in picked {
        lists.files.push(Item {
            path: rel(at, &name),
            bytes,
        });
    }
    for (at, name, code) in skipped {
        let path = at.map_or(name.clone(), |at| rel(at, &name));
        lists.skipped.push(Problem { path, code });
    }
    let name = paths
        .first()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(lists.found(roots, name, Kind::Files))
}

/// Links are never walked: a visible target inside the folder is imported
/// under its own path, so following it would only duplicate notes. A link
/// to a folder or Markdown file that is hidden, outside the folder or
/// missing is reported, so the user learns why it was left out; links to
/// anything else are ignored like any other file.
fn link_problem(root: &Path, link: &Path, name: &str) -> Option<&'static str> {
    match std::fs::metadata(link) {
        Ok(meta) if meta.is_dir() || is_markdown(name) => {
            let target = std::fs::canonicalize(link).ok()?;
            let Ok(inside) = target.strip_prefix(root) else {
                return Some("E_IMPORT_LINK_OUTSIDE");
            };
            inside
                .components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
                .then_some("E_IMPORT_LINK_HIDDEN")
        }
        Ok(_) => None,
        Err(_) => is_markdown(name).then_some("E_IMPORT_UNREADABLE"),
    }
}

/// The resolved file (links followed) must be inside `root` and not hidden there either. A `\` is
/// an ordinary name character here, as it is on disk (only `/` separates components).
pub fn resolve(root: &Path, rel: &str) -> Result<(PathBuf, u64), &'static str> {
    if rel.is_empty() || rel.len() > MAX_PATH_BYTES || rel.contains('\0') {
        return Err("E_IMPORT_PATH_INVALID");
    }
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) if !part.to_string_lossy().starts_with('.') => {}
            _ => return Err("E_IMPORT_PATH_INVALID"),
        }
    }
    let path = std::fs::canonicalize(root.join(rel)).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "E_IMPORT_FILE_NOT_FOUND",
        _ => "E_IMPORT_UNREADABLE",
    })?;
    let Ok(inside) = path.strip_prefix(root) else {
        return Err("E_IMPORT_PATH_OUTSIDE");
    };
    if inside
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Err("E_IMPORT_PATH_INVALID");
    }
    let meta = std::fs::metadata(&path).map_err(|_| "E_IMPORT_UNREADABLE")?;
    if !meta.is_file() {
        return Err("E_IMPORT_FILE_NOT_FOUND");
    }
    Ok((path, meta.len()))
}

fn read_capped(path: &Path, max: u64) -> Result<Vec<u8>, &'static str> {
    let file = std::fs::File::open(path).map_err(|_| "E_IMPORT_UNREADABLE")?;
    let mut data = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut data)
        .map_err(|_| "E_IMPORT_UNREADABLE")?;
    if data.len() as u64 > max {
        return Err("E_IMPORT_FILE_TOO_LARGE");
    }
    Ok(data)
}

pub fn read_note(root: &Path, rel: &str) -> Result<String, &'static str> {
    let (path, size) = resolve(root, rel)?;
    if size > MAX_NOTE_BYTES {
        return Err("E_IMPORT_FILE_TOO_LARGE");
    }
    let text =
        String::from_utf8(read_capped(&path, MAX_NOTE_BYTES)?).map_err(|_| "E_IMPORT_NOT_UTF8")?;
    Ok(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => text,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct Image {
    pub name: String,
    pub data: Vec<u8>,
}

pub fn read_image(root: &Path, rel: &str) -> Result<Image, &'static str> {
    let (path, size) = resolve(root, rel)?;
    if size == 0 || size > MAX_FILE_BYTES as u64 {
        return Err("E_FILE_SIZE_INVALID");
    }
    let data = read_capped(&path, MAX_FILE_BYTES as u64).map_err(|code| match code {
        "E_IMPORT_FILE_TOO_LARGE" => "E_FILE_SIZE_INVALID",
        other => other,
    })?;
    let name: String = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    Ok(Image {
        name: if name.is_empty() {
            "image".into()
        } else {
            name
        },
        data,
    })
}

struct Session {
    roots: Vec<Root>,
    files: HashSet<String>,
    shallow: bool,
}

/// How deep an image of a picked file may be: in the file's own folder or
/// one folder below it (`shot.png`, `img/shot.png`, a saved page's
/// `Page_files/shot.png`), never deeper, so picking one file never opens
/// the rest of a large folder (all of Downloads, say) to the import.
pub const SHALLOW: usize = 2;

pub fn read_session_image(root: &Path, rel: &str, shallow: bool) -> Result<Image, &'static str> {
    if shallow {
        let (path, _) = resolve(root, rel)?;
        let inside = path
            .strip_prefix(root)
            .map_err(|_| "E_IMPORT_PATH_OUTSIDE")?;
        let name = inside
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if inside.components().count() > SHALLOW || !has_extension(name, IMAGES) {
            return Err("E_IMPORT_PATH_OUTSIDE");
        }
    }
    read_image(root, rel)
}

#[derive(Default)]
pub struct Imports {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    sessions: Mutex<HashMap<u64, Session>>,
}

impl Imports {
    pub fn begin(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, cancelled.clone());
        }
        (id, cancelled)
    }

    /// None when the scan was cancelled meanwhile.
    pub fn ready(&self, id: u64, found: Found, destination: Option<String>) -> Option<Scan> {
        // The pending entry goes and the session comes under the one lock
        // `finish` takes first, so a finish never falls between them (and
        // the session it was meant to end is never left open).
        let mut pending = self.pending.lock().ok()?;
        let flag = pending.remove(&id)?;
        if flag.load(Ordering::Relaxed) {
            return None;
        }
        let session = Session {
            shallow: found.kind == Kind::Files,
            roots: found.roots,
            files: found.files.iter().map(|f| f.path.clone()).collect(),
        };
        self.sessions.lock().ok()?.insert(id, session);
        drop(pending);
        Some(Scan {
            id,
            name: found.name,
            kind: found.kind,
            files: found.files,
            images: found.images,
            skipped: found.skipped,
            destination,
        })
    }

    pub fn start(&self, found: Found, destination: Option<String>) -> Scan {
        let (id, _) = self.begin();
        // A session just begun is never cancelled: the fallback is not used.
        self.ready(id, found, destination).unwrap_or_else(|| Scan {
            id,
            name: String::new(),
            kind: Kind::Files,
            files: Vec::new(),
            images: Vec::new(),
            skipped: Vec::new(),
            destination: None,
        })
    }

    fn failed(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    fn root_for(&self, id: u64, rel: &str, note: bool) -> Result<(PathBuf, String), &'static str> {
        self.place(id, rel, note).map(|(root, rel, _)| (root, rel))
    }

    fn place(
        &self,
        id: u64,
        rel: &str,
        note: bool,
    ) -> Result<(PathBuf, String, bool), &'static str> {
        let sessions = self.sessions.lock().map_err(|_| "E_IMPORT_SESSION")?;
        let session = sessions.get(&id).ok_or("E_IMPORT_SESSION")?;
        if note && !session.files.contains(rel) {
            return Err("E_IMPORT_PATH_UNKNOWN");
        }
        let shallow = session.shallow;
        for root in &session.roots {
            if root.prefix.is_empty() {
                return Ok((root.path.clone(), rel.to_owned(), shallow));
            }
            if let Some(inside) = rel
                .strip_prefix(root.prefix.as_str())
                .and_then(|r| r.strip_prefix('/'))
            {
                return Ok((root.path.clone(), inside.to_owned(), shallow));
            }
        }
        Err("E_IMPORT_PATH_OUTSIDE")
    }

    pub fn finish(&self, id: u64) {
        if let Ok(pending) = self.pending.lock()
            && let Some(flag) = pending.get(&id)
        {
            flag.store(true, Ordering::Relaxed);
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&id);
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "E_IMPORT_FAILED".to_string())?
        .map_err(String::from)
}

#[tauri::command]
pub async fn import_read(
    imports: State<'_, Imports>,
    id: u64,
    path: String,
) -> Result<String, String> {
    let (root, rel) = imports.root_for(id, &path, true)?;
    blocking(move || read_note(&root, &rel)).await
}

#[tauri::command]
pub async fn import_attach(
    imports: State<'_, Imports>,
    db: State<'_, Db>,
    id: u64,
    path: String,
    file_id: String,
    note_id: String,
) -> Result<(), String> {
    if !valid_note_id(&file_id) {
        return Err("E_FILE_ID_INVALID".into());
    }
    if !valid_note_id(&note_id) {
        return Err("E_NOTE_ID_INVALID".into());
    }
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err("E_IMPORT_PATH_INVALID".into());
    }
    let (root, rel, shallow) = imports.place(id, &path, false)?;
    let image = blocking(move || read_session_image(&root, &rel, shallow)).await?;
    let upload = Upload {
        id: file_id,
        note_id,
        name: image.name,
    };
    store_upload(&db, upload, image.data).await
}

#[tauri::command]
pub fn import_finish(imports: State<'_, Imports>, id: u64) {
    imports.finish(id);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Pick {
    MarkdownFiles,
    MarkdownFolders,
    HtmlFiles,
}

/// Sends `event` to the main window an import began in (`target`), or the frontmost one when that
/// window is gone.
fn emit<S: Serialize + Clone>(app: &AppHandle, target: &str, event: &str, payload: S) {
    let label = crate::main_windows::live_or_front(app, target);
    if app.emit_to(label, event, payload).is_err() {
        log::warn!("W_IMPORT_EVENT_FAILED");
    }
}

fn fail(app: &AppHandle, target: &str, id: Option<u64>, code: &'static str) {
    log::warn!("W_IMPORT_FAILED {code}");
    emit(app, target, FAILED_EVENT, Failed { id, code });
}

fn pick_destination(book_id: Option<String>) -> Result<Option<String>, &'static str> {
    match book_id {
        Some(id) if !valid_note_id(&id) => Err("E_BOOK_ID_INVALID"),
        other => Ok(other),
    }
}

/// A cancelled panel sends nothing, so no preset outlives it.
#[tauri::command]
pub fn import_pick(
    app: AppHandle,
    window: tauri::WebviewWindow,
    kind: Pick,
    book_id: Option<String>,
) -> Result<(), String> {
    if !crate::main_windows::is_main(window.label()) {
        return Err("E_MAIN_WINDOW_ONLY".into());
    }
    let destination = pick_destination(book_id)?;
    pick(&app, kind, destination, window.label());
    Ok(())
}

/// Asks for the files over the main window `target`, which hears the import's events.
pub fn pick(app: &AppHandle, pick: Pick, destination: Option<String>, target: &str) {
    let title = match pick {
        Pick::MarkdownFiles => strings::IMPORT_MARKDOWN_FILES_TITLE,
        Pick::MarkdownFolders => strings::IMPORT_MARKDOWN_TITLE,
        Pick::HtmlFiles => strings::IMPORT_HTML_FILES_TITLE,
    };
    #[cfg_attr(mobile, allow(unused_mut))]
    let mut dialog = app.dialog().file().set_title(title);
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(target) {
        dialog = dialog.set_parent(&window);
    }
    let app = app.clone();
    let target = target.to_owned();
    match pick {
        #[cfg(mobile)]
        Pick::MarkdownFolders => fail(&app, &target, None, "E_IMPORT_FOLDERS_UNSUPPORTED"),
        #[cfg(desktop)]
        Pick::MarkdownFolders => dialog.pick_folders(move |folders| {
            let Some(folders) = folders else { return };
            let paths: Result<Vec<PathBuf>, _> =
                folders.into_iter().map(|f| f.into_path()).collect();
            match paths {
                Ok(paths) if !paths.is_empty() => {
                    scan_in_background(app, paths, destination, target)
                }
                _ => fail(&app, &target, None, "E_IMPORT_ROOT_INVALID"),
            }
        }),
        Pick::MarkdownFiles | Pick::HtmlFiles => {
            let html = pick == Pick::HtmlFiles;
            let filter = if html { HTML } else { MARKDOWN };
            dialog.add_filter(title, filter).pick_files(move |files| {
                let Some(files) = files else { return };
                let paths: Result<Vec<PathBuf>, _> =
                    files.into_iter().map(|f| f.into_path()).collect();
                let Ok(paths) = paths else {
                    fail(&app, &target, None, "E_IMPORT_ROOT_INVALID");
                    return;
                };
                match pick_found(&paths, html) {
                    Ok(found) => {
                        let scan = app.state::<Imports>().start(found, destination);
                        log::info!(
                            "I_IMPORT_PICKED {} files={} skipped={}",
                            scan.id,
                            scan.files.len(),
                            scan.skipped.len()
                        );
                        emit(&app, &target, READY_EVENT, scan);
                    }
                    Err(code) => fail(&app, &target, None, code),
                }
            })
        }
    }
}

fn scan_in_background(
    app: AppHandle,
    paths: Vec<PathBuf>,
    destination: Option<String>,
    target: String,
) {
    let (id, cancelled) = app.state::<Imports>().begin();
    let name = paths
        .first()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = if paths.len() == 1 {
        Kind::Folder
    } else {
        Kind::Folders
    };
    emit(
        &app,
        &target,
        SCANNING_EVENT,
        Scanning {
            id,
            name: &name,
            kind,
        },
    );
    let worker = app.clone();
    let worker_target = target.clone();
    let spawned = std::thread::Builder::new()
        .name("devot-import-scan".into())
        .spawn(move || {
            let app = worker;
            let target = worker_target;
            let progress = |p: Progress| {
                emit(
                    &app,
                    &target,
                    PROGRESS_EVENT,
                    ProgressEvent {
                        id,
                        files: p.files,
                        images: p.images,
                    },
                )
            };
            let watch = Watch {
                cancelled: &cancelled,
                progress: &progress,
            };
            let imports = app.state::<Imports>();
            match scan_folders(&paths, Limits::DEFAULT, &watch) {
                Ok(found) => match imports.ready(id, found, destination) {
                    Some(scan) => {
                        log::info!(
                            "I_IMPORT_SCANNED {} files={} images={} skipped={}",
                            scan.id,
                            scan.files.len(),
                            scan.images.len(),
                            scan.skipped.len()
                        );
                        emit(&app, &target, READY_EVENT, scan);
                    }
                    None => log::info!("I_IMPORT_SCAN_CANCELLED {id}"),
                },
                Err("E_IMPORT_CANCELLED") => {
                    imports.failed(id);
                    log::info!("I_IMPORT_SCAN_CANCELLED {id}");
                }
                Err(code) => {
                    imports.failed(id);
                    fail(&app, &target, Some(id), code);
                }
            }
        });
    if spawned.is_err() {
        app.state::<Imports>().failed(id);
        fail(&app, &target, Some(id), "E_IMPORT_FAILED");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn paths(items: &[Item]) -> Vec<&str> {
        items.iter().map(|i| i.path.as_str()).collect()
    }

    fn write(root: &Path, rel: &str, data: &[u8]) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, data).unwrap();
    }

    fn sample() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "Inbox.md", b"# Inbox\n");
        write(root, "Projects/Plan.markdown", b"# Plan\n");
        write(root, "Projects/Deep/Spec.MD", b"spec\n");
        write(root, "Projects/img/board.png", PNG);
        write(root, "notes.txt", b"not markdown");
        write(root, ".hidden.md", b"hidden");
        write(root, ".git/config.md", b"hidden folder");
        write(root, "Projects/.trash/old.md", b"hidden folder");
        dir
    }

    #[test]
    fn lists_markdown_files_in_nested_folders_and_skips_hidden_ones() {
        let dir = sample();
        let found = scan(dir.path()).unwrap();
        assert_eq!(
            paths(&found.files),
            [
                "Inbox.md",
                "Projects/Deep/Spec.MD",
                "Projects/Plan.markdown"
            ]
        );
        assert_eq!(found.files[0].bytes, 8);
        assert_eq!(
            found.images,
            [Item {
                path: "Projects/img/board.png".into(),
                bytes: PNG.len() as u64
            }]
        );
        assert!(found.skipped.is_empty());
        assert_eq!(found.kind, Kind::Folder);
        assert_eq!(
            found.roots,
            [Root {
                prefix: String::new(),
                path: fs::canonicalize(dir.path()).unwrap()
            }]
        );
        assert_eq!(
            found.name,
            dir.path().file_name().unwrap().to_str().unwrap()
        );
    }

    #[test]
    fn refuses_a_root_that_is_not_a_folder() {
        let dir = sample();
        assert_eq!(
            scan(&dir.path().join("Inbox.md")),
            Err("E_IMPORT_ROOT_INVALID")
        );
        assert_eq!(
            scan(&dir.path().join("missing")),
            Err("E_IMPORT_ROOT_INVALID")
        );
        assert_eq!(scan(Path::new("/")), Err("E_IMPORT_ROOT_INVALID"));
    }

    #[test]
    fn leaves_out_files_over_the_size_cap() {
        let dir = sample();
        let big = fs::File::create(dir.path().join("Big.md")).unwrap();
        big.set_len(MAX_NOTE_BYTES + 1).unwrap();
        let exact = fs::File::create(dir.path().join("Exact.md")).unwrap();
        exact.set_len(MAX_NOTE_BYTES).unwrap();
        let big_image = fs::File::create(dir.path().join("Big.png")).unwrap();
        big_image.set_len(MAX_NOTE_BYTES + 1).unwrap();
        let found = scan(dir.path()).unwrap();
        assert!(paths(&found.files).contains(&"Exact.md"));
        assert!(!paths(&found.files).contains(&"Big.md"));
        assert!(!paths(&found.images).contains(&"Big.png"));
        assert_eq!(
            found.skipped,
            [
                Problem {
                    path: "Big.md".into(),
                    code: "E_IMPORT_FILE_TOO_LARGE"
                },
                Problem {
                    path: "Big.png".into(),
                    code: "E_IMPORT_FILE_TOO_LARGE"
                }
            ]
        );
    }

    fn notes(n: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..n {
            fs::File::create(dir.path().join(format!("{i:05}.md"))).unwrap();
        }
        dir
    }

    fn nested(n: usize) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let rel = vec!["d"; n].join("/");
        write(dir.path(), &format!("{rel}/deep.md"), b"deep");
        (dir, rel)
    }

    #[test]
    fn takes_up_to_ten_thousand_markdown_files() {
        let dir = notes(MAX_FILES);
        assert_eq!(scan(dir.path()).unwrap().files.len(), MAX_FILES);
        fs::File::create(dir.path().join("one-more.md")).unwrap();
        assert_eq!(scan(dir.path()), Err("E_IMPORT_TOO_MANY_FILES"));
    }

    #[test]
    fn follows_folders_down_to_the_depth_limit_and_reports_deeper_ones() {
        let (dir, rel) = nested(MAX_DEPTH);
        assert_eq!(
            paths(&scan(dir.path()).unwrap().files),
            [format!("{rel}/deep.md")]
        );
        let (dir, rel) = nested(MAX_DEPTH + 1);
        let found = scan(dir.path()).unwrap();
        assert!(found.files.is_empty());
        assert_eq!(
            found.skipped,
            [Problem {
                path: rel,
                code: "E_IMPORT_TOO_DEEP"
            }]
        );
    }

    #[test]
    fn refuses_a_folder_with_more_entries_than_the_limit() {
        let dir = notes(3);
        write(dir.path(), ".hidden", b"");
        write(dir.path(), "Sub/a.txt", b"");
        let limits = |entries| Limits {
            entries,
            ..Limits::DEFAULT
        };
        assert_eq!(scan_with(dir.path(), limits(6)).unwrap().files.len(), 3);
        assert_eq!(
            scan_with(dir.path(), limits(5)),
            Err("E_IMPORT_FOLDER_TOO_LARGE")
        );
    }

    #[test]
    fn the_limits_are_the_documented_ones() {
        assert_eq!(
            Limits::DEFAULT,
            Limits {
                files: 10_000,
                entries: 200_000,
                depth: 64
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn follows_links_inside_the_folder_only_and_survives_loops() {
        use std::os::unix::fs::symlink;
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), "secret.md", b"outside");
        let dir = sample();
        let root = dir.path();
        symlink(outside.path(), root.join("Escape")).unwrap();
        symlink(outside.path().join("secret.md"), root.join("secret.md")).unwrap();
        symlink(root.join("Projects"), root.join("Projects/Deep/Loop")).unwrap();
        symlink(root.join("Inbox.md"), root.join("Alias.md")).unwrap();
        symlink(root.join("gone.md"), root.join("Dangling.md")).unwrap();
        write(root, ".private/diary.md", b"hidden");
        symlink(root.join(".private/diary.md"), root.join("Journal.md")).unwrap();
        symlink(root.join(".private"), root.join("Private")).unwrap();
        symlink(outside.path().join("pic.png"), root.join("pic.png")).unwrap();
        let found = scan(root).unwrap();
        // Links are not walked: no loop, no duplicates, nothing hidden;
        // links inside the folder to visible notes (Alias.md, Loop) are quiet.
        assert_eq!(
            paths(&found.files),
            [
                "Inbox.md",
                "Projects/Deep/Spec.MD",
                "Projects/Plan.markdown"
            ]
        );
        assert_eq!(
            found.skipped,
            [
                Problem {
                    path: "Dangling.md".into(),
                    code: "E_IMPORT_UNREADABLE"
                },
                Problem {
                    path: "Escape".into(),
                    code: "E_IMPORT_LINK_OUTSIDE"
                },
                Problem {
                    path: "Journal.md".into(),
                    code: "E_IMPORT_LINK_HIDDEN"
                },
                Problem {
                    path: "Private".into(),
                    code: "E_IMPORT_LINK_HIDDEN"
                },
                Problem {
                    path: "secret.md".into(),
                    code: "E_IMPORT_LINK_OUTSIDE"
                },
            ]
        );
        let root = &found.roots[0].path;
        assert_eq!(read_note(root, "secret.md"), Err("E_IMPORT_PATH_OUTSIDE"));
        assert_eq!(
            read_note(root, "Escape/secret.md"),
            Err("E_IMPORT_PATH_OUTSIDE")
        );
        // Images may be reached through a link, but never a hidden or outside one.
        write(root, "Projects/img/real.png", PNG);
        symlink(root.join("Projects/img/real.png"), root.join("shown.png")).unwrap();
        symlink(root.join(".private/diary.md"), root.join("peek.png")).unwrap();
        assert!(read_image(root, "shown.png").is_ok());
        assert_eq!(read_image(root, "peek.png"), Err("E_IMPORT_PATH_INVALID"));
        assert_eq!(
            read_image(root, "Private/diary.md"),
            Err("E_IMPORT_PATH_INVALID")
        );
        assert_eq!(read_image(root, "pic.png"), Err("E_IMPORT_FILE_NOT_FOUND"));
    }

    #[test]
    fn resolves_only_plain_paths_inside_the_folder() {
        let dir = sample();
        let root = fs::canonicalize(dir.path()).unwrap();
        assert!(resolve(&root, "Projects/img/board.png").is_ok());
        for bad in [
            "",
            "../x.md",
            "Projects/../Inbox.md",
            "./Inbox.md",
            "/etc/passwd",
            ".hidden.md",
            ".git/config.md",
            "a\0b.md",
        ] {
            assert_eq!(resolve(&root, bad), Err("E_IMPORT_PATH_INVALID"), "{bad:?}");
        }
        assert_eq!(
            resolve(&root, &"a/".repeat(3000)),
            Err("E_IMPORT_PATH_INVALID")
        );
        assert_eq!(
            resolve(&root, "missing.png"),
            Err("E_IMPORT_FILE_NOT_FOUND")
        );
        assert_eq!(resolve(&root, "Projects"), Err("E_IMPORT_FILE_NOT_FOUND"));
    }

    #[test]
    fn reads_names_with_a_backslash_as_they_are() {
        let dir = sample();
        let root = fs::canonicalize(dir.path()).unwrap();
        write(&root, "C\\C++ notes.md", b"# C\n");
        write(&root, "shots\\one.png", PNG);
        assert_eq!(read_note(&root, "C\\C++ notes.md").as_deref(), Ok("# C\n"));
        let imports = Imports::default();
        let found = imports.start(scan(&root).unwrap(), None);
        assert!(found.files.iter().any(|f| f.path == "C\\C++ notes.md"));
        let (at, rel) = imports.root_for(found.id, "C\\C++ notes.md", true).unwrap();
        assert_eq!(read_note(&at, &rel).as_deref(), Ok("# C\n"));
        assert!(resolve(&root, "shots\\one.png").is_ok());
        // Not a separator: no way out of the folder, or into a hidden one.
        assert_eq!(resolve(&root, "a\\b.md"), Err("E_IMPORT_FILE_NOT_FOUND"));
        assert_eq!(resolve(&root, "..\\x.md"), Err("E_IMPORT_PATH_INVALID"));
        assert_eq!(
            resolve(&root, "Projects\\..\\..\\Inbox.md"),
            Err("E_IMPORT_FILE_NOT_FOUND")
        );
    }

    #[test]
    fn reads_notes_as_utf8_without_a_byte_order_mark() {
        let dir = sample();
        let root = fs::canonicalize(dir.path()).unwrap();
        write(&root, "bom.md", b"\xef\xbb\xbf# Title\r\n");
        write(&root, "latin1.md", b"caf\xe9");
        assert_eq!(read_note(&root, "bom.md").as_deref(), Ok("# Title\r\n"));
        assert_eq!(read_note(&root, "latin1.md"), Err("E_IMPORT_NOT_UTF8"));
        let big = fs::File::create(root.join("Big.md")).unwrap();
        big.set_len(MAX_NOTE_BYTES + 1).unwrap();
        assert_eq!(read_note(&root, "Big.md"), Err("E_IMPORT_FILE_TOO_LARGE"));
    }

    #[test]
    fn reads_images_within_the_cap_and_checks_them_like_uploads() {
        let dir = sample();
        let root = fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            read_image(&root, "Projects/img/board.png"),
            Ok(Image {
                name: "board.png".into(),
                data: PNG.to_vec()
            })
        );
        write(&root, "empty.png", b"");
        assert_eq!(read_image(&root, "empty.png"), Err("E_FILE_SIZE_INVALID"));
        let big = fs::File::create(root.join("big.png")).unwrap();
        big.set_len(MAX_FILE_BYTES as u64 + 1).unwrap();
        assert_eq!(read_image(&root, "big.png"), Err("E_FILE_SIZE_INVALID"));
        // The format is checked by its bytes when stored, as for any upload.
        write(
            &root,
            "renamed.png",
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        );
        let image = read_image(&root, "renamed.png").unwrap();
        let upload = Upload {
            id: "0192a6f0-0000-7000-8000-00000000f001".into(),
            note_id: "0192a6f0-0000-7000-8000-000000000001".into(),
            name: image.name,
        };
        assert_eq!(
            crate::commands::files::validate_upload(&upload, &image.data),
            Err("E_FILE_TYPE_REFUSED")
        );
    }

    #[test]
    fn sessions_read_only_their_own_scanned_notes() {
        let dir = sample();
        let imports = Imports::default();
        let scan = imports.start(scan(dir.path()).unwrap(), None);
        assert_eq!(scan.id, 1);
        assert_eq!(scan.files.len(), 3);
        assert!(imports.root_for(scan.id, "Inbox.md", true).is_ok());
        assert_eq!(
            imports.root_for(scan.id, "notes.txt", true),
            Err("E_IMPORT_PATH_UNKNOWN")
        );
        assert!(
            imports
                .root_for(scan.id, "Projects/img/board.png", false)
                .is_ok()
        );
        assert_eq!(
            imports.root_for(scan.id + 1, "Inbox.md", true),
            Err("E_IMPORT_SESSION")
        );
        let second = imports.start(super::scan(dir.path()).unwrap(), None);
        assert_eq!(second.id, 2);
        imports.finish(scan.id);
        assert_eq!(
            imports.root_for(scan.id, "Inbox.md", true),
            Err("E_IMPORT_SESSION")
        );
        assert!(imports.root_for(second.id, "Inbox.md", true).is_ok());
    }

    #[test]
    fn several_folders_each_start_their_paths_with_a_unique_name() {
        let parent = tempfile::tempdir().unwrap();
        write(parent.path(), "Work/Plan.md", b"# Plan\n");
        write(parent.path(), "Work/Q4/Goals.md", b"# Goals\n");
        write(parent.path(), "other/Work/List.md", b"# List\n");
        write(parent.path(), "Home/cat.png", PNG);
        let roots = [
            parent.path().join("Work"),
            parent.path().join("other/Work"),
            parent.path().join("Home"),
        ];
        let found = Watch::idle(|w| scan_folders(&roots, Limits::DEFAULT, w)).unwrap();
        assert_eq!(found.kind, Kind::Folders);
        assert_eq!(found.name, "Work");
        assert_eq!(
            found
                .roots
                .iter()
                .map(|r| r.prefix.as_str())
                .collect::<Vec<_>>(),
            ["Work", "Work 2", "Home"]
        );
        assert_eq!(
            paths(&found.files),
            ["Work 2/List.md", "Work/Plan.md", "Work/Q4/Goals.md"]
        );
        assert_eq!(paths(&found.images), ["Home/cat.png"]);

        let imports = Imports::default();
        let scan = imports.start(found, None);
        let (root, rel) = imports.root_for(scan.id, "Work 2/List.md", true).unwrap();
        assert_eq!(read_note(&root, &rel).as_deref(), Ok("# List\n"));
        let (root, rel) = imports.root_for(scan.id, "Home/cat.png", false).unwrap();
        assert!(read_image(&root, &rel).is_ok());
        assert_eq!(
            imports.root_for(scan.id, "Elsewhere/cat.png", false),
            Err("E_IMPORT_PATH_OUTSIDE")
        );
        let limits = Limits {
            files: 2,
            ..Limits::DEFAULT
        };
        assert_eq!(
            Watch::idle(|w| scan_folders(&roots, limits, w)),
            Err("E_IMPORT_TOO_MANY_FILES")
        );
    }

    #[test]
    fn a_scan_reports_progress_and_stops_when_cancelled() {
        let dir = sample();
        let seen = Mutex::new(Vec::new());
        let progress = |p: Progress| seen.lock().unwrap().push(p);
        let cancelled = AtomicBool::new(false);
        let watch = Watch {
            cancelled: &cancelled,
            progress: &progress,
        };
        scan_folders(&[dir.path().to_path_buf()], Limits::DEFAULT, &watch).unwrap();
        let last = *seen.lock().unwrap().last().unwrap();
        assert_eq!(
            last,
            Progress {
                files: 3,
                images: 1
            }
        );
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(
            scan_folders(&[dir.path().to_path_buf()], Limits::DEFAULT, &watch),
            Err("E_IMPORT_CANCELLED")
        );
    }

    #[test]
    fn a_session_closed_while_its_scan_runs_never_opens() {
        let dir = sample();
        let imports = Imports::default();
        let (id, cancelled) = imports.begin();
        imports.finish(id);
        assert!(cancelled.load(Ordering::Relaxed));
        assert_eq!(imports.ready(id, scan(dir.path()).unwrap(), None), None);
        assert_eq!(
            imports.root_for(id, "Inbox.md", true),
            Err("E_IMPORT_SESSION")
        );
        let (id, _) = imports.begin();
        assert!(imports.ready(id, scan(dir.path()).unwrap(), None).is_some());
        assert!(imports.root_for(id, "Inbox.md", true).is_ok());
    }

    #[test]
    fn picked_files_keep_their_names_and_are_read_from_their_folders() {
        let dir = sample();
        let root = dir.path();
        write(root, "Saved/page.html", b"<p>x</p>");
        write(root, "Saved/img/a.png", PNG);
        write(root, "Other/b.htm", b"<p>y</p>");
        write(root, "Saved/.secret.html", b"hidden");
        let big = fs::File::create(root.join("Saved/huge.html")).unwrap();
        big.set_len(MAX_NOTE_BYTES + 1).unwrap();

        let one = pick_found(&[root.join("Inbox.md"), root.join("notes.txt")], false).unwrap();
        assert_eq!(one.kind, Kind::Files);
        assert_eq!(paths(&one.files), ["Inbox.md"]);
        assert_eq!(
            one.skipped,
            [Problem {
                path: "notes.txt".into(),
                code: "E_IMPORT_FILE_TYPE"
            }]
        );

        let picked = [
            root.join("Saved/page.html"),
            root.join("Other/b.htm"),
            root.join("Saved/.secret.html"),
            root.join("Saved/huge.html"),
            root.join("Saved/missing.html"),
        ];
        let found = pick_found(&picked, true).unwrap();
        assert_eq!(paths(&found.files), ["Other/b.htm", "Saved/page.html"]);
        assert_eq!(
            found.skipped,
            [
                Problem {
                    path: "Saved/.secret.html".into(),
                    code: "E_IMPORT_PATH_INVALID"
                },
                Problem {
                    path: "Saved/huge.html".into(),
                    code: "E_IMPORT_FILE_TOO_LARGE"
                },
                Problem {
                    path: "missing.html".into(),
                    code: "E_IMPORT_UNREADABLE"
                },
            ]
        );
        let imports = Imports::default();
        let scan = imports.start(found, None);
        let (at, rel) = imports.root_for(scan.id, "Saved/page.html", true).unwrap();
        assert_eq!(read_note(&at, &rel).as_deref(), Ok("<p>x</p>"));
        // Its images are read from its folder, and nowhere above it.
        let (at, rel) = imports.root_for(scan.id, "Saved/img/a.png", false).unwrap();
        assert!(read_image(&at, &rel).is_ok());
        assert_eq!(
            imports.root_for(scan.id, "Saved/.secret.html", true),
            Err("E_IMPORT_PATH_UNKNOWN")
        );
    }

    #[test]
    fn a_finish_racing_a_ready_scan_never_leaves_its_session_open() {
        let dir = sample();
        let found = scan(dir.path()).unwrap();
        let imports = Arc::new(Imports::default());
        for _ in 0..500 {
            let (id, _) = imports.begin();
            let finisher = {
                let imports = imports.clone();
                std::thread::spawn(move || imports.finish(id))
            };
            imports.ready(id, found.clone(), None);
            finisher.join().unwrap();
            // Either the finish came first (no session) or it ended the
            // session the scan opened: none is left either way.
            assert!(imports.sessions.lock().unwrap().is_empty());
            assert!(imports.pending.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn a_pick_of_too_many_files_is_refused_however_they_are_ordered() {
        let dir = notes(MAX_FILES + 1);
        write(dir.path(), "a.txt", b"not markdown");
        let mut paths = vec![dir.path().join("a.txt")];
        paths.extend((0..=MAX_FILES).map(|i| dir.path().join(format!("{i:05}.md"))));
        assert_eq!(
            pick_found(&paths, false).map(|f| f.files.len()),
            Err("E_IMPORT_TOO_MANY_FILES")
        );
        paths.pop();
        assert_eq!(pick_found(&paths, false).unwrap().files.len(), MAX_FILES);
    }

    #[test]
    fn a_picked_file_reads_images_only_next_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "notes.md", b"# Notes\n");
        write(root, "shot.png", PNG);
        write(root, "img/board.png", PNG);
        write(root, "Pictures/private/x.png", PNG);
        write(root, "img/notes.txt", PNG);
        let imports = Imports::default();
        let scan = imports.start(pick_found(&[root.join("notes.md")], false).unwrap(), None);
        let image = |rel: &str| {
            let (at, rel, shallow) = imports.place(scan.id, rel, false)?;
            assert!(shallow);
            read_session_image(&at, &rel, shallow)
        };
        assert!(image("shot.png").is_ok());
        assert!(image("img/board.png").is_ok());
        assert_eq!(
            image("Pictures/private/x.png"),
            Err("E_IMPORT_PATH_OUTSIDE")
        );
        assert_eq!(image("img/notes.txt"), Err("E_IMPORT_PATH_OUTSIDE"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("Pictures/private/x.png"), root.join("peek.png"))
                .unwrap();
            assert_eq!(image("peek.png"), Err("E_IMPORT_PATH_OUTSIDE"));
        }
        let folder = imports.start(super::scan(root).unwrap(), None);
        let (at, rel, shallow) = imports
            .place(folder.id, "Pictures/private/x.png", false)
            .unwrap();
        assert!(!shallow);
        assert!(read_session_image(&at, &rel, shallow).is_ok());
    }

    #[test]
    fn a_notebook_import_checks_its_kind_and_notebook() {
        let kind = |k: &str| serde_json::from_value::<Pick>(serde_json::json!(k)).ok();
        assert_eq!(kind("markdownFiles"), Some(Pick::MarkdownFiles));
        assert_eq!(kind("markdownFolders"), Some(Pick::MarkdownFolders));
        assert_eq!(kind("htmlFiles"), Some(Pick::HtmlFiles));
        assert_eq!(kind("pdfFiles"), None);
        assert_eq!(kind("MarkdownFiles"), None);
        let id = "01890a5d-ac96-774b-bcce-b302099a8057".to_string();
        assert_eq!(pick_destination(None), Ok(None));
        assert_eq!(pick_destination(Some(id.clone())), Ok(Some(id)));
        for bad in ["", "nope", "../x", "01890A5D-AC96-774B-BCCE-B302099A8057"] {
            assert_eq!(pick_destination(Some(bad.into())), Err("E_BOOK_ID_INVALID"));
        }
    }

    #[test]
    fn a_session_carries_its_destination_to_the_window() {
        let dir = sample();
        let imports = Imports::default();
        let id = "01890a5d-ac96-774b-bcce-b302099a8057";
        let picked = imports.start(scan(dir.path()).unwrap(), Some(id.into()));
        assert_eq!(picked.destination.as_deref(), Some(id));
        let json = serde_json::to_value(&picked).unwrap();
        assert_eq!(json["destination"], id);
        let (next, _) = imports.begin();
        let scanned = imports
            .ready(next, scan(dir.path()).unwrap(), None)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&scanned).unwrap()["destination"],
            serde_json::Value::Null
        );
    }
}
