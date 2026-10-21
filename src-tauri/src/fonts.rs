//! The editor's own fonts (Settings > Editor > Font Family): a font installed on this Mac, or a
//! font file the user imported. An import is checked here (type from the name and first bytes,
//! size) and copied into `<app data>/fonts/`, so it keeps working when the original moves. The main
//! window reads the bytes back (`font_read`) and loads them as a font face, so the web view never
//! names a path. A file that is gone or no longer valid is refused and the window falls back to the
//! default font.

use crate::atomic_file::{Folder, Place};
use serde::Serialize;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

pub const DIR: &str = "fonts";
/// A CJK font with every weight in one file still fits.
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
const STEM_MAX: usize = 64;
const NAME_TRIES: u32 = 100;
const FAMILY_MAX: usize = 128;
const EXTENSIONS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

const INVALID: &str = "E_FONT_INVALID";
const TOO_LARGE: &str = "E_FONT_TOO_LARGE";
const MISSING: &str = "E_FONT_MISSING";
const FAILED: &str = "E_FONT_FAILED";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FontFile {
    pub id: String,
    pub name: String,
}

pub struct Fonts {
    dir: PathBuf,
}

impl Fonts {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join(DIR),
        }
    }

    fn folder(&self) -> Result<Folder, &'static str> {
        Folder::open(&self.dir).map_err(|_| MISSING)
    }

    pub fn import(&self, path: &Path) -> Result<FontFile, &'static str> {
        let file_name = path.file_name().and_then(OsStr::to_str).ok_or(INVALID)?;
        let id = stored_name(file_name).ok_or(INVALID)?;
        let bytes = read_limited(std::fs::File::open(path).map_err(|_| INVALID)?)?;
        check_bytes(&id, &bytes)?;
        std::fs::create_dir_all(&self.dir).map_err(|_| FAILED)?;
        let folder = self.folder()?;
        // A stored font is never replaced: a window may have it loaded, and
        // only a new name makes it load the new one. The same file again
        // keeps its name.
        for n in 1..=NAME_TRIES {
            let id = numbered(&id, n);
            match folder.write(&id, &bytes, Place::New) {
                Ok(()) => return Ok(entry(id)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if self.read(&id).is_ok_and(|stored| stored == bytes) {
                        return Ok(entry(id));
                    }
                }
                Err(_) => return Err(FAILED),
            }
        }
        Err(FAILED)
    }

    pub fn list(&self) -> Vec<FontFile> {
        let Ok(folder) = self.folder() else {
            return Vec::new();
        };
        let mut out: Vec<FontFile> = folder
            .names()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|name| name.into_string().ok())
            .filter(|name| valid_id(name))
            .map(entry)
            .collect();
        out.sort_by_cached_key(|f| f.name.to_lowercase());
        out
    }

    /// Checked again: the file may have been replaced since it was imported.
    pub fn read(&self, id: &str) -> Result<Vec<u8>, &'static str> {
        if !valid_id(id) {
            return Err(INVALID);
        }
        let file = self.folder()?.read_file(id).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => MISSING,
            _ => INVALID,
        })?;
        let bytes = read_limited(file)?;
        check_bytes(id, &bytes)?;
        Ok(bytes)
    }
}

fn entry(id: String) -> FontFile {
    let name = id.rsplit_once('.').map_or(id.as_str(), |(stem, _)| stem);
    FontFile {
        name: name.to_string(),
        id,
    }
}

/// A file longer than `MAX_BYTES` is refused.
fn read_limited(file: std::fs::File) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| INVALID)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(TOO_LARGE);
    }
    Ok(bytes)
}

fn extension(name: &str) -> Option<&str> {
    let (_, ext) = name.rsplit_once('.')?;
    EXTENSIONS.into_iter().find(|e| *e == ext)
}

/// The same check runs in the web view (src/core/editorSettings.ts).
pub fn valid_id(id: &str) -> bool {
    let Some((stem, _)) = id.rsplit_once('.') else {
        return false;
    };
    extension(id).is_some()
        && !stem.is_empty()
        && stem.chars().count() <= STEM_MAX
        && !stem.starts_with(' ')
        && stem
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '_')
}

