//! Help > Export Diagnostics: the logs hold codes and IDs only, so the file can be shared as is.

use crate::atomic_file::{Folder, Place};
use crate::logs;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub struct Info {
    pub version: String,
    pub os: String,
    pub arch: &'static str,
    pub schema: u32,
    pub created_ms: i64,
}

pub fn bundle(info: &Info, logs_dir: &Path) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Devot diagnostics");
    let _ = writeln!(out, "created: {}", logs::utc_iso(info.created_ms));
    let _ = writeln!(out, "version: {}", info.version);
    let _ = writeln!(out, "os: {}", info.os);
    let _ = writeln!(out, "arch: {}", info.arch);
    let _ = writeln!(out, "schema: {}", info.schema);
    for path in logs::files_oldest_first(logs_dir) {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        let _ = writeln!(out, "\n--- {} ---", name.unwrap_or_default());
        match std::fs::read_to_string(&path) {
            Ok(text) => out.push_str(&logs::scrub_paths(&text)),
            Err(_) => out.push_str("E_DIAGNOSTICS_LOG_UNREADABLE\n"),
        }
    }
    out
}

pub fn file_name(created_ms: i64) -> String {
    let iso = logs::utc_iso(created_ms);
    format!(
        "Devot Diagnostics {} {}.txt",
        &iso[..10],
        iso[11..19].replace(':', "-")
    )
}

fn os_version() -> String {
    std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|v| format!("macOS {}", v.trim()))
        .unwrap_or_else(|| "unknown".into())
}

const MAX_NAME_TRIES: u32 = 100;

/// Never writes over a file or through a link already there: the name is easy to guess (see `atomic_file`).
pub fn save(dir: &Path, created_ms: i64, text: &str) -> Result<PathBuf, &'static str> {
    let folder = Folder::open(dir).map_err(|_| "E_DIAGNOSTICS_WRITE")?;
    let name = file_name(created_ms);
    let stem = name.strip_suffix(".txt").unwrap_or(&name);
    for n in 1..=MAX_NAME_TRIES {
        let target = if n == 1 {
            name.clone()
        } else {
            format!("{stem} {n}.txt")
        };
        match folder.write(&target, text.as_bytes(), Place::New) {
            Ok(()) => return Ok(dir.join(target)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("E_DIAGNOSTICS_WRITE"),
        }
    }
    Err("E_DIAGNOSTICS_WRITE")
}

pub fn export(app: &AppHandle) -> Result<PathBuf, &'static str> {
    let paths = app.path();
    let logs_dir = paths
        .app_data_dir()
        .map_err(|_| "E_DIAGNOSTICS_DATA_DIR")?
        .join(logs::DIR);
    let downloads = paths
        .download_dir()
        .map_err(|_| "E_DIAGNOSTICS_DOWNLOADS_DIR")?;
    let info = Info {
        version: app.package_info().version.to_string(),
        os: os_version(),
        arch: std::env::consts::ARCH,
        schema: crate::storage::SCHEMA_VERSION,
        created_ms: logs::now_ms(),
    };
    let target = save(&downloads, info.created_ms, &bundle(&info, &logs_dir))?;
    // `-R` selects the file in a Finder window; the path is ours, not a flag.
    let mut reveal = std::process::Command::new("/usr/bin/open");
    reveal.arg("-R").arg(&target);
    crate::external::spawn_reaped(reveal, "W_DIAGNOSTICS_REVEAL_EXITED")
        .map_err(|_| "E_DIAGNOSTICS_REVEAL")?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundles_the_header_and_logs_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("devot.log"), "new /Users/dana/x\n").unwrap();
        std::fs::write(dir.path().join("devot.1.log"), "old\n").unwrap();
        let info = Info {
            version: "1.2.3".into(),
            os: "macOS 27.2".into(),
            arch: "aarch64",
            schema: 6,
            created_ms: 0,
        };
        assert_eq!(
            bundle(&info, dir.path()),
            "Devot diagnostics\ncreated: 1970-01-01T00:00:00.000Z\nversion: 1.2.3\n\
             os: macOS 27.2\narch: aarch64\nschema: 6\n\
             \n--- devot.1.log ---\nold\n\
             \n--- devot.log ---\nnew /Users/<user>/x\n"
        );
    }

    #[test]
    fn names_the_file_by_utc_time() {
        assert_eq!(
            file_name(1_791_635_696_789),
            "Devot Diagnostics 2026-10-10 12-34-56.txt"
        );
    }

    const T: i64 = 1_791_635_696_789;

    #[test]
    fn saves_a_new_file_and_never_replaces_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(file_name(T)), "someone's").unwrap();
        let saved = save(dir.path(), T, "bundle").unwrap();
        assert_eq!(
            saved,
            dir.path()
                .join("Devot Diagnostics 2026-10-10 12-34-56 2.txt")
        );
        assert_eq!(std::fs::read_to_string(&saved).unwrap(), "bundle");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(file_name(T))).unwrap(),
            "someone's"
        );
        let next = save(dir.path(), T, "again").unwrap();
        assert_eq!(
            next,
            dir.path()
                .join("Devot Diagnostics 2026-10-10 12-34-56 3.txt")
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3);
        assert_eq!(
            save(&dir.path().join("gone"), T, "x"),
            Err("E_DIAGNOSTICS_WRITE")
        );
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link_at_the_bundle_s_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        std::fs::write(&theirs, b"theirs").unwrap();
        // The bundle's name is easy to guess (the time): a link planted there
        // took the bundle wherever it pointed.
        let link = dir.path().join(file_name(T));
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        let saved = save(dir.path(), T, "bundle").unwrap();
        assert_eq!(std::fs::read_to_string(&saved).unwrap(), "bundle");
        assert!(std::fs::symlink_metadata(&saved).unwrap().is_file());
        assert_eq!(std::fs::read(&theirs).unwrap(), b"theirs");
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
    }
}
