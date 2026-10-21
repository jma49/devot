//! Export and print (the note and notebook context menus). The core turns notes into Markdown files
//! and the UI turns the preview into an HTML page (`src/core/export.ts`,
//! `src/renderer/src/exporter.ts`); Rust shows the native panels, writes the files and prints.
//! The web view never names a path: Rust shows the save or folder panel and keeps what the user
//! picked as an export session, the folder opened once when it was picked (`atomic_file::Folder`).
//! The UI writes files by session ID and a path relative to it; Rust accepts only plain, visible
//! relative paths with the session's extension, and writes every file through a new temporary file
//! renamed into place, never through a link, nor through a link on its way (folders are made one by
//! one, each opened from the one before as a real folder). A PDF, which AppKit writes by path, is
//! printed in a new private folder in the app's data and copied out. A notebook goes into a new
//! folder of its own, so nothing already on disk is replaced; a single note replaces only the file
//! the save panel confirmed. Attachments are copied from the database into an `attachments` folder
//! (their bytes never cross IPC), never over a different file.
//! An HTML page shows its images as `data:` URIs: the UI puts a placeholder token in each image's
//! `src` (`devot-image-<32 hex>-<n>`, a nonce per page, so note text cannot hold one) and Rust
//! swaps in the attachment's bytes.
//! Printing goes through `native::macos`, which lays the page out under its own print policy
//! (nothing from the web) and reports how the job ended.

use crate::atomic_file::{self, Folder, Place, TempDir};
use crate::commands::notes::valid_note_id;
use crate::editor_settings::EditorSettingsStore;
use crate::page_setup::{PageLayout, PageLook};
use crate::storage::Db;
use crate::strings;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PAGE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_IMAGES: usize = 10_000;
/// A file or folder name's stem, in UTF-8 bytes (a name may take 255; the
/// extension and numbering come on top).
pub const MAX_NAME_BYTES: usize = 200;
const MAX_TITLE_CHARS: usize = 1_000;
const MAX_PATH_BYTES: usize = 4096;
pub const ATTACHMENTS: &str = "attachments";
const PLACEHOLDER_PREFIX: &str = "devot-image-";
const MAX_FOLDER_TRIES: u32 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Note,
    Notebook,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Markdown,
    Html,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Markdown => "md",
            Format::Html => "html",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageImage {
    pub placeholder: String,
    pub file_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    pub id: u64,
    pub file_name: Option<String>,
}

pub fn valid_stem(name: &str) -> bool {
    !name.is_empty()
        && name.trim() == name
        && name.len() <= MAX_NAME_BYTES
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}

pub fn valid_rel_path(path: &str, extension: &str) -> bool {
    plain_rel_path(path)
        && Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

/// No `.` or `..`, no hidden names, no `:` or `\\`, each at most 255 bytes: stays inside the folder
/// it is joined to.
pub fn plain_rel_path(path: &str) -> bool {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.contains(['\0', '\\'])
        || path.chars().any(char::is_control)
    {
        return false;
    }
    let mut parts = 0;
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.starts_with('.') || part.len() > 255 || part.contains(':') {
                    return false;
                }
                parts += 1;
            }
            _ => return false,
        }
    }
    // `a//b` and a trailing `/` read as the same components; refuse them.
    parts == path.split('/').count()
}

pub fn valid_placeholder(token: &str) -> bool {
    placeholder_len(token) == Some(token.len())
}

fn placeholder_len(text: &str) -> Option<usize> {
    let rest = text.strip_prefix(PLACEHOLDER_PREFIX)?.as_bytes();
    let nonce = rest.get(..32)?;
    if !nonce
        .iter()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    {
        return None;
    }
    if rest.get(32) != Some(&b'-') {
        return None;
    }
    let digits = rest[33..]
        .iter()
        .take(7)
        .take_while(|b| b.is_ascii_digit())
        .count();
    (1..=6)
        .contains(&digits)
        .then_some(PLACEHOLDER_PREFIX.len() + 33 + digits)
}

pub fn validate_images(images: &[PageImage]) -> Result<(), &'static str> {
    if images.len() > MAX_IMAGES {
        return Err("E_EXPORT_TOO_MANY_IMAGES");
    }
    let mut seen = HashSet::with_capacity(images.len());
    for image in images {
        if !valid_placeholder(&image.placeholder) || !seen.insert(image.placeholder.as_str()) {
            return Err("E_EXPORT_PLACEHOLDER_INVALID");
        }
        if !valid_note_id(&image.file_id) {
            return Err("E_FILE_ID_INVALID");
        }
    }
    Ok(())
}