/// It keeps quotes and backslashes out of the CSS font list the name goes into. The same check runs
/// in the web view (src/core/editorSettings.ts).
pub fn valid_family_name(name: &str) -> bool {
    let allowed = |c: char| c.is_alphanumeric() || " -_.&+()".contains(c);
    !name.is_empty()
        && name.chars().count() <= FAMILY_MAX
        && !name.starts_with([' ', '.'])
        && name.chars().all(allowed)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn family_list(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = names.into_iter().filter(|n| valid_family_name(n)).collect();
    out.sort_by_cached_key(|n| n.to_lowercase());
    out.dedup();
    out
}

fn stored_name(file_name: &str) -> Option<String> {
    let (stem, ext) = file_name.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    EXTENSIONS.contains(&ext.as_str()).then_some(())?;
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(STEM_MAX)
        .collect();
    let stem = stem.trim_start();
    let id = format!("{stem}.{ext}");
    valid_id(&id).then_some(id)
}

fn numbered(id: &str, n: u32) -> String {
    if n == 1 {
        return id.to_string();
    }
    let (stem, ext) = id.rsplit_once('.').unwrap_or((id, ""));
    let suffix = format!(" {n}");
    let stem: String = stem.chars().take(STEM_MAX - suffix.len()).collect();
    format!("{stem}{suffix}.{ext}")
}

/// An OpenType or TrueType font for `.ttf` and `.otf` (either outline kind, as files are often
/// named for the other), WOFF or WOFF2.
fn check_bytes(id: &str, bytes: &[u8]) -> Result<(), &'static str> {
    let head = bytes.get(..4).ok_or(INVALID)?;
    let sfnt = matches!(head, [0, 1, 0, 0] | b"OTTO" | b"true");
    let ok = match extension(id) {
        Some("ttf" | "otf") => sfnt,
        Some("woff") => head == b"wOFF",
        Some("woff2") => head == b"wOF2",
        _ => false,
    };
    if ok { Ok(()) } else { Err(INVALID) }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| FAILED.to_string())?
        .map_err(String::from)
}

#[tauri::command]
pub async fn font_import(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<FontFile>, String> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    let dialog = app
        .dialog()
        .file()
        .set_title(crate::strings::FONT_IMPORT_TITLE);
    #[cfg(desktop)]
    let dialog = dialog.set_parent(&window);
    #[cfg(mobile)]
    drop(window);
    dialog
        .add_filter(crate::strings::FONT_FILTER, &EXTENSIONS)
        .pick_file(move |path| {
            let _ = reply.send(path.map(|p| p.into_path()));
        });
    let picked = match answer.await {
        Ok(None) => return Ok(None),
        Ok(Some(Ok(path))) => path,
        _ => return Err(INVALID.into()),
    };
    let dir = app.path().app_data_dir().map_err(|_| FAILED.to_string())?;
    blocking(move || Fonts::new(&dir).import(&picked).map(Some)).await
}

/// AppKit is read on the main thread.
#[tauri::command]
pub async fn fonts_installed(app: AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let (reply, answer) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = reply.send(crate::native::macos::font_families());
        })
        .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        let names = answer.await.map_err(|_| FAILED.to_string())?;
        Ok(family_list(names))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn fonts_list(fonts: State<'_, std::sync::Arc<Fonts>>) -> Result<Vec<FontFile>, String> {
    let fonts = std::sync::Arc::clone(&fonts);
    blocking(move || Ok(fonts.list())).await
}

