//! The mirror's folder: its manifest, and the operations the core plans (`src/core/mirror.ts`),
//! each checked against the manifest and the disk again before it acts.
//! The rules that keep files safe:
//! - Every path is relative, of plain visible components, inside the folder; note files end in
//!   `.md`, attachments are `attachments/<name>`.
//! - Devot moves or deletes only a file the manifest lists, and only while it holds what the
//!   manifest says (its SHA-256). A file changed outside Devot is renamed to a free "edited outside
//!   Devot" name and leaves the manifest, so it is never touched again.
//! - A file Devot did not write is never replaced, unless it holds exactly what Devot would write
//!   there.
//! - Nothing is written through a link: every folder on the way must be a real folder (missing ones
//!   are made, one by one); the mirror's own folder is never made.
//! - Each call opens the folder once (`Root`) and finds every path in it folder by folder from that
//!   handle (`find`), so a check and the step that acts on it work in the same folders and a folder
//!   swapped for a link in between is never followed (see `atomic_file`).
//! - Every file goes through `atomic_file`: a new temporary file of a hidden random name, created
//!   new, then put in place. New files go only where nothing is yet, so a file or a link that
//!   appears there after the checks is never replaced (the plan learns it is in the way); only
//!   Devot's own file, checked just before, is replaced. A move is whole: a file never stays under
//!   its old name too.
//! - Files are not flushed one by one: the notes database is the source of truth, and a file a
//!   crash left short is caught by the next reconcile (kept under the "edited outside Devot" name,
//!   never lost, and written again). The manifest itself is flushed.

use crate::atomic_file::{self, Folder, Place};
use crate::commands::notes::valid_note_id;
use crate::export::{plain_rel_path, valid_rel_path};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

pub const MANIFEST: &str = ".devot-mirror.json";
const MANIFEST_VERSION: u32 = 1;
pub const ATTACHMENTS: &str = "attachments";
pub const DIR: &str = "dir";
pub const OTHER: &str = "other";
/// Matches the link limit of note bodies.
pub const MAX_NOTE_FILES: usize = 10_000;
const MAX_SOURCE_LEN: usize = 64;
pub const MAX_TEXT_BYTES: usize = crate::export::MAX_TEXT_BYTES;
const MAX_KEEP_TRIES: u32 = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub source: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub sha256: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub notes: BTreeMap<String, NoteEntry>,
    #[serde(default)]
    pub files: BTreeMap<String, FileEntry>,
    #[serde(default)]
    pub books: BTreeMap<String, String>,
}

impl Manifest {
    pub fn size(&self) -> u64 {
        self.notes.values().map(|e| e.size).sum::<u64>()
            + self
                .files
                .values()
                .filter(|e| e.sha256.is_some())
                .map(|e| e.size)
                .sum::<u64>()
    }
}

#[derive(Serialize, Deserialize)]
struct ManifestFile {
    version: u32,
    #[serde(flatten)]
    manifest: Manifest,
}