/// A placeholder of a missing attachment becomes empty; text that is not a listed placeholder stays
/// as it is.
pub fn inline_images(
    page: &str,
    images: &[PageImage],
    mut load: impl FnMut(&str) -> Option<(String, Vec<u8>)>,
) -> Result<String, &'static str> {
    // How often each listed placeholder occurs: an image shown twice is
    // put in twice, and counts twice against the limit.
    let listed: HashSet<&str> = images.iter().map(|i| i.placeholder.as_str()).collect();
    let mut uses: HashMap<&str, usize> = HashMap::new();
    for_each_placeholder(page, |token| {
        if listed.contains(token) {
            *uses.entry(token).or_default() += 1;
        }
    });
    let mut uris: HashMap<&str, String> = HashMap::with_capacity(uses.len());
    let mut size = page.len();
    for image in images {
        let Some(&count) = uses.get(image.placeholder.as_str()) else {
            continue;
        };
        let uri = match load(&image.file_id) {
            Some((mime, data)) => {
                let encoded = 4 * data.len().div_ceil(3);
                let grows = (mime.len() + 13 + encoded).saturating_mul(count);
                size = size.saturating_add(grows);
                if size > MAX_PAGE_BYTES {
                    return Err("E_EXPORT_TOO_LARGE");
                }
                format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(data)
                )
            }
            None => String::new(),
        };
        uris.insert(image.placeholder.as_str(), uri);
    }
    let mut out = String::with_capacity(size);
    let mut rest = page;
    while let Some(at) = rest.find(PLACEHOLDER_PREFIX) {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        match placeholder_len(tail).and_then(|len| Some((len, uris.get(&tail[..len])?))) {
            Some((len, uri)) => {
                out.push_str(uri);
                rest = &tail[len..];
            }
            None => {
                out.push_str(PLACEHOLDER_PREFIX);
                rest = &tail[PLACEHOLDER_PREFIX.len()..];
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

fn for_each_placeholder<'a>(page: &'a str, mut found: impl FnMut(&'a str)) {
    let mut rest = page;
    while let Some(at) = rest.find(PLACEHOLDER_PREFIX) {
        let tail = &rest[at..];
        match placeholder_len(tail) {
            Some(len) => {
                found(&tail[..len]);
                rest = &tail[len..];
            }
            None => rest = &tail[PLACEHOLDER_PREFIX.len()..],
        }
    }
}

pub fn attachment_name(stored: &str, mime: &str) -> String {
    let cleaned: String = stored
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_owned();
    let path = Path::new(&cleaned);
    let (stem, extension) = match (
        path.file_stem().and_then(|s| s.to_str()),
        path.extension().and_then(|e| e.to_str()),
    ) {
        (Some(stem), Some(ext)) if !stem.is_empty() && !ext.is_empty() => {
            (stem.to_owned(), ext.to_owned())
        }
        _ => (
            cleaned.clone(),
            match mime {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/gif" => "gif",
                "image/webp" => "webp",
                "image/avif" => "avif",
                "image/heic" => "heic",
                _ => "bin",
            }
            .to_owned(),
        ),
    };
    let stem = clip_bytes(&stem, MAX_NAME_BYTES);
    let stem = if stem.trim().is_empty() {
        "image".to_owned()
    } else {
        stem.trim().to_owned()
    };
    let extension: String = extension.chars().take(16).collect();
    format!("{stem}.{extension}")
}

fn clip_bytes(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn numbered(name: &str, n: u32) -> String {
    if n <= 1 {
        return name.to_owned();
    }
    let path = Path::new(name);
    match (
        path.file_stem().and_then(|s| s.to_str()),
        path.extension().and_then(|e| e.to_str()),
    ) {
        (Some(stem), Some(ext)) => format!("{stem} {n}.{ext}"),
        _ => format!("{name} {n}"),
    }
}

pub fn write_file(
    folder: &Folder,
    name: &str,
    data: &[u8],
    place: Place,
) -> Result<(), &'static str> {
    folder.write(name, data, place).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "E_EXPORT_EXISTS"
        } else {
            "E_EXPORT_WRITE_FAILED"
        }
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const PDF_NAME: &str = "page.pdf";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const PDF_DIR: &str = "pdf";

/// AppKit makes the file by its path itself, so it prints into a new private folder
/// (`atomic_file::TempDir`) in the app's data, which nobody else can reach; not beside the file the
/// user chose, where anyone who may remove names in that folder could swap the private folder for a
/// link while the job runs, and AppKit would print through it. The finished PDF is then copied to
/// the chosen file through a new temporary file beside it, like every file.
/// Far longer than a print job takes, so a running job's folder is never swept.
const PDF_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Removes the private folders of PDF jobs that never finished: a timeout, an interrupt or a crash
/// skips `TempDir`'s drop.
pub fn sweep_pdf_folders(dir: &Path, now: std::time::SystemTime) {
    atomic_file::remove_stale_temp_dirs(dir, PDF_STALE_AFTER, now);
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct PdfPartial {
    dir: TempDir,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl PdfPartial {
    pub fn new_in(dir: &Path) -> Result<Self, &'static str> {
        std::fs::create_dir_all(dir).map_err(|_| "E_EXPORT_PDF_FOLDER_FAILED")?;
        sweep_pdf_folders(dir, std::time::SystemTime::now());
        let dir = TempDir::new_in(dir).map_err(|_| "E_EXPORT_PDF_FOLDER_FAILED")?;
        Ok(Self { dir })
    }

    pub fn file(&self) -> PathBuf {
        self.dir.path().join(PDF_NAME)
    }

    pub fn folder(&self) -> &Path {
        self.dir.path()
    }

    /// The panel asked before replacing a file there.
    pub fn persist(&self, folder: &Folder, name: &str) -> Result<(), &'static str> {
        self.dir
            .copy_to(PDF_NAME, folder, name, Place::Replace)
            .map_err(|_| "E_EXPORT_WRITE_FAILED")
    }

    pub fn read(&self) -> Result<std::fs::File, &'static str> {
        self.dir
            .read_file(PDF_NAME)
            .map_err(|_| "E_EXPORT_WRITE_FAILED")
    }
}

fn open_or_make(folder: &Folder, name: &str) -> Result<Folder, &'static str> {
    match folder.folder(name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match folder.make_folder(name) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => {
                Err("E_EXPORT_FOLDER_FAILED")
            }
            _ => folder.folder(name).map_err(|_| "E_EXPORT_FOLDER_FAILED"),
        },
        opened => opened.map_err(|_| "E_EXPORT_FOLDER_FAILED"),
    }
}

fn make_folders<'a>(root: &Folder, path: &'a str) -> Result<(Folder, &'a str), &'static str> {
    let mut parts = path.split('/');
    let name = parts.next_back().unwrap_or(path);
    let mut folder = root.clone();
    for part in parts {
        folder = open_or_make(&folder, part)?;
    }
    Ok((folder, name))
}

/// Returns the folder with the name it got (`name 2`, ... when taken).
pub fn new_folder(parent: &Folder, name: &str) -> Result<(Folder, String), &'static str> {
    if !valid_stem(name) {
        return Err("E_EXPORT_NAME_INVALID");
    }
    for n in 1..=MAX_FOLDER_TRIES {
        // Not `numbered`: a dot in a notebook's name is no extension.
        let named = if n == 1 {
            name.to_owned()
        } else {
            format!("{name} {n}")
        };
        match parent.make_folder(&named) {
            Ok(()) => {
                let folder = parent
                    .folder(&named)
                    .map_err(|_| "E_EXPORT_FOLDER_FAILED")?;
                return Ok((folder, named));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("E_EXPORT_FOLDER_FAILED"),
        }
    }
    Err("E_EXPORT_FOLDER_FAILED")
}

/// The panel asked before replacing the file it named, not one with an extension added: such a file
/// must not exist yet. A link the user picked is followed here, once.
pub fn chosen_file(path: &Path, extension: &str) -> Result<(Folder, String), &'static str> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("E_EXPORT_PATH_INVALID")?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("E_EXPORT_PATH_INVALID")?;
    let has_extension = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(extension));
    let name = if has_extension {
        name.to_owned()
    } else {
        format!("{name}.{extension}")
    };
    if name.starts_with('.') || name.len() > 255 || name.chars().any(char::is_control) {
        return Err("E_EXPORT_PATH_INVALID");
    }
    let folder = Folder::open(parent).map_err(|_| "E_EXPORT_PATH_INVALID")?;
    if !has_extension && folder.entry(&name).is_ok() {
        return Err("E_EXPORT_EXISTS");
    }
    Ok((folder, name))
}

fn read_all(folder: &Folder, name: &str) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut folder.read_file(name)?, &mut bytes)?;
    Ok(bytes)
}

struct Session {
    root: Folder,
    kind: Kind,
    format: Format,
    file_name: Option<String>,
    attachments: HashMap<String, String>,
    /// Attachment file names taken, lowercased (the file system ignores case).
    names: HashSet<String>,
}