#[tauri::command]
pub async fn font_read(
    fonts: State<'_, std::sync::Arc<Fonts>>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let fonts = std::sync::Arc::clone(&fonts);
    blocking(move || fonts.read(&id).map(tauri::ipc::Response::new)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTF: &[u8] = &[0, 1, 0, 0, 0, 9, 0, 0];

    fn file(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn imports_a_font_into_the_fonts_folder_and_lists_it() {
        let data = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let fonts = Fonts::new(data.path());
        let font = fonts.import(&file(&picked, "Fira Code.TTF", TTF)).unwrap();
        assert_eq!(font.id, "Fira Code.ttf");
        assert_eq!(font.name, "Fira Code");
        assert_eq!(fonts.list(), vec![font]);
        assert_eq!(fonts.read("Fira Code.ttf").unwrap(), TTF);
    }

    #[test]
    fn a_new_file_under_a_taken_name_gets_a_new_name_and_the_same_file_keeps_it() {
        let data = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let fonts = Fonts::new(data.path());
        let first = fonts.import(&file(&picked, "Mono.ttf", TTF)).unwrap();
        assert_eq!(
            fonts.import(&file(&picked, "Mono.ttf", TTF)).unwrap(),
            first
        );
        let changed = [TTF, b"v2"].concat();
        let second = fonts.import(&file(&picked, "Mono.ttf", &changed)).unwrap();
        assert_eq!(second.id, "Mono 2.ttf");
        assert_eq!(fonts.read("Mono.ttf").unwrap(), TTF);
        assert_eq!(fonts.read("Mono 2.ttf").unwrap(), changed);
        let long = format!("{}.otf", "x".repeat(STEM_MAX));
        assert!(valid_id(&numbered(&long, 12)));
    }

    #[test]
    fn accepts_each_font_kind_by_its_signature() {
        let data = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let fonts = Fonts::new(data.path());
        for (name, head) in [
            ("a.otf", &b"OTTO"[..]),
            ("b.otf", &[0, 1, 0, 0][..]),
            ("c.ttf", &b"true"[..]),
            ("d.woff", &b"wOFF"[..]),
            ("e.woff2", &b"wOF2"[..]),
        ] {
            let bytes = [head, &[0; 8]].concat();
            assert!(fonts.import(&file(&picked, name, &bytes)).is_ok(), "{name}");
        }
    }

    #[test]
    fn refuses_files_that_are_not_fonts() {
        let data = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let fonts = Fonts::new(data.path());
        for (name, bytes) in [
            ("note.txt", TTF),
            ("fake.ttf", &b"<html>"[..]),
            ("woff.woff2", &b"wOFF0000"[..]),
            ("short.ttf", &[0, 1][..]),
            ("noext", TTF),
        ] {
            assert_eq!(
                fonts.import(&file(&picked, name, bytes)),
                Err(INVALID),
                "{name}"
            );
        }
        assert!(fonts.list().is_empty());
    }

    #[test]
    fn refuses_a_file_over_the_size_limit() {
        let data = tempfile::tempdir().unwrap();
        let picked = tempfile::tempdir().unwrap();
        let mut big = TTF.to_vec();
        big.resize(MAX_BYTES as usize + 1, 0);
        let fonts = Fonts::new(data.path());
        assert_eq!(
            fonts.import(&file(&picked, "big.ttf", &big)),
            Err(TOO_LARGE)
        );
    }

    #[test]
    fn stores_odd_names_under_a_safe_one() {
        assert_eq!(
            stored_name("my font!.woff2").as_deref(),
            Some("my font_.woff2")
        );
        assert_eq!(
            stored_name("\u{9716}\u{9e5c}\u{6587}\u{6977}.ttf").as_deref(),
            Some("\u{9716}\u{9e5c}\u{6587}\u{6977}.ttf")
        );
        assert_eq!(
            stored_name("../../etc.ttf").as_deref(),
            Some("______etc.ttf")
        );
        assert_eq!(stored_name(".ttf"), None);
        assert_eq!(stored_name("a.exe"), None);
        assert_eq!(
            stored_name(&format!("{}.otf", "x".repeat(100)))
                .unwrap()
                .len(),
            68
        );
    }

    #[test]
    fn reading_refuses_bad_ids_missing_and_replaced_files() {
        let data = tempfile::tempdir().unwrap();
        let fonts = Fonts::new(data.path());
        assert_eq!(fonts.read("../editor-settings.json"), Err(INVALID));
        assert_eq!(fonts.read("gone.ttf"), Err(MISSING));
        std::fs::create_dir_all(data.path().join(DIR)).unwrap();
        assert_eq!(fonts.read("gone.ttf"), Err(MISSING));
        std::fs::write(data.path().join(DIR).join("bad.ttf"), b"not a font").unwrap();
        assert_eq!(fonts.read("bad.ttf"), Err(INVALID));
    }

    #[test]
    fn family_names_keep_css_breaking_characters_out() {
        for ok in [
            "SF Mono",
            "Fira Code",
            "Iosevka Term SS04",
            "PT Mono",
            "Source Han Sans (TW)",
        ] {
            assert!(valid_family_name(ok), "{ok}");
        }
        assert!(valid_family_name("\u{82f9}\u{65b9}-\u{7b80}"));
        for bad in [
            "",
            ".AppleSystemUIFont",
            " Lead",
            "A\"B",
            "A\\B",
            "A;B",
            "A'B",
            "a{b}",
        ] {
            assert!(!valid_family_name(bad), "{bad}");
        }
        assert!(!valid_family_name(&"x".repeat(FAMILY_MAX + 1)));
    }

    #[test]
    fn family_list_is_sorted_unique_and_valid() {
        let names = ["menlo", "Courier", ".Hidden", "Menlo", "Courier"].map(String::from);
        assert_eq!(family_list(names), ["Courier", "menlo", "Menlo"]);
    }

    #[test]
    fn listing_skips_names_that_are_not_fonts() {
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().join(DIR);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["b.otf", "A.ttf", "readme.txt", ".hidden.ttf"] {
            std::fs::write(dir.join(name), TTF).unwrap();
        }
        let names: Vec<_> = Fonts::new(data.path())
            .list()
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert_eq!(names, ["A.ttf", "b.otf"]);
    }
}
