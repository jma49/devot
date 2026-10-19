//! Local logs: one JSON object per line in `<app data>/logs/devot.log`,
//! rotated by size. Entries carry codes and IDs, never note content, and user
//! names in file paths are replaced before anything is written. The UI sends
//! its warnings through `log_write`, which accepts only codes and IDs.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DIR: &str = "logs";
const NAME: &str = "devot.log";
const MAX_BYTES: u64 = 1024 * 1024;
const KEEP: usize = 4;
const MAX_UI_IDS: usize = 4;
const UI_TARGET: &str = "ui";

pub struct RotatingFile {
    dir: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: Option<File>,
    size: u64,
}

impl RotatingFile {
    pub fn new(dir: &Path, max_bytes: u64, keep: usize) -> Self {
        Self {
            dir: dir.to_path_buf(),
            max_bytes,
            keep,
            file: None,
            size: 0,
        }
    }

    fn rotated(&self, n: usize) -> PathBuf {
        self.dir.join(format!("devot.{n}.log"))
    }

    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        if self.file.is_none() {
            fs::create_dir_all(&self.dir)?;
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(NAME))?;
            self.size = file.metadata()?.len();
            self.file = Some(file);
        }
        let len = line.len() as u64;
        if self.size > 0 && self.size + len > self.max_bytes {
            self.rotate()?;
            return self.write_line(line);
        }
        if let Some(file) = self.file.as_mut() {
            file.write_all(line.as_bytes())?;
        }
        self.size += len;
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        let oldest = self.rotated(self.keep);
        if oldest.exists() {
            fs::remove_file(oldest)?;
        }
        for n in (1..self.keep).rev() {
            let from = self.rotated(n);
            if from.exists() {
                fs::rename(from, self.rotated(n + 1))?;
            }
        }
        if self.keep > 0 {
            fs::rename(self.dir.join(NAME), self.rotated(1))?;
        } else {
            fs::remove_file(self.dir.join(NAME))?;
        }
        Ok(())
    }
}

pub fn files_oldest_first(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = (1..=KEEP)
        .rev()
        .map(|n| dir.join(format!("devot.{n}.log")))
        .collect();
    files.push(dir.join(NAME));
    files.into_iter().filter(|p| p.exists()).collect()
}

pub fn scrub_paths(text: &str) -> String {
    const HOME: &str = "/Users/";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(HOME) {
        out.push_str(&rest[..i + HOME.len()]);
        let after = &rest[i + HOME.len()..];
        let end = after
            .find(|c: char| c == '/' || c.is_whitespace() || matches!(c, '"' | '\'' | ':'))
            .unwrap_or(after.len());
        if end > 0 {
            out.push_str("<user>");
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

pub fn is_code(text: &str) -> bool {
    let rest = match text.as_bytes() {
        [b'E' | b'W' | b'I', b'_', rest @ ..] => rest,
        _ => return false,
    };
    !rest.is_empty()
        && text.len() <= 64
        && rest
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

fn is_id(text: &str) -> bool {
    is_code(text) || crate::commands::notes::valid_note_id(text)
}

pub fn utc_iso(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, day_secs) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days to a civil date (proleptic Gregorian calendar).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        day_secs / 3600,
        day_secs % 3600 / 60,
        day_secs % 60
    )
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

pub fn format_line(ms: i64, level: log::Level, target: &str, message: &str) -> String {
    // Written by hand to keep the field order; values are JSON-escaped.
    let json = |text: &str| serde_json::Value::from(text).to_string();
    format!(
        "{{\"ts\":{},\"level\":{},\"target\":{},\"msg\":{}}}\n",
        json(&utc_iso(ms)),
        json(&level.as_str().to_ascii_lowercase()),
        json(target),
        json(&scrub_paths(message))
    )
}

/// Devot's own entries from Info up; other crates only from Warn up.
fn wanted(target: &str, level: log::Level) -> bool {
    let own = target == UI_TARGET || target.starts_with("devot");
    level
        <= if own {
            log::Level::Info
        } else {
            log::Level::Warn
        }
}

pub struct Logger {
    file: Mutex<RotatingFile>,
}

impl Logger {
    pub fn new(dir: &Path) -> Self {
        Self {
            file: Mutex::new(RotatingFile::new(dir, MAX_BYTES, KEEP)),
        }
    }
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        wanted(metadata.target(), metadata.level())
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format_line(
            now_ms(),
            record.level(),
            record.target(),
            &record.args().to_string(),
        );
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        // A failed write cannot be logged anywhere; the entry is dropped.
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_line(&line);
        }
    }

    fn flush(&self) {}
}

pub fn install(dir: &Path) {
    // The logger lives for the rest of the process.
    if log::set_logger(Box::leak(Box::new(Logger::new(dir)))).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        log::error!("E_PANIC {} {location}", panic_code(&payload));
        previous(info);
    }));
}

/// The code a panic message starts with (`E_X: details` gives `E_X`), or
/// `E_UNKNOWN`: the rest of the message may hold data and is not logged.
pub fn panic_code(message: &str) -> &str {
    let end = message
        .find(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
        .unwrap_or(message.len());
    let code = &message[..end];
    if is_code(code) { code } else { "E_UNKNOWN" }
}

fn ui_entry(level: &str, code: &str, ids: &[String]) -> Result<(log::Level, String), &'static str> {
    let level = match level {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "info" => log::Level::Info,
        _ => return Err("E_LOG_LEVEL_INVALID"),
    };
    if !is_code(code) {
        return Err("E_LOG_CODE_INVALID");
    }
    if ids.len() > MAX_UI_IDS {
        return Err("E_LOG_TOO_MANY_IDS");
    }
    if !ids.iter().all(|id| is_id(id)) {
        return Err("E_LOG_ID_INVALID");
    }
    let mut text = code.to_owned();
    for id in ids {
        text.push(' ');
        text.push_str(id);
    }
    Ok((level, text))
}