/// Attachments Devot stores have UUIDv7 IDs; a link to any other UUID is simply to no attachment,
/// never a reason to refuse the note.
pub fn valid_uuid(id: &str) -> bool {
    uuid::Uuid::try_parse(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

pub fn valid_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn valid_note_path(path: &str) -> bool {
    valid_rel_path(path, "md")
        && !path
            .split('/')
            .next()
            .is_some_and(|top| top.eq_ignore_ascii_case(ATTACHMENTS))
}

pub fn valid_file_path(path: &str) -> bool {
    plain_rel_path(path)
        && path
            .split_once('/')
            .is_some_and(|(top, name)| top == ATTACHMENTS && !name.contains('/'))
}

/// Keeps only well-formed entries; None when the file is not a manifest at all.
pub fn parse_manifest(bytes: &[u8]) -> Option<Manifest> {
    let file: ManifestFile = serde_json::from_slice(bytes).ok()?;
    if file.version != MANIFEST_VERSION {
        return None;
    }
    let mut manifest = file.manifest;
    let before = manifest.notes.len() + manifest.files.len() + manifest.books.len();
    manifest.notes.retain(|id, e| {
        valid_note_id(id)
            && valid_note_path(&e.path)
            && valid_sha256(&e.sha256)
            && e.source.len() <= MAX_SOURCE_LEN
            && e.files.len() <= MAX_NOTE_FILES
            && e.files.iter().all(|f| valid_uuid(f))
    });
    manifest.files.retain(|id, e| {
        valid_note_id(id)
            && valid_file_path(&e.path)
            && e.sha256.as_deref().is_none_or(valid_sha256)
    });
    manifest
        .books
        .retain(|id, path| valid_note_id(id) && plain_rel_path(path));
    if manifest.notes.len() + manifest.files.len() + manifest.books.len() < before {
        log::warn!("W_MIRROR_MANIFEST_ENTRIES_DROPPED");
    }
    Some(manifest)
}

pub fn manifest_bytes(manifest: &Manifest) -> Vec<u8> {
    serde_json::to_vec(&ManifestFile {
        version: MANIFEST_VERSION,
        manifest: manifest.clone(),
    })
    .unwrap_or_default()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A handle to the folder, from which every path in it is found folder by folder, never through a
/// link (see `atomic_file::Folder`), so a check and the step that acts on it work in the same
/// folders; and its path, only to tell a folder that went away from one that cannot be written.
#[derive(Debug, Clone)]
pub struct Root {
    path: PathBuf,
    folder: Folder,
}

impl Root {
    /// Opens the folder at `path`, which was resolved when the user chose it
    /// (`canonicalize`): a link anywhere on it now means something took the
    /// folder's place, which is refused as a folder that went away is.
    pub fn open(path: &Path) -> std::io::Result<Self> {
        Ok(Self {
            path: path.to_owned(),
            folder: Folder::open_resolved(path)?,
        })
    }

    pub fn is_missing(&self) -> bool {
        !self.path.is_dir()
    }
}

#[derive(Debug)]
struct At<'a> {
    rel: &'a str,
    folder: Folder,
    name: &'a str,
}

#[derive(Debug)]
enum Lost<'a> {
    Missing,
    NotFolder(&'a str),
}

fn on_the_way(rel: &str) -> Vec<(&str, &str)> {
    let Some(slash) = rel.rfind('/') else {
        return Vec::new();
    };
    let mut start = 0;
    rel[..slash]
        .split('/')
        .map(|part| {
            let end = start + part.len();
            start = end + 1;
            (part, &rel[..end])
        })
        .collect()
}

fn find<'a>(root: &Root, rel: &'a str) -> Result<At<'a>, Lost<'a>> {
    let mut folder = root.folder.clone();
    for (part, at) in on_the_way(rel) {
        folder = match folder.folder(part) {
            Ok(next) => next,
            Err(e) if e.kind() == ErrorKind::NotADirectory => return Err(Lost::NotFolder(at)),
            Err(_) => return Err(Lost::Missing),
        };
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    Ok(At { rel, folder, name })
}

fn look<'a>(root: &Root, rel: &'a str) -> (Option<At<'a>>, Option<String>) {
    match find(root, rel) {
        Ok(at) => {
            let state = state_at(&at);
            (Some(at), state)
        }
        Err(Lost::Missing) => (None, None),
        Err(Lost::NotFolder(_)) => (None, Some(OTHER.into())),
    }
}

/// What is at `rel` in the folder at `root`: a regular file's SHA-256, `dir`,
/// `other` (a link, or a link or file where a folder on the way should be),
/// or nothing. Links are never followed.
pub fn disk_state(root: &Root, rel: &str) -> Option<String> {
    look(root, rel).1
}

fn state_at(at: &At) -> Option<String> {
    let entry = at.folder.entry(at.name).ok()?;
    if entry.is_folder() {
        return Some(DIR.into());
    }
    if !entry.is_file() {
        return Some(OTHER.into());
    }
    let hashed = at.folder.read_file(at.name).and_then(|mut file| {
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)?;
        Ok(hex(&hasher.finalize()))
    });
    Some(hashed.unwrap_or_else(|_| OTHER.into()))
}

/// Whether two paths found name the same file (one name in another case,
/// on a file system that ignores case).
fn same_file(a: &At, b: &At) -> bool {
    match (a.folder.entry(a.name), b.folder.entry(b.name)) {
        (Ok(x), Ok(y)) => x.same_file(&y),
        _ => false,
    }
}

pub fn has_entries(root: &Root) -> std::io::Result<bool> {
    Ok(root
        .folder
        .names()?
        .iter()
        .any(|name| !matches!(name.to_str(), Some(".DS_Store" | ".localized"))))
}