#[derive(Default)]
pub struct Exports {
    next: AtomicU64,
    sessions: Mutex<HashMap<u64, Session>>,
}

pub struct Attachment {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
}

impl Exports {
    pub fn start(
        &self,
        root: Folder,
        kind: Kind,
        format: Format,
        file_name: Option<String>,
    ) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(
                id,
                Session {
                    root,
                    kind,
                    format,
                    file_name,
                    attachments: HashMap::new(),
                    names: HashSet::new(),
                },
            );
        }
        id
    }

    pub fn target(&self, id: u64, path: &str) -> Result<(Folder, bool), &'static str> {
        let sessions = self.sessions.lock().map_err(|_| "E_EXPORT_SESSION")?;
        let session = sessions.get(&id).ok_or("E_EXPORT_SESSION")?;
        // A note writes only the file the user named (checked by
        // `chosen_file`; it may hold characters a generated name may not).
        if session.kind == Kind::Note
            && !path.is_empty()
            && session.file_name.as_deref() == Some(path)
        {
            return Ok((session.root.clone(), true));
        }
        if !valid_rel_path(path, session.format.extension()) {
            return Err("E_EXPORT_PATH_INVALID");
        }
        match session.kind {
            // The save panel asked before replacing it.
            Kind::Note if session.file_name.as_deref() == Some(path) => {
                Ok((session.root.clone(), true))
            }
            Kind::Note => Err("E_EXPORT_PATH_INVALID"),
            Kind::Notebook if path.split('/').next() == Some(ATTACHMENTS) => {
                Err("E_EXPORT_PATH_INVALID")
            }
            Kind::Notebook => Ok((session.root.clone(), false)),
        }
    }

    pub fn write(&self, id: u64, path: &str, data: &[u8]) -> Result<(), &'static str> {
        let (root, replace) = self.target(id, path)?;
        // A note's file is one name, whatever it holds (a `/` it never has).
        let (folder, name) = if replace {
            (root, path)
        } else {
            make_folders(&root, path)?
        };
        if !replace && folder.entry(name).is_ok() {
            return Err("E_EXPORT_EXISTS");
        }
        atomic_file::checked();
        let place = if replace { Place::Replace } else { Place::New };
        write_file(&folder, name, data, place)
    }

    pub fn attached(&self, id: u64, file_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().ok()?;
        sessions.get(&id)?.attachments.get(file_id).cloned()
    }

    /// The file keeps its name; a different file of that name already there keeps its own, and this
    /// one is numbered (`name 2.png`).
    pub fn attach(
        &self,
        id: u64,
        file_id: &str,
        load: impl FnOnce() -> Option<Attachment>,
    ) -> Result<String, &'static str> {
        if !valid_note_id(file_id) {
            return Err("E_FILE_ID_INVALID");
        }
        let mut sessions = self.sessions.lock().map_err(|_| "E_EXPORT_SESSION")?;
        let session = sessions.get_mut(&id).ok_or("E_EXPORT_SESSION")?;
        if let Some(path) = session.attachments.get(file_id) {
            return Ok(path.clone());
        }
        let file = load().ok_or("E_FILE_NOT_FOUND")?;
        // A link (or a file) of that name is not followed or replaced.
        let folder = open_or_make(&session.root, ATTACHMENTS)?;
        atomic_file::checked();
        let base = attachment_name(&file.name, &file.mime);
        for n in 1..=MAX_FOLDER_TRIES {
            let name = numbered(&base, n);
            if session.names.contains(&name.to_lowercase()) {
                continue;
            }
            let same = match folder.entry(&name) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Ok(entry) if entry.is_file() && entry.len == file.data.len() as u64 => {
                    match read_all(&folder, &name) {
                        Ok(bytes) if bytes == file.data => true,
                        _ => continue,
                    }
                }
                _ => continue,
            };
            // Never over a file that appeared meanwhile: its name is taken.
            if !same {
                match write_file(&folder, &name, &file.data, Place::New) {
                    Ok(()) => {}
                    Err("E_EXPORT_EXISTS") => continue,
                    Err(code) => return Err(code),
                }
            }
            session.names.insert(name.to_lowercase());
            let path = format!("{ATTACHMENTS}/{name}");
            session.attachments.insert(file_id.to_owned(), path.clone());
            return Ok(path);
        }
        Err("E_EXPORT_NAME_TAKEN")
    }

    pub fn finish(&self, id: u64) {
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
        .map_err(|_| "E_EXPORT_FAILED".to_string())?
        .map_err(String::from)
}

async fn load_attachment(db: &Db, file_id: String) -> Option<Attachment> {
    db.call(move |store| store.get_file(&file_id))
        .await
        .ok()
        .flatten()
        .map(|file| Attachment {
            name: file.name,
            mime: file.mime,
            data: file.data,
        })
}

async fn page_with_images(db: &Db, page: String, images: Vec<PageImage>) -> Result<String, String> {
    if page.len() > MAX_TEXT_BYTES {
        return Err("E_EXPORT_TOO_LARGE".into());
    }
    validate_images(&images).map_err(String::from)?;
    let mut files = HashMap::with_capacity(images.len());
    for image in &images {
        if !files.contains_key(&image.file_id)
            && let Some(file) = load_attachment(db, image.file_id.clone()).await
        {
            files.insert(image.file_id.clone(), (file.mime, file.data));
        }
    }
    blocking(move || inline_images(&page, &images, |id| files.get(id).cloned())).await
}

/// Control characters (a pasted tab, say) become spaces and it is cut to MAX_TITLE_CHARS
/// characters; any title prints.
pub(crate) fn job_title(title: &str) -> String {
    title
        .chars()
        .take(MAX_TITLE_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

fn valid_clipboard_html(html: &str) -> bool {
    !html.contains('\0')
}

fn dialog(app: &AppHandle, title: &str) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    #[cfg_attr(mobile, allow(unused_mut))]
    let mut dialog = app.dialog().file().set_title(title);
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) {
        dialog = dialog.set_parent(&window);
    }
    dialog
}

/// None when the user cancelled.
async fn ask_save(
    app: &AppHandle,
    title: &str,
    file_name: String,
    filter: &str,
    extension: &'static str,
) -> Result<Option<PathBuf>, String> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    dialog(app, title)
        .set_file_name(file_name)
        .add_filter(filter, &[extension])
        .set_can_create_directories(true)
        .save_file(move |path| {
            let _ = reply.send(path.map(|p| p.into_path()));
        });
    match answer.await {
        Ok(None) => Ok(None),
        Ok(Some(Ok(path))) => Ok(Some(path)),
        _ => Err("E_EXPORT_PATH_INVALID".into()),
    }
}

/// None when the user cancelled.
#[cfg(mobile)]
async fn ask_folder(_app: &AppHandle, _title: &str) -> Result<Option<PathBuf>, String> {
    Err("E_EXPORT_FOLDER_UNSUPPORTED".into())
}

