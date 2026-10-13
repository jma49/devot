//! Markdown folder import (File > Import > Markdown Folder…). Rust picks
//! the folder, lists its Markdown files and reads them; the core worker
//! turns them into notebooks and notes (`src/core/import.ts`).
//!
//! The web view never names a folder: the user picks it in a native panel
//! and Rust keeps it as an import session. The UI asks for files by session
//! ID and a path relative to the folder, and Rust only reads files inside
//! it: hidden files and folders are skipped, the scan never walks symbolic
//! links (an image may be reached through one, but only to a visible file
//! inside the folder), and files over 10 MB are left out. Images are stored
//! as attachments straight from disk, so their bytes never cross IPC.

use crate::commands::files::{MAX_FILE_BYTES, Upload, store_upload};
use crate::commands::notes::valid_note_id;
use crate::storage::Db;
use crate::strings;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Markdown files and images share the attachments' size cap.
pub const MAX_NOTE_BYTES: u64 = MAX_FILE_BYTES as u64;
/// Markdown files one import takes; a larger folder is refused.
pub const MAX_FILES: usize = 10_000;
/// Directory entries one scan looks at, so picking a huge folder fails fast.
pub const MAX_ENTRIES: usize = 200_000;
/// Folder nesting one scan follows.
pub const MAX_DEPTH: usize = 64;
const MAX_PATH_BYTES: usize = 4096;
const MAX_NAME_CHARS: usize = 200;

pub const READY_EVENT: &str = "devot://import-ready";
pub const FAILED_EVENT: &str = "devot://import-failed";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub path: String,
    pub code: &'static str,
}

/// What a scan found: Markdown files (relative, `/`-separated, sorted) and
/// the files it left out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub root: PathBuf,
    pub name: String,
    pub files: Vec<String>,
    pub skipped: Vec<Problem>,
}

/// A scan as the UI sees it (no absolute paths).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Scan {
    pub id: u64,
    pub name: String,
    pub files: Vec<String>,
    pub skipped: Vec<Problem>,
}

fn is_markdown(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_owned()
    } else {
        format!("{rel}/{name}")
    }
}

/// How much one scan takes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Markdown files; more and the folder is refused.
    pub files: usize,
    /// Directory entries looked at; more and the folder is refused.
    pub entries: usize,
    /// Folder nesting followed; deeper folders are left out.
    pub depth: usize,
}

impl Limits {
    pub const DEFAULT: Limits = Limits {
        files: MAX_FILES,
        entries: MAX_ENTRIES,
        depth: MAX_DEPTH,
    };
}

/// Lists the Markdown files under `root`.
pub fn scan(root: &Path) -> Result<Found, &'static str> {
    scan_with(root, Limits::DEFAULT)
}