/// Uses a new temporary file that goes again at once (see `atomic_file`): never a file someone else
/// has there, never through a link.
pub fn probe_writable(root: &Root) -> std::io::Result<()> {
    root.folder.check_writable()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Note,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Op {
    Keep {
        entry: EntryKind,
        id: String,
        path: String,
    },
    Forget {
        entry: EntryKind,
        id: String,
    },
    Remove {
        entry: EntryKind,
        id: String,
        path: String,
        sha256: String,
    },
    Note {
        id: String,
        path: String,
        from: Option<String>,
        sha256: String,
        #[serde(default)]
        text: Option<String>,
        source: String,
        files: Vec<String>,
    },
    File {
        id: String,
        path: String,
        copy: bool,
    },
    Book {
        id: String,
        path: Option<String>,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    /// E_MIRROR_EXISTS and E_MIRROR_CHANGED: the path in the way...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// ...and what is there (null for nothing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept: Option<String>,
}

impl OpResult {
    fn failed(code: &'static str) -> Self {
        Self {
            code: Some(code),
            ..Self::default()
        }
    }

    fn in_the_way(code: &'static str, path: &str, state: Option<String>) -> Self {
        Self {
            code: Some(code),
            path: Some(path.to_owned()),
            state: Some(state),
            ..Self::default()
        }
    }

    fn sized(size: u64) -> Self {
        Self {
            size: Some(size),
            ..Self::default()
        }
    }

    pub fn pauses(&self) -> bool {
        matches!(
            self.code,
            Some("E_MIRROR_FOLDER_MISSING" | "E_MIRROR_FOLDER_READ_ONLY")
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Stop {
    code: &'static str,
    at: Option<Box<(String, Option<String>)>>,
}

impl Stop {
    fn code(code: &'static str) -> Self {
        Self { code, at: None }
    }

    fn at(code: &'static str, path: &str, state: Option<String>) -> Self {
        Self {
            code,
            at: Some(Box::new((path.to_owned(), state))),
        }
    }
}

impl From<Stop> for OpResult {
    fn from(stop: Stop) -> Self {
        match stop.at {
            Some(at) => {
                let (path, state) = *at;
                OpResult::in_the_way(stop.code, &path, state)
            }
            None => OpResult::failed(stop.code),
        }
    }
}

fn io_code(error: &std::io::Error, root: &Root) -> &'static str {
    if root.is_missing() {
        return "E_MIRROR_FOLDER_MISSING";
    }
    match error.kind() {
        // The folder itself cannot be written: the mirror pauses. One file
        // or folder in it that cannot be (locked, say) waits on its own.
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem
            if probe_writable(root).is_err() =>
        {
            "E_MIRROR_FOLDER_READ_ONLY"
        }
        _ => "E_MIRROR_WRITE_FAILED",
    }
}

fn in_the_way(root: &Root, rel: &str) -> Result<(), Stop> {
    match find(root, rel) {
        Err(Lost::NotFolder(at)) => Err(Stop::at("E_MIRROR_EXISTS", at, disk_state(root, at))),
        _ => Ok(()),
    }
}

/// The step that follows writes in the folder found.
fn make_folders<'a>(root: &Root, rel: &'a str) -> Result<At<'a>, Stop> {
    let mut folder = root.folder.clone();
    for (part, at) in on_the_way(rel) {
        let opened = match folder.folder(part) {
            Err(e) if e.kind() == ErrorKind::NotFound => match folder.make_folder(part) {
                Ok(()) => folder.folder(part),
                Err(e) if e.kind() == ErrorKind::AlreadyExists => folder.folder(part),
                Err(e) => return Err(Stop::code(io_code(&e, root))),
            },
            opened => opened,
        };
        folder = match opened {
            Ok(next) => next,
            Err(e) if e.kind() == ErrorKind::NotADirectory => {
                return Err(Stop::at("E_MIRROR_EXISTS", at, disk_state(root, at)));
            }
            Err(e) => return Err(Stop::code(io_code(&e, root))),
        };
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    Ok(At { rel, folder, name })
}

fn prune(root: &Root, rel: &str) {
    let way = on_the_way(rel);
    let mut opened = vec![root.folder.clone()];
    for (part, _) in &way {
        match opened.last().map(|folder| folder.folder(part)) {
            Some(Ok(next)) => opened.push(next),
            _ => break,
        }
    }
    for i in (0..opened.len() - 1).rev() {
        if opened[i].remove_folder(way[i].0).is_err() {
            return;
        }
    }
}

pub fn kept_name(name: &str, n: u32) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    let number = if n <= 1 {
        String::new()
    } else {
        format!(" {n}")
    };
    format!(
        "{stem}{}{number}{ext}",
        crate::strings::MIRROR_EDITED_SUFFIX
    )
}

/// A name something holds (a file, a folder or a link, also one that appears meanwhile) is passed
/// over, never replaced.
fn keep_aside(root: &Root, at: &At) -> Result<String, Stop> {
    let dir = &at.rel[..at.rel.len() - at.name.len()];
    for n in 1..=MAX_KEEP_TRIES {
        let kept = kept_name(at.name, n);
        match at.folder.rename(at.name, &at.folder, &kept, Place::New) {
            Ok(()) => return Ok(format!("{dir}{kept}")),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(Stop::code(io_code(&e, root))),
        }
    }
    Err(Stop::code("E_MIRROR_NAME_TAKEN"))
}

fn stop_at(error: &std::io::Error, root: &Root, rel: &str) -> Stop {
    if error.kind() == ErrorKind::AlreadyExists {
        Stop::at("E_MIRROR_EXISTS", rel, disk_state(root, rel))
    } else {
        Stop::code(io_code(error, root))
    }
}

fn write_new(root: &Root, at: &At, data: &[u8]) -> Result<(), Stop> {
    at.folder
        .write_unflushed(at.name, data, Place::New)
        .map_err(|e| stop_at(&e, root, at.rel))
}

fn rewrite(root: &Root, at: &At, data: &[u8]) -> Result<(), Stop> {
    at.folder
        .write_unflushed(at.name, data, Place::Replace)
        .map_err(|e| Stop::code(io_code(&e, root)))
}

fn move_file(root: &Root, from: &At, to: &At, same: bool) -> Result<(), Stop> {
    let place = if same { Place::Replace } else { Place::New };
    from.folder
        .rename(from.name, &to.folder, to.name, place)
        .map_err(|e| stop_at(&e, root, to.rel))
}

fn file_size(at: &At) -> u64 {
    at.folder.entry(at.name).map_or(0, |entry| entry.len)
}

fn valid_op(op: &Op) -> bool {
    match op {
        Op::Keep { entry, id, path }
        | Op::Remove {
            entry, id, path, ..
        } => {
            let path_ok = match entry {
                EntryKind::Note => valid_note_path(path),
                EntryKind::File => valid_file_path(path),
            };
            let hash_ok = match op {
                Op::Remove { sha256, .. } => valid_sha256(sha256),
                _ => true,
            };
            valid_note_id(id) && path_ok && hash_ok
        }
        Op::Forget { id, .. } => valid_note_id(id),
        Op::Note {
            id,
            path,
            from,
            sha256,
            text,
            source,
            files,
        } => {
            valid_note_id(id)
                && valid_note_path(path)
                && from.as_deref().is_none_or(valid_note_path)
                && valid_sha256(sha256)
                && text.as_ref().is_none_or(|t| t.len() <= MAX_TEXT_BYTES)
                && source.len() <= MAX_SOURCE_LEN
                && files.len() <= MAX_NOTE_FILES
                && files.iter().all(|f| valid_uuid(f))
        }
        Op::File { id, path, .. } => valid_note_id(id) && valid_file_path(path),
        Op::Book { id, path } => valid_note_id(id) && path.as_deref().is_none_or(plain_rel_path),
    }
}

pub fn run(
    root: &Root,
    manifest: &mut Manifest,
    op: &Op,
    load: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
) -> OpResult {
    if !valid_op(op) {
        return OpResult::failed("E_MIRROR_OP_INVALID");
    }
    let result = match op {
        Op::Keep { entry, id, path } => keep(root, manifest, *entry, id, path),
        Op::Forget { entry, id } => {
            drop_entry(manifest, *entry, id);
            Ok(OpResult::default())
        }
        Op::Remove {
            entry,
            id,
            path,
            sha256,
        } => remove(root, manifest, *entry, id, path, sha256),
        Op::Note {
            id,
            path,
            from,
            sha256,
            text,
            source,
            files,
        } => {
            let next = |size: u64| NoteEntry {
                path: path.clone(),
                sha256: sha256.clone(),
                size,
                source: source.clone(),
                files: files.clone(),
            };
            note(
                root,
                manifest,
                id,
                path,
                from.as_deref(),
                sha256,
                text.as_deref(),
                next,
            )
        }
        Op::File { id, path, copy } => file(root, manifest, id, path, *copy, load),
        Op::Book { id, path } => {
            if let Some(path) = path {
                manifest.books.insert(id.clone(), path.clone());
            } else {
                manifest.books.remove(id);
            }
            Ok(OpResult::default())
        }
    };
    result.unwrap_or_else(OpResult::from)
}

fn keep(
    root: &Root,
    manifest: &mut Manifest,
    entry: EntryKind,
    id: &str,
    path: &str,
) -> Result<OpResult, Stop> {
    let listed = match entry {
        EntryKind::Note => manifest.notes.get(id).map(|e| e.path.as_str()),
        EntryKind::File => manifest
            .files
            .get(id)
            .filter(|e| e.sha256.is_some())
            .map(|e| e.path.as_str()),
    };
    if listed != Some(path) {
        return Err(Stop::code("E_MIRROR_STALE"));
    }
    let (found, state) = look(root, path);
    let listed_sha = match entry {
        EntryKind::Note => manifest.notes.get(id).map(|e| e.sha256.clone()),
        EntryKind::File => manifest.files.get(id).and_then(|e| e.sha256.clone()),
    };
    if state.is_some() && state == listed_sha {
        return Err(Stop::at("E_MIRROR_CHANGED", path, state));
    }
    let mut result = OpResult::default();
    // Only a file is kept: a folder or a link there is not Devot's to rename.
    if let Some(at) = found
        && state.is_some_and(|s| s != DIR && s != OTHER)
    {
        atomic_file::checked();
        let kept = keep_aside(root, &at)?;
        log::info!("I_MIRROR_KEPT {id}");
        result.kept = Some(kept);
    }
    drop_entry(manifest, entry, id);
    Ok(result)
}

fn drop_entry(manifest: &mut Manifest, entry: EntryKind, id: &str) {
    if entry == EntryKind::Note {
        manifest.notes.remove(id);
    } else {
        manifest.files.remove(id);
    }
}

fn remove(
    root: &Root,
    manifest: &mut Manifest,
    entry: EntryKind,
    id: &str,
    path: &str,
    sha256: &str,
) -> Result<OpResult, Stop> {
    let listed = match entry {
        EntryKind::Note => manifest
            .notes
            .get(id)
            .map(|e| (e.path.as_str(), Some(e.sha256.as_str()))),
        EntryKind::File => manifest
            .files
            .get(id)
            .map(|e| (e.path.as_str(), e.sha256.as_deref())),
    };
    if listed != Some((path, Some(sha256))) {
        return Err(Stop::code("E_MIRROR_STALE"));
    }
    let (found, state) = look(root, path);
    match state {
        Some(state) if state == sha256 => {
            if let Some(at) = found {
                atomic_file::checked();
                at.folder
                    .remove_file(at.name)
                    .map_err(|e| Stop::code(io_code(&e, root)))?;
                prune(root, path);
            }
        }
        Some(state) if state != DIR && state != OTHER => {
            return Err(Stop::at("E_MIRROR_CHANGED", path, Some(state)));
        }
        _ => {}
    }
    drop_entry(manifest, entry, id);
    Ok(OpResult::default())
}

#[allow(clippy::too_many_arguments)]
fn note(
    root: &Root,
    manifest: &mut Manifest,
    id: &str,
    path: &str,
    from: Option<&str>,
    sha256: &str,
    text: Option<&str>,
    next: impl Fn(u64) -> NoteEntry,
) -> Result<OpResult, Stop> {
    if let Some(text) = text
        && sha256_hex(text.as_bytes()) != sha256
    {
        return Err(Stop::code("E_MIRROR_HASH_MISMATCH"));
    }
    let entry = manifest.notes.get(id).cloned();
    // Its file now, if it still has one; it must hold what Devot wrote (or
    // already what it is about to write), so it was found.
    let mut alive: Option<(At, String)> = None;
    if let Some(from) = from {
        let Some(entry) = entry.as_ref().filter(|e| e.path == from) else {
            return Err(Stop::code("E_MIRROR_STALE"));
        };
        let (found, state) = look(root, from);
        if let Some(state) = state {
            if state != entry.sha256 && state != sha256 {
                return Err(Stop::at("E_MIRROR_CHANGED", from, Some(state)));
            }
            alive = found.map(|at| (at, state));
        }
    } else if let Some(entry) = &entry {
        // The plan says its old file is gone: it must be.
        if let Some(state) = disk_state(root, &entry.path) {
            return Err(Stop::at("E_MIRROR_CHANGED", &entry.path, Some(state)));
        }
    }
    let mut record = |size: u64| {
        manifest.notes.insert(id.to_owned(), next(size));
        OpResult::sized(size)
    };
    if let Some((at, state)) = &alive
        && at.rel == path
    {
        if state == sha256 {
            return Ok(record(file_size(at)));
        }
        let Some(text) = text else {
            return Err(Stop::at("E_MIRROR_CHANGED", path, Some(state.clone())));
        };
        atomic_file::checked();
        rewrite(root, at, text.as_bytes())?;
        return Ok(record(text.len() as u64));
    }
    // A new place: nothing that is not Devot's may be there, unless it is
    // its own file under another case, or exactly what Devot would write.
    in_the_way(root, path)?;
    let (found, target) = look(root, path);
    let renamed = target.is_some()
        && alive
            .as_ref()
            .zip(found.as_ref())
            .is_some_and(|((from, _), to)| same_file(from, to));
    let mut adopt = false;
    if let Some(state) = &target
        && !renamed
    {
        if state != sha256 {
            return Err(Stop::at("E_MIRROR_EXISTS", path, target));
        }
        adopt = true;
    }
    // Without the text, only a file that holds it already can go there:
    // checked before anything on disk changes.
    let holds_it = adopt || alive.as_ref().is_some_and(|(_, state)| state == sha256);
    if text.is_none() && !holds_it {
        let state = alive.as_ref().map(|(_, state)| state.clone());
        return Err(Stop::at("E_MIRROR_CHANGED", from.unwrap_or(path), state));
    }
    let to = make_folders(root, path)?;
    atomic_file::checked();
    if adopt {
        if let Some((from, _)) = alive {
            from.folder
                .remove_file(from.name)
                .map_err(|e| Stop::code(io_code(&e, root)))?;
            prune(root, from.rel);
        }
        return Ok(record(file_size(&to)));
    }
    let Some((from, state)) = alive else {
        let Some(text) = text else {
            return Err(Stop::at("E_MIRROR_CHANGED", path, None));
        };
        write_new(root, &to, text.as_bytes())?;
        return Ok(record(text.len() as u64));
    };
    move_file(root, &from, &to, renamed)?;
    prune(root, from.rel);
    if state == sha256 {
        return Ok(record(file_size(&to)));
    }
    let Some(text) = text else {
        return Err(Stop::at("E_MIRROR_CHANGED", path, None));
    };
    rewrite(root, &to, text.as_bytes())?;
    Ok(record(text.len() as u64))
}

fn file(
    root: &Root,
    manifest: &mut Manifest,
    id: &str,
    path: &str,
    copy: bool,
    load: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
) -> Result<OpResult, Stop> {
    if let Some(entry) = manifest.files.get(id)
        && let Some(sha256) = &entry.sha256
        && disk_state(root, &entry.path).as_deref() == Some(sha256)
    {
        return Err(Stop::code("E_MIRROR_STALE"));
    }
    if !copy {
        manifest.files.insert(
            id.to_owned(),
            FileEntry {
                path: path.to_owned(),
                sha256: None,
                size: 0,
            },
        );
        return Ok(OpResult {
            size: Some(0),
            sha256: Some(None),
            ..OpResult::default()
        });
    }
    let data = load(id).ok_or_else(|| Stop::code("E_FILE_NOT_FOUND"))?;
    let sha256 = sha256_hex(&data);
    in_the_way(root, path)?;
    let target = disk_state(root, path);
    match &target {
        Some(state) if *state != sha256 => {
            return Err(Stop::at("E_MIRROR_EXISTS", path, target));
        }
        Some(_) => {}
        None => {
            let at = make_folders(root, path)?;
            atomic_file::checked();
            write_new(root, &at, &data)?;
        }
    }
    let size = data.len() as u64;
    manifest.files.insert(
        id.to_owned(),
        FileEntry {
            path: path.to_owned(),
            sha256: Some(sha256.clone()),
            size,
        },
    );
    Ok(OpResult {
        size: Some(size),
        sha256: Some(Some(sha256)),
        ..OpResult::default()
    })
}

/// The manifest's bytes, as they are in the folder: `InvalidData` when its
/// name holds anything but a plain file (a link there is not followed).
pub fn read_manifest(root: &Root) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    root.folder.read_file(MANIFEST)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn save_manifest(root: &Root, manifest: &Manifest) -> std::io::Result<()> {
    root.folder
        .write(MANIFEST, &manifest_bytes(manifest), Place::Replace)
}

/// has none: `AlreadyExists` when one appeared meanwhile, which stays.
pub fn create_manifest(root: &Root, manifest: &Manifest) -> std::io::Result<()> {
    root.folder
        .write(MANIFEST, &manifest_bytes(manifest), Place::New)
}

#[cfg(test)]
mod tests;