/// None when the user cancelled.
#[cfg(desktop)]
async fn ask_folder(app: &AppHandle, title: &str) -> Result<Option<PathBuf>, String> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    dialog(app, title)
        .set_can_create_directories(true)
        .pick_folder(move |path| {
            let _ = reply.send(path.map(|p| p.into_path()));
        });
    match answer.await {
        Ok(None) => Ok(None),
        Ok(Some(Ok(path))) => Ok(Some(path)),
        _ => Err("E_EXPORT_PATH_INVALID".into()),
    }
}

/// None when the user cancelled.
#[tauri::command]
pub async fn export_begin(
    app: AppHandle,
    exports: State<'_, Exports>,
    kind: Kind,
    format: Format,
    name: String,
) -> Result<Option<Begun>, String> {
    if !valid_stem(&name) {
        return Err("E_EXPORT_NAME_INVALID".into());
    }
    let extension = format.extension();
    let (title, filter) = match format {
        Format::Markdown => (
            strings::EXPORT_MARKDOWN_TITLE,
            strings::EXPORT_MARKDOWN_FILTER,
        ),
        Format::Html => (strings::EXPORT_HTML_TITLE, strings::EXPORT_HTML_FILTER),
    };
    let begun = match kind {
        Kind::Note => {
            let Some(path) = ask_save(
                &app,
                title,
                format!("{name}.{extension}"),
                filter,
                extension,
            )
            .await?
            else {
                return Ok(None);
            };
            let (root, file_name) = chosen_file(&path, extension)?;
            let id = exports.start(root, kind, format, Some(file_name.clone()));
            Begun {
                id,
                file_name: Some(file_name),
            }
        }
        Kind::Notebook => {
            let Some(parent) = ask_folder(&app, title).await? else {
                return Ok(None);
            };
            // The folder picked is opened once, here; the notebook's own is
            // made in it and opened from it, never through a link.
            let (root, _) = blocking(move || {
                let parent = Folder::open(&parent).map_err(|_| "E_EXPORT_FOLDER_FAILED")?;
                new_folder(&parent, &name)
            })
            .await?;
            Begun {
                id: exports.start(root, kind, format, None),
                file_name: None,
            }
        }
    };
    log::info!("I_EXPORT_BEGUN {}", begun.id);
    Ok(Some(begun))
}

#[tauri::command]
pub async fn export_attach(
    app: AppHandle,
    db: State<'_, Db>,
    id: u64,
    file_id: String,
) -> Result<String, String> {
    if !valid_note_id(&file_id) {
        return Err("E_FILE_ID_INVALID".into());
    }
    if let Some(path) = app.state::<Exports>().attached(id, &file_id) {
        return Ok(path);
    }
    let file = load_attachment(&db, file_id.clone()).await;
    blocking(move || app.state::<Exports>().attach(id, &file_id, || file)).await
}

#[tauri::command]
pub async fn export_write(
    app: AppHandle,
    db: State<'_, Db>,
    id: u64,
    path: String,
    text: String,
    images: Vec<PageImage>,
) -> Result<(), String> {
    if text.len() > MAX_TEXT_BYTES {
        return Err("E_EXPORT_TOO_LARGE".into());
    }
    // Checked before the images are read; again when written.
    app.state::<Exports>()
        .target(id, &path)
        .map_err(String::from)?;
    let text = if images.is_empty() {
        text
    } else {
        page_with_images(&db, text, images).await?
    };
    blocking(move || app.state::<Exports>().write(id, &path, text.as_bytes())).await
}

#[tauri::command]
pub fn export_finish(exports: State<'_, Exports>, id: u64) {
    exports.finish(id);
    log::info!("I_EXPORT_FINISHED {id}");
}

#[tauri::command]
pub async fn clipboard_write_html(
    app: AppHandle,
    db: State<'_, Db>,
    html: String,
    images: Vec<PageImage>,
) -> Result<(), String> {
    if !valid_clipboard_html(&html) {
        return Err("E_CLIPBOARD_TEXT_INVALID".into());
    }
    let html = page_with_images(&db, html, images).await?;
    #[cfg(target_os = "macos")]
    {
        let (reply, answer) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = reply.send(crate::native::macos::write_clipboard_text(&html));
        })
        .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        match answer.await {
            Ok(true) => Ok(()),
            _ => Err(String::from("E_CLIPBOARD_WRITE_FAILED")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, html);
        Err(String::from("E_CLIPBOARD_UNSUPPORTED"))
    }
}

/// The page setup in the editor settings, and how the header and footer look.
fn page_layout(app: &AppHandle, title: String, look: PageLook) -> Result<PageLayout, String> {
    if !look.valid() {
        return Err("E_PRINT_LOOK_INVALID".into());
    }
    let snapshot = app.state::<Arc<EditorSettingsStore>>().get()?;
    Ok(PageLayout {
        setup: snapshot.settings.page_setup(),
        look,
        title,
    })
}

#[cfg(target_os = "macos")]
pub(crate) async fn print_page(
    app: &AppHandle,
    label: &'static str,
    page: String,
    title: String,
    target: crate::native::macos::PrintTarget,
) -> Result<bool, String> {
    let handle = app.clone();
    on_main_thread(app, move |done| {
        crate::native::macos::print_in_window(&handle, label, &page, &title, target, done)
    })
    .await
}

#[cfg(target_os = "macos")]
async fn print_note_page(
    app: &AppHandle,
    page: String,
    layout: PageLayout,
    target: crate::native::macos::PrintTarget,
    work: PathBuf,
) -> Result<bool, String> {
    let handle = app.clone();
    on_main_thread(app, move |done| {
        crate::native::macos::print_note_in_window(
            &handle,
            crate::MAIN_WINDOW,
            &page,
            layout,
            target,
            &work,
            done,
        )
    })
    .await
}

#[cfg(target_os = "macos")]
async fn on_main_thread(
    app: &AppHandle,
    start: impl FnOnce(crate::native::macos::PrintDone) + Send + 'static,
) -> Result<bool, String> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        start(Box::new(move |result| {
            let _ = reply.send(result);
        }))
    })
    .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
    answer
        .await
        .map_err(|_| String::from("E_PRINT_FAILED"))?
        .map_err(String::from)
}

#[cfg(target_os = "macos")]
fn print_folder(app: &AppHandle) -> Result<PdfPartial, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|_| String::from("E_EXPORT_PDF_FOLDER_FAILED"))?;
    PdfPartial::new_in(&data.join(PDF_DIR)).map_err(String::from)
}

