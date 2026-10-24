//! Reading a plugin package (ADR 0005): a folder the user picked, or a `.zip` archive of one, read whole into memory and checked
//! before anything is written. Hidden files (`.DS_Store`) and an archive's `__MACOSX` folder are left out; a link, a name outside
//! the rules or a package over its limits refuses the whole package.

use super::manifest::{self, Manifest};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

pub const MAX_FILES: usize = 256;
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
/// Entries an archive may list, folders included, before it is not read at all.
const MAX_ARCHIVE_ENTRIES: usize = 4096;

const INVALID: &str = "E_PLUGIN_PACKAGE_INVALID";
const LINK: &str = "E_PLUGIN_PACKAGE_LINK";
const TOO_LARGE: &str = "E_PLUGIN_PACKAGE_TOO_LARGE";
const UNREADABLE: &str = "E_PLUGIN_PACKAGE_UNREADABLE";
const NO_MANIFEST: &str = "E_PLUGIN_MANIFEST_MISSING";
const NO_MAIN: &str = "E_PLUGIN_MAIN_MISSING";

#[derive(Debug, Clone)]
pub struct Package {
    pub manifest: Manifest,
    /// By path in the package, `/` between parts.
    pub files: BTreeMap<String, Vec<u8>>,
}

#[derive(Default)]
struct Files {
    files: BTreeMap<String, Vec<u8>>,
    total: u64,
}

impl Files {
    fn add(&mut self, path: String, from: impl Read) -> Result<(), &'static str> {
        if !manifest::is_package_path(&path) {
            return Err(INVALID);
        }
        if self.files.len() >= MAX_FILES {
            return Err(TOO_LARGE);
        }
        let mut bytes = Vec::new();
        from.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| UNREADABLE)?;
        let len = bytes.len() as u64;
        self.total += len;
        if len > MAX_FILE_BYTES || self.total > MAX_TOTAL_BYTES {
            return Err(TOO_LARGE);
        }
        if self.files.insert(path, bytes).is_some() {
            return Err(INVALID);
        }
        Ok(())
    }

    fn finish(self) -> Result<Package, &'static str> {
        let manifest = manifest::parse_bytes(self.files.get(manifest::FILE).ok_or(NO_MANIFEST)?)?;
        if !self.files.contains_key(&manifest.main) {
            return Err(NO_MAIN);
        }
        Ok(Package {
            manifest,
            files: self.files,
        })
    }
}

fn hidden(name: &str) -> bool {
    name.starts_with('.')
}

pub fn read_folder(root: &Path) -> Result<Package, &'static str> {
    let meta = std::fs::metadata(root).map_err(|_| UNREADABLE)?;
    if !meta.is_dir() {
        return Err(INVALID);
    }
    let mut files = Files::default();
    walk(root, "", 1, &mut files)?;
    files.finish()
}

fn walk(dir: &Path, prefix: &str, depth: usize, files: &mut Files) -> Result<(), &'static str> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|_| UNREADABLE)?
        .collect::<Result<_, _>>()
        .map_err(|_| UNREADABLE)?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().into_string().map_err(|_| INVALID)?;
        if hidden(&name) {
            continue;
        }
        let kind = entry.file_type().map_err(|_| UNREADABLE)?;
        let path = format!("{prefix}{name}");
        if kind.is_symlink() {
            return Err(LINK);
        } else if kind.is_dir() {
            if depth >= manifest::DEPTH_MAX {
                return Err(INVALID);
            }
            walk(&entry.path(), &format!("{path}/"), depth + 1, files)?;
        } else if kind.is_file() {
            let file = std::fs::File::open(entry.path()).map_err(|_| UNREADABLE)?;
            files.add(path, file)?;
        } else {
            return Err(INVALID);
        }
    }
    Ok(())
}