#[tauri::command]
pub fn log_write(level: String, code: String, ids: Vec<String>) -> Result<(), String> {
    let (level, text) = ui_entry(&level, &code, &ids).map_err(String::from)?;
    log::log!(target: UI_TARGET, level, "{text}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::Log;

    const NOTE_ID: &str = "01920000-0000-7000-8000-000000000001";

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn formats_times_as_utc() {
        assert_eq!(utc_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(utc_iso(1_791_635_696_789), "2026-10-10T12:34:56.789Z");
        assert_eq!(utc_iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn lines_are_json_with_paths_scrubbed() {
        let line = format_line(
            0,
            log::Level::Warn,
            "devot_lib::files",
            "W_X /Users/alice/Library/devot.sqlite",
        );
        assert!(line.starts_with("{\"ts\":"));
        assert!(line.ends_with('\n'));
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["level"], "warn");
        assert_eq!(value["target"], "devot_lib::files");
        assert_eq!(value["msg"], "W_X /Users/<user>/Library/devot.sqlite");
        assert_eq!(value["ts"], "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn scrubs_every_home_folder_name() {
        assert_eq!(
            scrub_paths("a /Users/bob b \"/Users/carol\" /Users/ x"),
            "a /Users/<user> b \"/Users/<user>\" /Users/ x"
        );
        assert_eq!(scrub_paths("no paths"), "no paths");
    }

    #[test]
    fn rotates_by_size_and_keeps_a_few_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut file = RotatingFile::new(dir.path(), 20, 2);
        for n in 0..5 {
            file.write_line(&format!("line {n} 0123456\n")).unwrap();
        }
        // 15-byte lines in 20-byte files: one line per file, two kept.
        assert_eq!(read(&dir.path().join("devot.log")), "line 4 0123456\n");
        assert_eq!(read(&dir.path().join("devot.1.log")), "line 3 0123456\n");
        assert_eq!(read(&dir.path().join("devot.2.log")), "line 2 0123456\n");
        assert!(!dir.path().join("devot.3.log").exists());
        let names: Vec<_> = files_oldest_first(dir.path())
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["devot.2.log", "devot.1.log", "devot.log"]);
    }

    #[test]
    fn appends_to_an_existing_log() {
        let dir = tempfile::tempdir().unwrap();
        RotatingFile::new(dir.path(), 100, 2)
            .write_line("one\n")
            .unwrap();
        RotatingFile::new(dir.path(), 100, 2)
            .write_line("two\n")
            .unwrap();
        assert_eq!(read(&dir.path().join("devot.log")), "one\ntwo\n");
    }

    #[test]
    fn keeps_own_info_and_others_from_warn() {
        let dir = tempfile::tempdir().unwrap();
        let logger = Logger::new(dir.path());
        let entry = |target: &str, level, msg: &str| {
            logger.log(
                &log::Record::builder()
                    .target(target)
                    .level(level)
                    .args(format_args!("{msg}"))
                    .build(),
            );
        };
        entry("devot_lib::exit", log::Level::Info, "I_OWN");
        entry("ui", log::Level::Info, "I_UI");
        entry("tao::platform", log::Level::Info, "I_OTHER");
        entry("tao::platform", log::Level::Warn, "W_OTHER");
        entry("devot_lib::exit", log::Level::Debug, "D_OWN");
        let text = read(&dir.path().join("devot.log"));
        let messages: Vec<String> = text
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["msg"].to_string())
            .collect();
        assert_eq!(messages, ["\"I_OWN\"", "\"I_UI\"", "\"W_OTHER\""]);
    }

    #[test]
    fn panic_messages_keep_only_their_code() {
        assert_eq!(
            panic_code("E_TAURI_BUILD: Some(\"secret\")"),
            "E_TAURI_BUILD"
        );
        assert_eq!(panic_code("index out of bounds"), "E_UNKNOWN");
        assert_eq!(panic_code("E_"), "E_UNKNOWN");
    }

    #[test]
    fn ui_entries_accept_only_codes_and_ids() {
        let ok = ui_entry("warn", "W_NOTE_OPEN_FAILED", &[NOTE_ID.into()]).unwrap();
        assert_eq!(
            ok,
            (log::Level::Warn, format!("W_NOTE_OPEN_FAILED {NOTE_ID}"))
        );
        assert_eq!(
            ui_entry("error", "E_UI_UNCAUGHT", &["E_ATTACHMENT_TOO_LARGE".into()])
                .unwrap()
                .1,
            "E_UI_UNCAUGHT E_ATTACHMENT_TOO_LARGE"
        );
        assert_eq!(ui_entry("debug", "W_X", &[]), Err("E_LOG_LEVEL_INVALID"));
        assert_eq!(
            ui_entry("warn", "My note title", &[]),
            Err("E_LOG_CODE_INVALID")
        );
        assert_eq!(
            ui_entry("warn", "W_X", &["Groceries".into()]),
            Err("E_LOG_ID_INVALID")
        );
        assert_eq!(
            ui_entry("warn", "W_X", &vec![NOTE_ID.to_owned(); 5]),
            Err("E_LOG_TOO_MANY_IDS")
        );
    }
}