/// True when it printed; false when the user cancelled.
#[tauri::command]
pub async fn note_print(
    app: AppHandle,
    db: State<'_, Db>,
    title: String,
    html: String,
    images: Vec<PageImage>,
    look: PageLook,
) -> Result<bool, String> {
    let layout = page_layout(&app, job_title(&title), look)?;
    let page = page_with_images(&db, html, images).await?;
    #[cfg(target_os = "macos")]
    {
        let work = print_folder(&app)?;
        let printed = print_note_page(
            &app,
            page,
            layout,
            crate::native::macos::PrintTarget::Printer,
            work.folder().to_owned(),
        )
        .await?;
        log::info!("I_PRINT_DONE printed={printed}");
        Ok(printed)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, page, layout);
        Err("E_PRINT_UNSUPPORTED".into())
    }
}

/// True when saved; false when the user cancelled.
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    db: State<'_, Db>,
    name: String,
    title: String,
    html: String,
    images: Vec<PageImage>,
    look: PageLook,
) -> Result<bool, String> {
    if !valid_stem(&name) {
        return Err("E_EXPORT_NAME_INVALID".into());
    }
    let layout = page_layout(&app, job_title(&title), look)?;
    let page = page_with_images(&db, html, images).await?;
    let Some(path) = ask_save(
        &app,
        strings::EXPORT_PDF_TITLE,
        format!("{name}.pdf"),
        strings::EXPORT_PDF_FILTER,
        "pdf",
    )
    .await?
    else {
        return Ok(false);
    };
    let (folder, name) = chosen_file(&path, "pdf")?;
    #[cfg(target_os = "macos")]
    {
        let partial = print_folder(&app)?;
        let printed = print_note_page(
            &app,
            page,
            layout,
            crate::native::macos::PrintTarget::Pdf(partial.file()),
            partial.folder().to_owned(),
        )
        .await;
        let saved = match printed {
            Ok(true) => partial
                .persist(&folder, &name)
                .map(|()| true)
                .map_err(String::from),
            // A PDF has no panel to cancel: one not written failed (the job
            // reports that as this error itself).
            Ok(false) => Err(String::from("E_EXPORT_PDF_FAILED")),
            Err(code) => Err(code),
        };
        log::info!("I_EXPORT_PDF_DONE saved={}", matches!(saved, Ok(true)));
        saved
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (folder, name, page, layout);
        Err("E_PRINT_UNSUPPORTED".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const FILE: &str = "0192a6f0-0000-7000-8000-00000000f001";
    const OTHER: &str = "0192a6f0-0000-7000-8000-00000000f002";
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn token(n: u32) -> String {
        format!("{PLACEHOLDER_PREFIX}{NONCE}-{n}")
    }

    fn image(n: u32, file_id: &str) -> PageImage {
        PageImage {
            placeholder: token(n),
            file_id: file_id.into(),
        }
    }

    fn png(name: &str) -> Option<Attachment> {
        Some(Attachment {
            name: name.into(),
            mime: "image/png".into(),
            data: PNG.to_vec(),
        })
    }

    fn open(path: &Path) -> Folder {
        Folder::open(path).unwrap()
    }

    fn notebook(dir: &Path, name: &str) -> (PathBuf, Folder) {
        let (folder, made) = new_folder(&open(dir), name).unwrap();
        (dir.join(made), folder)
    }

    #[test]
    fn accepts_only_plain_visible_names() {
        assert!(valid_stem("Weekly plan"));
        assert!(valid_stem("v1.2 notes"));
        for bad in [
            "", " lead", "trail ", ".hidden", "a/b", "a\\b", "a:b", "a\nb", "a\0b",
        ] {
            assert!(!valid_stem(bad), "{bad:?}");
        }
        assert!(valid_stem(&"x".repeat(MAX_NAME_BYTES)));
        assert!(!valid_stem(&"x".repeat(MAX_NAME_BYTES + 1)));
        // Bytes, not characters: 67 three-byte characters are too long.
        assert!(valid_stem(&"\u{540c}".repeat(66)));
        assert!(!valid_stem(&"\u{540c}".repeat(67)));
    }

    #[test]
    fn any_title_names_a_print_job() {
        assert_eq!(job_title("Weekly plan"), "Weekly plan");
        assert_eq!(job_title(""), "");
        assert_eq!(job_title("A\tB"), "A B");
        assert_eq!(job_title("a\r\nb\0c\u{7f}"), "a  b c ");
        let long = format!("{}tail", "\u{e9}".repeat(MAX_TITLE_CHARS));
        assert_eq!(job_title(&long), "\u{e9}".repeat(MAX_TITLE_CHARS));
    }

    #[test]
    fn copies_any_html_without_nul_even_none() {
        assert!(valid_clipboard_html(""));
        assert!(valid_clipboard_html("<p>a</p>"));
        assert!(!valid_clipboard_html("<p>a\0</p>"));
    }

    #[test]
    fn accepts_only_relative_paths_with_the_extension() {
        assert!(valid_rel_path("Plan.md", "md"));
        assert!(valid_rel_path("Projects/Deep/Spec.MD", "md"));
        assert!(valid_rel_path("Projects/Plan.html", "html"));
        for bad in [
            "",
            "Plan.html",
            "Plan",
            "../Plan.md",
            "a/../Plan.md",
            "./Plan.md",
            "/etc/Plan.md",
            ".hidden.md",
            "a/.git/Plan.md",
            "a//Plan.md",
            "a/Plan.md/",
            "a\\Plan.md",
            "a:b.md",
            "a\0.md",
            "a\n.md",
        ] {
            assert!(!valid_rel_path(bad, "md"), "{bad:?}");
        }
        let long = format!("{}.md", "x".repeat(256));
        assert!(!valid_rel_path(&long, "md"));
    }

    #[test]
    fn checks_placeholders_and_ids() {
        assert!(valid_placeholder(&token(0)));
        assert!(valid_placeholder(&token(999_999)));
        for bad in [
            format!("{PLACEHOLDER_PREFIX}{NONCE}-"),
            format!("{PLACEHOLDER_PREFIX}{NONCE}-1234567"),
            format!("{PLACEHOLDER_PREFIX}{}-1", NONCE.to_uppercase()),
            format!("{PLACEHOLDER_PREFIX}{}-1", &NONCE[1..]),
            format!("{PLACEHOLDER_PREFIX}{NONCE}-1x"),
            format!("x{}", token(1)),
        ] {
            assert!(!valid_placeholder(&bad), "{bad:?}");
        }
        assert_eq!(validate_images(&[image(0, FILE), image(1, FILE)]), Ok(()));
        assert_eq!(
            validate_images(&[image(0, FILE), image(0, OTHER)]),
            Err("E_EXPORT_PLACEHOLDER_INVALID")
        );
        assert_eq!(
            validate_images(&[image(0, "../x")]),
            Err("E_FILE_ID_INVALID")
        );
        let many: Vec<_> = (0..=MAX_IMAGES as u32).map(|n| image(n, FILE)).collect();
        assert_eq!(validate_images(&many), Err("E_EXPORT_TOO_MANY_IMAGES"));
    }

    #[test]
    fn puts_images_in_as_data_uris_and_leaves_other_text_alone() {
        let page = format!(
            "<img src=\"{}\"><img src=\"{}\"><img src=\"{}\"><code>{PLACEHOLDER_PREFIX}{NONCE}-9 devot-image- devot://file/{FILE}</code>",
            token(0),
            token(1),
            token(0)
        );
        let out = inline_images(&page, &[image(0, FILE), image(1, OTHER)], |id| {
            (id == FILE).then(|| ("image/png".to_string(), PNG.to_vec()))
        })
        .unwrap();
        let uri = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(PNG)
        );
        assert_eq!(
            out,
            format!(
                "<img src=\"{uri}\"><img src=\"\"><img src=\"{uri}\"><code>{PLACEHOLDER_PREFIX}{NONCE}-9 devot-image- devot://file/{FILE}</code>"
            )
        );
        let out = inline_images("<p>x</p>", &[image(0, FILE)], |_| panic!("read")).unwrap();
        assert_eq!(out, "<p>x</p>");
        assert_eq!(
            inline_images("<p>x</p>", &[], |_| None).unwrap(),
            "<p>x</p>"
        );
    }

    #[test]
    fn refuses_a_page_that_grows_past_the_limit() {
        let big = vec![0u8; MAX_PAGE_BYTES / 4 * 3 + 1];
        let images = [image(0, FILE)];
        let out = inline_images(&token(0), &images, |_| {
            Some(("image/png".to_string(), big.clone()))
        });
        assert_eq!(out, Err("E_EXPORT_TOO_LARGE"));
    }

    #[test]
    fn an_image_shown_many_times_counts_each_time() {
        let data = vec![0u8; MAX_PAGE_BYTES / 4];
        let page = token(0).repeat(3);
        let out = inline_images(&page, &[image(0, FILE)], |_| {
            Some(("image/png".to_string(), data.clone()))
        });
        assert_eq!(out, Err("E_EXPORT_TOO_LARGE"));
        let out = inline_images(&token(0).repeat(2), &[image(0, FILE)], |_| {
            Some(("image/png".to_string(), data.clone()))
        })
        .unwrap();
        assert!(out.len() <= MAX_PAGE_BYTES);
    }

    #[test]
    fn names_attachments_after_their_stored_names() {
        assert_eq!(attachment_name("board.png", "image/png"), "board.png");
        assert_eq!(attachment_name("my shot.JPG", "image/jpeg"), "my shot.JPG");
        assert_eq!(attachment_name("a/b:c.png", "image/png"), "a-b-c.png");
        assert_eq!(attachment_name("..hidden.png", "image/png"), "hidden.png");
        assert_eq!(attachment_name("noext", "image/jpeg"), "noext.jpg");
        assert_eq!(attachment_name("", "image/gif"), "image.gif");
        assert_eq!(attachment_name(".png", "image/png"), "png.png");
        assert_eq!(
            attachment_name("\u{540c}.webp", "image/webp"),
            "\u{540c}.webp"
        );
        let long = attachment_name(&format!("{}.png", "x".repeat(400)), "image/png");
        assert_eq!(long.len(), MAX_NAME_BYTES + 4);
        let wide = attachment_name(&format!("{}.png", "\u{540c}".repeat(100)), "image/png");
        assert_eq!(wide, format!("{}.png", "\u{540c}".repeat(66)));
    }

    #[test]
    fn writes_through_a_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let folder = open(dir.path());
        let path = dir.path().join("note.md");
        write_file(&folder, "note.md", b"one", Place::Replace).unwrap();
        write_file(&folder, "note.md", b"two", Place::Replace).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        let left: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert_eq!(left.len(), 1, "no temporary file is left behind");
        // A new file never goes over one.
        assert_eq!(
            write_file(&folder, "note.md", b"three", Place::New),
            Err("E_EXPORT_EXISTS")
        );
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        // A name, never a path, which the system would follow a link on.
        assert_eq!(
            write_file(&folder, "missing/note.md", b"x", Place::Replace),
            Err("E_EXPORT_WRITE_FAILED")
        );
    }

    /// Links at every name a temporary file of an export or a PDF once took
    /// (`.devot-export-<process ID>-<counter>`), all to `theirs`: in a
    /// folder others write to, such names were easy to plant ahead.
    #[cfg(unix)]
    fn plant_links_at_old_temporary_names(dir: &Path, theirs: &Path) {
        let pid = std::process::id();
        for n in 0..1000 {
            for extension in ["tmp", "pdf"] {
                let name = format!(".devot-export-{pid}-{n}.{extension}");
                std::os::unix::fs::symlink(theirs, dir.join(name)).unwrap();
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link_at_a_temporary_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        fs::write(&theirs, b"theirs").unwrap();
        plant_links_at_old_temporary_names(dir.path(), &theirs);
        let exports = Exports::default();
        let id = exports.start(
            open(dir.path()),
            Kind::Note,
            Format::Markdown,
            Some("Plan.md".into()),
        );
        exports.write(id, "Plan.md", b"# Plan\n").unwrap();
        let plan = dir.path().join("Plan.md");
        assert!(fs::symlink_metadata(&plan).unwrap().is_file());
        assert_eq!(fs::read(&plan).unwrap(), b"# Plan\n");
        let folder = dir.path().join(ATTACHMENTS);
        fs::create_dir(&folder).unwrap();
        plant_links_at_old_temporary_names(&folder, &theirs);
        assert_eq!(
            exports.attach(id, FILE, || png("board.png")),
            Ok("attachments/board.png".into())
        );
        assert!(
            fs::symlink_metadata(folder.join("board.png"))
                .unwrap()
                .is_file()
        );
        assert_eq!(fs::read(folder.join("board.png")).unwrap(), PNG);
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
    }

    #[cfg(unix)]
    #[test]
    fn a_pdf_is_printed_in_the_apps_data_and_copied_into_place() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        fs::write(&theirs, b"theirs").unwrap();
        plant_links_at_old_temporary_names(dir.path(), &theirs);
        let path = dir.path().join("Plan.pdf");
        fs::write(&path, b"old").unwrap();
        let before = fs::read_dir(dir.path()).unwrap().count();
        // What `export_pdf` does around the print job: AppKit writes the
        // file by its path, as `fs::write` does here (following any link),
        // in a private folder of the app's data, never in the folder the
        // user chose, where others may swap it for a link meanwhile.
        let pdfs = data.path().join(PDF_DIR);
        let partial = PdfPartial::new_in(&pdfs).unwrap();
        assert!(partial.file().starts_with(&pdfs));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), before);
        fs::write(partial.file(), b"%PDF-1.7").unwrap();
        partial.persist(&open(dir.path()), "Plan.pdf").unwrap();
        assert!(fs::symlink_metadata(&path).unwrap().is_file());
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-1.7");
        assert_eq!(fs::read(&theirs).unwrap(), b"theirs");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), before);
        drop(partial);
        assert_eq!(fs::read_dir(&pdfs).unwrap().count(), 0);
        let failed = PdfPartial::new_in(&pdfs).unwrap();
        assert_eq!(
            failed.persist(&open(dir.path()), "Plan.pdf"),
            Err("E_EXPORT_WRITE_FAILED")
        );
        drop(failed);
        assert_eq!(fs::read_dir(&pdfs).unwrap().count(), 0);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), before);
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-1.7");
        let blocked = data.path().join("blocked");
        fs::write(&blocked, b"a file").unwrap();
        assert_eq!(
            PdfPartial::new_in(&blocked.join(PDF_DIR)).err(),
            Some("E_EXPORT_PDF_FOLDER_FAILED")
        );
    }

    #[test]
    fn sweeps_only_stale_pdf_job_folders() {
        let data = tempfile::tempdir().unwrap();
        let pdfs = data.path().join(PDF_DIR);
        let plant = |name: &str| {
            let path = pdfs.join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join(PDF_NAME), b"%PDF").unwrap();
            path
        };
        let stale = plant(&format!(".devot-{}.tmp", "a".repeat(32)));
        let fresh = plant(&format!(".devot-{}.tmp", "b".repeat(32)));
        let other = plant("notes");
        let old = std::time::SystemTime::now() - PDF_STALE_AFTER * 2;
        for path in [&stale, &other] {
            fs::File::open(path).unwrap().set_modified(old).unwrap();
        }
        let job = PdfPartial::new_in(&pdfs).unwrap();
        assert!(!stale.exists());
        assert!(fresh.is_dir() && other.is_dir() && job.folder().is_dir());
    }

    #[test]
    fn a_notebook_gets_a_new_folder_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let parent = open(dir.path());
        let made = |name: &str| new_folder(&parent, name).map(|(_, made)| made);
        assert_eq!(made("Work v1.2"), Ok("Work v1.2".into()));
        assert_eq!(made("Work v1.2"), Ok("Work v1.2 2".into()));
        assert!(dir.path().join("Work v1.2 2").is_dir());
        fs::write(dir.path().join("Plans"), b"a file").unwrap();
        assert_eq!(made("Plans"), Ok("Plans 2".into()));
        assert_eq!(made("../x"), Err("E_EXPORT_NAME_INVALID"));
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), dir.path().join("Linked")).unwrap();
            let (folder, name) = new_folder(&parent, "Linked").unwrap();
            assert_eq!(name, "Linked 2");
            folder.write("Plan.md", b"x", Place::New).unwrap();
            assert_eq!(fs::read(dir.path().join("Linked 2/Plan.md")).unwrap(), b"x");
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn the_chosen_file_gets_its_extension() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let name = |path: &Path, extension| chosen_file(path, extension).map(|(_, name)| name);
        assert_eq!(name(&root.join("Plan.md"), "md"), Ok("Plan.md".into()));
        assert_eq!(name(&root.join("Plan.MD"), "md"), Ok("Plan.MD".into()));
        assert_eq!(name(&root.join("Plan"), "pdf"), Ok("Plan.pdf".into()));
        assert_eq!(
            name(&root.join("missing/Plan.md"), "md"),
            Err("E_EXPORT_PATH_INVALID")
        );
        assert_eq!(
            name(Path::new("Plan.md"), "md"),
            Err("E_EXPORT_PATH_INVALID")
        );
        // The panel never asked about `Plan.pdf`: it is not replaced.
        fs::write(root.join("Plan.pdf"), b"old").unwrap();
        assert_eq!(name(&root.join("Plan"), "pdf"), Err("E_EXPORT_EXISTS"));
        assert!(chosen_file(&root.join("Plan.pdf"), "pdf").is_ok());
        let (folder, file) = chosen_file(&root.join("Spec"), "md").unwrap();
        folder.write(&file, b"x", Place::New).unwrap();
        assert_eq!(fs::read(root.join("Spec.md")).unwrap(), b"x");
    }

    #[test]
    fn a_note_session_writes_only_its_file_and_may_replace_it() {
        let dir = tempfile::tempdir().unwrap();
        let exports = Exports::default();
        let id = exports.start(
            open(dir.path()),
            Kind::Note,
            Format::Markdown,
            Some("Plan.md".into()),
        );
        fs::write(dir.path().join("Plan.md"), b"old").unwrap();
        exports.write(id, "Plan.md", b"# Plan\n").unwrap();
        assert_eq!(fs::read(dir.path().join("Plan.md")).unwrap(), b"# Plan\n");
        assert_eq!(
            exports.write(id, "Other.md", b"x"),
            Err("E_EXPORT_PATH_INVALID")
        );
        assert_eq!(
            exports.write(id + 1, "Plan.md", b"x"),
            Err("E_EXPORT_SESSION")
        );
        exports.finish(id);
        assert_eq!(exports.write(id, "Plan.md", b"x"), Err("E_EXPORT_SESSION"));
        // The name the user typed may hold a colon (a slash in Finder) or a backslash.
        let named = exports.start(
            open(dir.path()),
            Kind::Note,
            Format::Html,
            Some("Q1:Q2 a\\b.html".into()),
        );
        exports
            .write(named, "Q1:Q2 a\\b.html", b"<p>x</p>")
            .unwrap();
        assert!(dir.path().join("Q1:Q2 a\\b.html").exists());
    }

    #[test]
    fn a_notebook_session_writes_new_files_inside_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (root, folder) = notebook(dir.path(), "Work");
        let exports = Exports::default();
        let id = exports.start(folder, Kind::Notebook, Format::Html, None);
        exports
            .write(id, "Plans/Deep/Spec.html", b"<p>x</p>")
            .unwrap();
        assert_eq!(
            fs::read(root.join("Plans/Deep/Spec.html")).unwrap(),
            b"<p>x</p>"
        );
        assert_eq!(
            exports.write(id, "Plans/Deep/Spec.html", b"y"),
            Err("E_EXPORT_EXISTS")
        );
        for bad in ["attachments/x.html", "../x.html", "Plan.md", ".x.html"] {
            assert_eq!(exports.write(id, bad, b"y"), Err("E_EXPORT_PATH_INVALID"));
        }
        assert!(!dir.path().join("x.html").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_notebook_session_never_writes_through_a_link_on_the_way() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (root, folder) = notebook(dir.path(), "Work");
        let exports = Exports::default();
        let id = exports.start(folder, Kind::Notebook, Format::Markdown, None);
        std::os::unix::fs::symlink(outside.path(), root.join("Plans")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("new"), root.join("Gone")).unwrap();
        fs::create_dir(root.join("Real")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("Real/Deep")).unwrap();
        for path in ["Plans/Spec.md", "Gone/Spec.md", "Real/Deep/Spec.md"] {
            assert_eq!(
                exports.write(id, path, b"x"),
                Err("E_EXPORT_FOLDER_FAILED"),
                "{path}"
            );
        }
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        exports.write(id, "Real/New/Spec.md", b"y").unwrap();
        assert_eq!(fs::read(root.join("Real/New/Spec.md")).unwrap(), b"y");
    }

    #[cfg(unix)]
    fn swap_for_link(folder: &Path, to: &Path) -> PathBuf {
        let name = folder.file_name().unwrap().to_str().unwrap();
        let moved = folder.with_file_name(format!("{name} (moved)"));
        fs::rename(folder, &moved).unwrap();
        std::os::unix::fs::symlink(to, folder).unwrap();
        moved
    }

    /// A folder of a notebook's export, swapped for a link between the
    /// session's checks and the write (`atomic_file::race`), as a local
    /// process that may rename entries in the chosen folder could: the file
    /// still goes into the folder that was checked, never through the link.
    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_for_a_link_after_the_checks_is_never_followed() {
        use crate::atomic_file::race;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (root, folder) = notebook(dir.path(), "Work");
        let exports = Exports::default();
        let id = exports.start(folder, Kind::Notebook, Format::Markdown, None);
        race::swap_at_check(
            &root.join("Plans"),
            &root.join("Plans (moved)"),
            outside.path(),
        );
        assert_eq!(exports.write(id, "Plans/Spec.md", b"x"), Ok(()));
        assert!(race::ran());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(fs::read(root.join("Plans (moved)/Spec.md")).unwrap(), b"x");
        fs::create_dir(root.join("Deep")).unwrap();
        race::swap_at_check(
            &root.join("Deep"),
            &root.join("Deep (moved)"),
            outside.path(),
        );
        assert_eq!(exports.write(id, "Deep/Spec.md", b"y"), Ok(()));
        assert!(race::ran());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(fs::read(root.join("Deep (moved)/Spec.md")).unwrap(), b"y");
        race::swap_at_check(
            &root.join(ATTACHMENTS),
            &root.join("attachments (moved)"),
            outside.path(),
        );
        assert_eq!(
            exports.attach(id, FILE, || png("board.png")),
            Ok("attachments/board.png".into())
        );
        assert!(race::ran());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(
            fs::read(root.join("attachments (moved)/board.png")).unwrap(),
            PNG
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_session_writes_into_the_folder_chosen_even_once_it_is_swapped() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let exports = Exports::default();
        let chosen = dir.path().join("Chosen");
        fs::create_dir(&chosen).unwrap();
        let (folder, file_name) = chosen_file(&chosen.join("Plan.md"), "md").unwrap();
        let note = exports.start(folder, Kind::Note, Format::Markdown, Some(file_name));
        let (root, folder) = notebook(dir.path(), "Work");
        let book = exports.start(folder, Kind::Notebook, Format::Html, None);
        let chosen_moved = swap_for_link(&chosen, outside.path());
        let root_moved = swap_for_link(&root, outside.path());
        assert_eq!(exports.write(note, "Plan.md", b"# Plan\n"), Ok(()));
        assert_eq!(
            exports.attach(note, FILE, || png("board.png")),
            Ok("attachments/board.png".into())
        );
        assert_eq!(exports.write(book, "Plans/Spec.html", b"<p>x</p>"), Ok(()));
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(fs::read(chosen_moved.join("Plan.md")).unwrap(), b"# Plan\n");
        assert_eq!(
            fs::read(chosen_moved.join("attachments/board.png")).unwrap(),
            PNG
        );
        assert_eq!(
            fs::read(root_moved.join("Plans/Spec.html")).unwrap(),
            b"<p>x</p>"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_pdf_goes_into_the_folder_chosen_even_once_it_is_swapped() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let chosen = dir.path().join("Chosen");
        fs::create_dir(&chosen).unwrap();
        let (folder, name) = chosen_file(&chosen.join("Plan"), "pdf").unwrap();
        let partial = PdfPartial::new_in(&data.path().join(PDF_DIR)).unwrap();
        fs::write(partial.file(), b"%PDF-1.7").unwrap();
        let moved = swap_for_link(&chosen, outside.path());
        partial.persist(&folder, &name).unwrap();
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(fs::read(moved.join("Plan.pdf")).unwrap(), b"%PDF-1.7");
    }

    #[test]
    fn copies_each_attachment_once_without_replacing_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let exports = Exports::default();
        let id = exports.start(
            open(dir.path()),
            Kind::Note,
            Format::Markdown,
            Some("Plan.md".into()),
        );
        let folder = dir.path().join(ATTACHMENTS);
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("board.png"), b"someone else's").unwrap();
        fs::write(folder.join("logo.png"), PNG).unwrap();
        assert_eq!(
            exports.attach(id, FILE, || png("board.png")),
            Ok("attachments/board 2.png".into())
        );
        assert_eq!(
            fs::read(folder.join("board.png")).unwrap(),
            b"someone else's"
        );
        assert_eq!(fs::read(folder.join("board 2.png")).unwrap(), PNG);
        assert_eq!(
            exports.attached(id, FILE),
            Some("attachments/board 2.png".into())
        );
        assert_eq!(exports.attached(id, OTHER), None);
        assert_eq!(
            exports.attach(id, FILE, || panic!("read twice")),
            Ok("attachments/board 2.png".into())
        );
        assert_eq!(
            exports.attach(id, OTHER, || png("logo.png")),
            Ok("attachments/logo.png".into())
        );
        const THIRD: &str = "0192a6f0-0000-7000-8000-00000000f003";
        assert_eq!(
            exports.attach(id, THIRD, || png("LOGO.png")),
            Ok("attachments/LOGO 2.png".into())
        );
        const MISSING: &str = "0192a6f0-0000-7000-8000-00000000f004";
        #[cfg(unix)]
        {
            let other = tempfile::tempdir().unwrap();
            let linked = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(other.path(), linked.path().join(ATTACHMENTS)).unwrap();
            let id = exports.start(
                open(linked.path()),
                Kind::Note,
                Format::Markdown,
                Some("Plan.md".into()),
            );
            assert_eq!(
                exports.attach(id, FILE, || png("a.png")),
                Err("E_EXPORT_FOLDER_FAILED")
            );
            assert_eq!(fs::read_dir(other.path()).unwrap().count(), 0);
        }
        assert_eq!(
            exports.attach(id, MISSING, || None),
            Err("E_FILE_NOT_FOUND")
        );
        assert_eq!(
            exports.attach(id, "x", || png("a.png")),
            Err("E_FILE_ID_INVALID")
        );
        assert_eq!(
            exports.attach(id + 100, FILE, || png("a.png")),
            Err("E_EXPORT_SESSION")
        );
    }
}