pub fn read_archive(path: &Path) -> Result<Package, &'static str> {
    let file = std::fs::File::open(path).map_err(|_| UNREADABLE)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| INVALID)?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(TOO_LARGE);
    }
    let mut names = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|_| INVALID)?;
        if entry.encrypted() {
            return Err(INVALID);
        }
        if entry.is_symlink() {
            return Err(LINK);
        }
        let name = entry.name().map_err(|_| INVALID)?.to_string();
        if name.starts_with('/') || name.contains('\\') || name.split('/').any(|p| p == "..") {
            return Err(INVALID);
        }
        names.push((name, entry.is_dir()));
    }
    let shown =
        |name: &str| !name.split('/').any(hidden) && name.split('/').next() != Some("__MACOSX");
    let files_only: Vec<&str> = names
        .iter()
        .filter(|(name, dir)| !dir && shown(name))
        .map(|(name, _)| name.as_str())
        .collect();
    // The folder itself zipped (Compress in the Finder): its one top folder is the package.
    let root = if files_only.contains(&manifest::FILE) {
        String::new()
    } else {
        let top = files_only
            .first()
            .and_then(|n| n.split_once('/'))
            .map(|(top, _)| format!("{top}/"))
            .ok_or(NO_MANIFEST)?;
        if !files_only.iter().all(|n| n.starts_with(&top)) {
            return Err(NO_MANIFEST);
        }
        top
    };
    let mut files = Files::default();
    for (i, (name, dir)) in names.iter().enumerate() {
        if *dir || !shown(name) {
            continue;
        }
        let path = name.strip_prefix(&root).ok_or(INVALID)?.to_string();
        let entry = archive.by_index(i).map_err(|_| UNREADABLE)?;
        files.add(path, entry)?;
    }
    files.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    pub const MANIFEST: &str = r#"{"id":"com.example.hello","name":"Hello","version":"1.0.0","apiVersion":1,"main":"main.js","permissions":["commands"],"contributes":{"commands":[{"id":"hi","title":"Say Hi"}]}}"#;

    fn folder(files: &[(&str, &[u8])]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, bytes) in files {
            let path = dir.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        dir
    }

    fn archive(entries: &[(&str, &[u8])]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            if name.ends_with('/') {
                zip.add_directory(*name, options).unwrap();
            } else {
                zip.start_file(*name, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
        }
        zip.finish().unwrap();
        (dir, path)
    }

    #[test]
    fn reads_a_folder_leaving_hidden_files_out() {
        let dir = folder(&[
            (manifest::FILE, MANIFEST.as_bytes()),
            ("main.js", b"devot"),
            ("lib/util.js", b"x"),
            (".DS_Store", b"x"),
            (".git/config", b"x"),
        ]);
        let package = read_folder(dir.path()).unwrap();
        assert_eq!(package.manifest.id, "com.example.hello");
        assert_eq!(
            package.files.keys().collect::<Vec<_>>(),
            [manifest::FILE, "lib/util.js", "main.js"]
        );
    }

    #[test]
    fn refuses_a_folder_without_its_manifest_or_main_script() {
        let dir = folder(&[("main.js", b"x")]);
        assert_eq!(read_folder(dir.path()).err(), Some(NO_MANIFEST));
        let dir = folder(&[(manifest::FILE, MANIFEST.as_bytes())]);
        assert_eq!(read_folder(dir.path()).err(), Some(NO_MAIN));
        let dir = folder(&[(manifest::FILE, b"{}"), ("main.js", b"x")]);
        assert_eq!(read_folder(dir.path()).err(), Some("E_PLUGIN_ID_INVALID"));
    }

    #[test]
    fn refuses_links_and_names_outside_the_rules() {
        let dir = folder(&[(manifest::FILE, MANIFEST.as_bytes()), ("main.js", b"x")]);
        std::os::unix::fs::symlink("/etc/hosts", dir.path().join("hosts")).unwrap();
        assert_eq!(read_folder(dir.path()).err(), Some(LINK));
        let dir = folder(&[
            (manifest::FILE, MANIFEST.as_bytes()),
            ("main.js", b"x"),
            ("read me.txt", b"x"),
        ]);
        assert_eq!(read_folder(dir.path()).err(), Some(INVALID));
        let dir = folder(&[
            (manifest::FILE, MANIFEST.as_bytes()),
            ("main.js", b"x"),
            ("__devot/runtime.js", b"x"),
        ]);
        assert_eq!(read_folder(dir.path()).err(), Some(INVALID));
    }

    #[test]
    fn refuses_a_package_over_its_limits() {
        let big = vec![b'x'; MAX_FILE_BYTES as usize + 1];
        let dir = folder(&[(manifest::FILE, MANIFEST.as_bytes()), ("main.js", &big)]);
        assert_eq!(read_folder(dir.path()).err(), Some(TOO_LARGE));
        let mut many: Vec<(String, Vec<u8>)> = (0..MAX_FILES)
            .map(|i| (format!("f{i}.js"), Vec::new()))
            .collect();
        many.push((manifest::FILE.into(), MANIFEST.as_bytes().to_vec()));
        many.push(("main.js".into(), Vec::new()));
        let refs: Vec<(&str, &[u8])> = many
            .iter()
            .map(|(p, b)| (p.as_str(), b.as_slice()))
            .collect();
        let dir = folder(&refs);
        assert_eq!(read_folder(dir.path()).err(), Some(TOO_LARGE));
    }

    #[test]
    fn reads_an_archive_at_its_root_or_in_its_one_top_folder() {
        let (_dir, path) = archive(&[(manifest::FILE, MANIFEST.as_bytes()), ("main.js", b"x")]);
        assert_eq!(read_archive(&path).unwrap().files.len(), 2);
        let (_dir, path) = archive(&[
            ("hello/", b""),
            ("hello/devot-plugin.json", MANIFEST.as_bytes()),
            ("hello/main.js", b"x"),
            ("__MACOSX/hello/._main.js", b"x"),
            ("hello/.DS_Store", b"x"),
        ]);
        let package = read_archive(&path).unwrap();
        assert_eq!(
            package.files.keys().collect::<Vec<_>>(),
            [manifest::FILE, "main.js"]
        );
    }

    #[test]
    fn refuses_archive_entries_that_climb_out() {
        let (_dir, path) = archive(&[
            (manifest::FILE, MANIFEST.as_bytes()),
            ("main.js", b"x"),
            ("a/../../evil.js", b"x"),
        ]);
        assert_eq!(read_archive(&path).err(), Some(INVALID));
        let (_dir, path) = archive(&[
            ("a/devot-plugin.json", MANIFEST.as_bytes()),
            ("b/main.js", b"x"),
        ]);
        assert_eq!(read_archive(&path).err(), Some(NO_MANIFEST));
    }

    #[test]
    fn refuses_what_is_not_an_archive() {
        let dir = folder(&[("plugin.zip", b"not a zip")]);
        assert_eq!(
            read_archive(&dir.path().join("plugin.zip")).err(),
            Some(INVALID)
        );
    }
}