/// Lists the Markdown files under `root`, within `limits`.
pub fn scan_with(root: &Path, limits: Limits) -> Result<Found, &'static str> {
    let root = std::fs::canonicalize(root).map_err(|_| "E_IMPORT_ROOT_INVALID")?;
    if !root.is_dir() {
        return Err("E_IMPORT_ROOT_INVALID");
    }
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("E_IMPORT_ROOT_INVALID")?
        .to_owned();
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut entries = 0usize;
    let mut stack = vec![(root.clone(), String::new(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(list) = std::fs::read_dir(&dir).map(|l| {
            // Sorted, so the same folder always gives the same result.
            let mut list: Vec<_> = l.flatten().collect();
            list.sort_by_key(|e| e.file_name());
            list
        }) else {
            skipped.push(Problem {
                path: rel,
                code: "E_IMPORT_UNREADABLE",
            });
            continue;
        };
        for entry in list {
            entries += 1;
            if entries > limits.entries {
                return Err("E_IMPORT_FOLDER_TOO_LARGE");
            }
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                skipped.push(Problem {
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
                skipped.push(Problem {
                    path: child,
                    code: "E_IMPORT_UNREADABLE",
                });
                continue;
            };
            if kind.is_symlink() {
                if let Some(code) = link_problem(&root, &entry.path(), name) {
                    skipped.push(Problem { path: child, code });
                }
            } else if kind.is_dir() {
                if depth + 1 > limits.depth {
                    skipped.push(Problem {
                        path: child,
                        code: "E_IMPORT_TOO_DEEP",
                    });
                } else {
                    stack.push((entry.path(), child, depth + 1));
                }
            } else if kind.is_file() && is_markdown(name) {
                match entry.metadata() {
                    Ok(meta) if meta.len() > MAX_NOTE_BYTES => skipped.push(Problem {
                        path: child,
                        code: "E_IMPORT_FILE_TOO_LARGE",
                    }),
                    Ok(_) => {
                        files.push(child);
                        if files.len() > limits.files {
                            return Err("E_IMPORT_TOO_MANY_FILES");
                        }
                    }
                    Err(_) => skipped.push(Problem {
                        path: child,
                        code: "E_IMPORT_UNREADABLE",
                    }),
                }
            }
        }
    }
    files.sort();
    skipped.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Found {
        root,
        name,
        files,
        skipped,
    })
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

/// A file inside `root` named by a relative path: only plain, visible path
/// components, and the resolved file (links followed) must be inside `root`
/// and not hidden there either.
pub fn resolve(root: &Path, rel: &str) -> Result<(PathBuf, u64), &'static str> {
    if rel.is_empty() || rel.len() > MAX_PATH_BYTES || rel.contains(['\0', '\\']) {
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

/// Reads at most `max` bytes; more means the file grew past the cap.
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

/// A Markdown file's text, without a UTF-8 byte order mark.
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

/// An image file to attach, within the attachments' size cap; its name is
/// the file name. Storing it checks it like any upload (`store_upload`).
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
    root: PathBuf,
    files: HashSet<String>,
}

/// Import sessions: the folders the user picked, by ID.
#[derive(Default)]
pub struct Imports {
    next: AtomicU64,
    sessions: Mutex<HashMap<u64, Session>>,
}

impl Imports {
    /// Starts a session for a scanned folder.
    pub fn start(&self, found: Found) -> Scan {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let session = Session {
            root: found.root,
            files: found.files.iter().cloned().collect(),
        };
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(id, session);
        }
        Scan {
            id,
            name: found.name,
            files: found.files,
            skipped: found.skipped,
        }
    }

    /// The session's folder, if `rel` may be read as a note (`note`) or an image.
    fn root_for(&self, id: u64, rel: &str, note: bool) -> Result<PathBuf, &'static str> {
        let sessions = self.sessions.lock().map_err(|_| "E_IMPORT_SESSION")?;
        let session = sessions.get(&id).ok_or("E_IMPORT_SESSION")?;
        if note && !session.files.contains(rel) {
            return Err("E_IMPORT_PATH_UNKNOWN");
        }
        Ok(session.root.clone())
    }

    pub fn finish(&self, id: u64) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&id);
        }
    }
}

/// Runs file reads off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "E_IMPORT_FAILED".to_string())?
        .map_err(String::from)
}

/// A Markdown file of the session's folder.
#[tauri::command]
pub async fn import_read(
    imports: State<'_, Imports>,
    id: u64,
    path: String,
) -> Result<String, String> {
    let root = imports.root_for(id, &path, true)?;
    blocking(move || read_note(&root, &path)).await
}

/// Stores an image of the session's folder as an attachment of a note,
/// with the same checks as a pasted image.
#[tauri::command]
pub async fn import_attach(
    imports: State<'_, Imports>,
    db: State<'_, Db>,
    id: u64,
    path: String,
    file_id: String,
    note_id: String,
) -> Result<(), String> {
    // Checked again when stored; here so a bad call reads nothing.
    if !valid_note_id(&file_id) {
        return Err("E_FILE_ID_INVALID".into());
    }
    if !valid_note_id(&note_id) {
        return Err("E_NOTE_ID_INVALID".into());
    }
    let root = imports.root_for(id, &path, false)?;
    let image = blocking(move || read_image(&root, &path)).await?;
    let upload = Upload {
        id: file_id,
        note_id,
        name: image.name,
    };
    store_upload(&db, upload, image.data).await
}

