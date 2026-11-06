//! A settings file of one JSON object, read and replaced whole.
//!
//! A file that cannot be parsed is kept aside and read as empty; a file that cannot be read at all
//! (or whose damaged bytes could not be kept) reads as unknown, and nothing is written over it then,
//! since a change would drop every value it holds.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

/// The log codes of one settings file, and the error a failed write returns.
pub struct Codes {
    pub unreadable: &'static str,
    pub copy_failed: &'static str,
    pub read_failed: &'static str,
    pub write_failed: &'static str,
}

pub struct SettingsFile {
    path: PathBuf,
    codes: &'static Codes,
}

impl SettingsFile {
    pub fn new(path: &Path, codes: &'static Codes) -> Self {
        Self {
            path: path.to_owned(),
            codes,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> Option<Map<String, Value>> {
        self.read_as(Some)
    }

    /// `parse` turns the stored object into settings; when it gives none the file counts as
    /// damaged. A missing or damaged file is parsed as an empty object. None while unknown.
    pub fn read_as<T>(&self, parse: impl Fn(Map<String, Value>) -> Option<T>) -> Option<T> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return parse(Map::new()),
            Err(_) => {
                log::warn!("{}", self.codes.read_failed);
                return None;
            }
        };
        if let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&bytes)
            && let Some(settings) = parse(map)
        {
            return Some(settings);
        }
        log::warn!("{}", self.codes.unreadable);
        if crate::atomic_file::keep_damaged(&self.path, &bytes).is_err() {
            log::warn!("{}", self.codes.copy_failed);
            return None;
        }
        parse(Map::new())
    }

    pub fn write(&self, settings: &impl Serialize) -> Result<(), &'static str> {
        let json = serde_json::to_vec_pretty(settings).map_err(|_| self.codes.write_failed)?;
        crate::atomic_file::write_replacing(&self.path, &json).map_err(|_| self.codes.write_failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_file::DAMAGED_SUFFIX;
    use serde_json::json;

    const CODES: Codes = Codes {
        unreadable: "W_TEST_SETTINGS_UNREADABLE",
        copy_failed: "W_TEST_SETTINGS_COPY_FAILED",
        read_failed: "W_TEST_SETTINGS_READ_FAILED",
        write_failed: "E_TEST_SETTINGS_WRITE_FAILED",
    };

    fn file(dir: &tempfile::TempDir) -> SettingsFile {
        SettingsFile::new(&dir.path().join("test.json"), &CODES)
    }

    fn damaged(file: &SettingsFile) -> PathBuf {
        let mut copy = file.path().as_os_str().to_owned();
        copy.push(DAMAGED_SUFFIX);
        PathBuf::from(copy)
    }

    #[test]
    fn a_missing_file_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(file(&dir).read(), Some(Map::new()));
    }

    #[test]
    fn what_is_written_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = file(&dir);
        file.write(&json!({"a": 1, "b": "two"})).unwrap();
        let read = file.read().unwrap();
        assert_eq!(Value::Object(read), json!({"a": 1, "b": "two"}));
    }

    #[test]
    fn a_damaged_file_is_kept_aside_and_reads_as_empty() {
        for bytes in [&b"{ nope"[..], b"[1, 2]", b"\"text\""] {
            let dir = tempfile::tempdir().unwrap();
            let file = file(&dir);
            std::fs::write(file.path(), bytes).unwrap();
            assert_eq!(file.read(), Some(Map::new()));
            assert_eq!(std::fs::read(damaged(&file)).unwrap(), bytes);
        }
    }

    #[test]
    fn settings_the_parser_refuses_count_as_damaged() {
        let dir = tempfile::tempdir().unwrap();
        let file = file(&dir);
        std::fs::write(file.path(), br#"{"a": 1}"#).unwrap();
        let read = file.read_as(|map| map.is_empty().then_some("empty"));
        assert_eq!(read, Some("empty"));
        assert_eq!(std::fs::read(damaged(&file)).unwrap(), br#"{"a": 1}"#);
    }

    #[test]
    fn a_damaged_file_that_cannot_be_kept_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let file = file(&dir);
        std::fs::write(file.path(), b"{ nope").unwrap();
        std::fs::create_dir(damaged(&file)).unwrap();
        assert_eq!(file.read(), None);
    }

    #[test]
    fn an_unreadable_file_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let file = file(&dir);
        std::fs::create_dir(file.path()).unwrap();
        assert_eq!(file.read(), None);
    }

    #[test]
    fn a_failed_write_returns_its_code() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile::new(&dir.path().join("missing").join("test.json"), &CODES);
        assert_eq!(file.write(&json!({})), Err("E_TEST_SETTINGS_WRITE_FAILED"));
    }
}