/// Ends a session; its folder can no longer be read.
#[tauri::command]
pub fn import_finish(imports: State<'_, Imports>, id: u64) {
    imports.finish(id);
}

/// Asks for a folder, scans it off the main thread and hands the result to
/// the main window, which runs the import.
pub fn pick(app: &AppHandle) {
    let mut dialog = app
        .dialog()
        .file()
        .set_title(strings::IMPORT_MARKDOWN_TITLE);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let app = app.clone();
    dialog.pick_folder(move |folder| {
        let Some(folder) = folder else { return };
        let fail = |app: &AppHandle, code: &'static str| {
            log::warn!("W_IMPORT_FAILED {code}");
            if app.emit_to("main", FAILED_EVENT, code).is_err() {
                log::warn!("W_IMPORT_EVENT_FAILED");
            }
        };
        let Ok(path) = folder.into_path() else {
            fail(&app, "E_IMPORT_ROOT_INVALID");
            return;
        };
        let spawned = std::thread::Builder::new()
            .name("devot-import-scan".into())
            .spawn(move || match scan(&path) {
                Ok(found) => {
                    let scan = app.state::<Imports>().start(found);
                    log::info!(
                        "I_IMPORT_SCANNED {} files={} skipped={}",
                        scan.id,
                        scan.files.len(),
                        scan.skipped.len()
                    );
                    if app.emit_to("main", READY_EVENT, scan).is_err() {
                        log::warn!("W_IMPORT_EVENT_FAILED");
                    }
                }
                Err(code) => fail(&app, code),
            });
        if spawned.is_err() {
            log::warn!("W_IMPORT_THREAD_FAILED");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

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
            found.files,
            [
                "Inbox.md",
                "Projects/Deep/Spec.MD",
                "Projects/Plan.markdown"
            ]
        );
        assert!(found.skipped.is_empty());
        assert_eq!(found.root, fs::canonicalize(dir.path()).unwrap());
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
        let found = scan(dir.path()).unwrap();
        assert!(found.files.contains(&"Exact.md".to_string()));
        assert!(!found.files.contains(&"Big.md".to_string()));
        assert_eq!(
            found.skipped,
            [Problem {
                path: "Big.md".into(),
                code: "E_IMPORT_FILE_TOO_LARGE"
            }]
        );
    }

    /// A folder holding `n` empty Markdown files.
    fn notes(n: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..n {
            fs::File::create(dir.path().join(format!("{i:05}.md"))).unwrap();
        }
        dir
    }

    /// A chain of `n` nested folders `d/d/…`, with a note in the deepest.
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
        assert_eq!(scan(dir.path()).unwrap().files, [format!("{rel}/deep.md")]);
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
        // Every entry counts, hidden ones and folders too.
        let dir = notes(3);
        write(dir.path(), ".hidden", b"");
        write(dir.path(), "Sub/a.txt", b"");
        // Root: four files and Sub; Sub: one file.
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
            found.files,
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
        let root = &found.root;
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
            "a\\b.md",
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
        let scan = imports.start(scan(dir.path()).unwrap());
        assert_eq!(scan.id, 1);
        assert_eq!(scan.files.len(), 3);
        assert!(imports.root_for(scan.id, "Inbox.md", true).is_ok());
        assert_eq!(
            imports.root_for(scan.id, "notes.txt", true),
            Err("E_IMPORT_PATH_UNKNOWN")
        );
        // Images are any file inside the folder; `resolve` checks the rest.
        assert!(
            imports
                .root_for(scan.id, "Projects/img/board.png", false)
                .is_ok()
        );
        assert_eq!(
            imports.root_for(scan.id + 1, "Inbox.md", true),
            Err("E_IMPORT_SESSION")
        );
        let second = imports.start(super::scan(dir.path()).unwrap());
        assert_eq!(second.id, 2);
        imports.finish(scan.id);
        assert_eq!(
            imports.root_for(scan.id, "Inbox.md", true),
            Err("E_IMPORT_SESSION")
        );
        assert!(imports.root_for(second.id, "Inbox.md", true).is_ok());
    }
}
