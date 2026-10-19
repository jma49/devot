//! Launch: take the data folder, then open the database. When that fails the failure is logged, a
//! native alert says what happened and the app exits with status 1. It never panics there: a panic
//! would end it with no window and lose the code.

use crate::storage::Db;
use crate::strings;
use std::fs::{File, TryLockError};
use std::path::Path;

pub const DB_FILE: &str = "devot.sqlite";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupError {
    code: String,
}

impl StartupError {
    pub fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

/// An advisory lock (`flock`) on the folder itself: no file is written, and the system lets go when
/// the process ends however it ends, so a crash never leaves the folder held.
#[derive(Debug)]
pub struct FolderLock(#[allow(dead_code)] File);

/// A folder that cannot be locked at all (a file system without locks) is logged and used without
/// the lock, rather than keeping Devot from starting; then `None`.
pub fn take_folder(dir: &Path) -> Result<Option<FolderLock>, StartupError> {
    std::fs::create_dir_all(dir).map_err(|_| StartupError::new("E_DATA_FOLDER_UNWRITABLE"))?;
    let Ok(folder) = File::open(dir) else {
        log::warn!("W_DATA_FOLDER_LOCK_FAILED E_DATA_FOLDER_OPEN");
        return Ok(None);
    };
    match folder.try_lock() {
        Ok(()) => Ok(Some(FolderLock(folder))),
        Err(TryLockError::WouldBlock) => Err(StartupError::new("E_DATA_FOLDER_IN_USE")),
        Err(TryLockError::Error(_)) => {
            log::warn!("W_DATA_FOLDER_LOCK_FAILED E_DATA_FOLDER_LOCK");
            Ok(None)
        }
    }
}

pub fn open_db(dir: &Path) -> Result<Db, StartupError> {
    Db::spawn(&dir.join(DB_FILE)).map_err(|error| StartupError::new(error.to_string()))
}

/// A folder another Devot holds ends the launch before `start` (the crash reporter) or the database
/// touch anything there.
pub fn open_data(
    dir: &Path,
    start: impl FnOnce(&Path),
) -> Result<(Option<FolderLock>, Db), StartupError> {
    let held = take_folder(dir)?;
    start(dir);
    let db = open_db(dir)?;
    Ok((held, db))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub title: &'static str,
    pub message: String,
}

fn says(code: &str) -> (&'static str, &'static str) {
    let kind = code.split(' ').next().unwrap_or(code);
    let failed = strings::STARTUP_FAILED_TITLE;
    match kind {
        "E_DATA_FOLDER_IN_USE" => (strings::STARTUP_IN_USE_TITLE, strings::STARTUP_IN_USE),
        "E_STORAGE_SCHEMA_TOO_NEW" => (failed, strings::STARTUP_NEWER_SCHEMA),
        "E_STORAGE_CORRUPT" => (failed, strings::STARTUP_CORRUPT),
        "E_STORAGE_FULL" => (failed, strings::STARTUP_FULL),
        "E_STORAGE_READONLY"
        | "E_STORAGE_IO"
        | "E_STORAGE_CANTOPEN"
        | "E_DATA_FOLDER_UNWRITABLE" => (failed, strings::STARTUP_UNWRITABLE),
        "E_STORAGE_BUSY" => (failed, strings::STARTUP_BUSY),
        _ => (failed, strings::STARTUP_OTHER),
    }
}

fn notice(error: &StartupError, data_dir: Option<&Path>) -> Notice {
    let (title, text) = says(error.code());
    let mut details: Vec<String> = data_dir
        .map(|dir| strings::STARTUP_FOLDER.replace("{folder}", &dir.display().to_string()))
        .into_iter()
        .collect();
    details.push(strings::STARTUP_CODE.replace("{code}", error.code()));
    Notice {
        title,
        message: format!("{text}\n\n{}", details.join("\n")),
    }
}

pub fn report(error: &StartupError, data_dir: Option<&Path>, alert: impl FnOnce(&Notice)) {
    log::error!("E_STARTUP_FAILED {}", error.code());
    alert(&notice(error, data_dir));
}

pub fn fail(error: &StartupError, data_dir: Option<&Path>) -> ! {
    report(error, data_dir, |notice| {
        crate::native::show_alert(notice.title, &notice.message);
    });
    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{SCHEMA_VERSION, Store};
    use crate::test_log;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    fn alert_for(error: &StartupError, data_dir: &Path) -> Notice {
        let mut shown = Vec::new();
        report(error, Some(data_dir), |notice| shown.push(notice.clone()));
        assert_eq!(shown.len(), 1, "one alert");
        shown.remove(0)
    }

    #[test]
    fn a_database_from_a_newer_devot_takes_the_alert_path() {
        test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        drop(Store::open(&path).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);

        let error = open_db(dir.path()).err().expect("refused");
        let code = format!("E_STORAGE_SCHEMA_TOO_NEW v{}", SCHEMA_VERSION + 1);
        assert_eq!(error.code(), code);
        let notice = alert_for(&error, dir.path());
        assert_eq!(notice.title, strings::STARTUP_FAILED_TITLE);
        assert!(
            notice.message.starts_with(strings::STARTUP_NEWER_SCHEMA),
            "{}",
            notice.message
        );
        assert!(notice.message.ends_with(&format!("Code: {code}")));
        assert!(
            notice
                .message
                .contains(&format!("Data folder: {}", dir.path().display()))
        );
        assert!(
            test_log::lines().contains(&format!("ERROR E_STARTUP_FAILED {code}")),
            "the code is logged"
        );
    }

    #[test]
    fn a_damaged_database_or_folder_takes_the_alert_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(DB_FILE), vec![7; 8192]).unwrap();
        let error = open_db(dir.path()).err().expect("refused");
        assert_eq!(error.code(), "E_STORAGE_CORRUPT");
        let notice = alert_for(&error, dir.path());
        assert_eq!(notice.title, strings::STARTUP_FAILED_TITLE);
        assert!(notice.message.starts_with(strings::STARTUP_CORRUPT));

        let error = open_db(&dir.path().join("missing")).err().expect("refused");
        assert_eq!(error.code(), "E_STORAGE_CANTOPEN");
        assert!(
            alert_for(&error, dir.path())
                .message
                .starts_with(strings::STARTUP_UNWRITABLE)
        );

        // A data folder that cannot be made: a file stands where its parent goes.
        std::fs::write(dir.path().join("taken"), b"x").unwrap();
        let error = take_folder(&dir.path().join("taken").join("data")).expect_err("refused");
        assert_eq!(error.code(), "E_DATA_FOLDER_UNWRITABLE");
        assert!(
            alert_for(&error, dir.path())
                .message
                .starts_with(strings::STARTUP_UNWRITABLE)
        );
    }

    #[test]
    fn each_kind_of_failure_says_what_happened() {
        let dir = tempfile::tempdir().unwrap();
        for (code, title, says) in [
            (
                "E_DATA_FOLDER_IN_USE",
                strings::STARTUP_IN_USE_TITLE,
                strings::STARTUP_IN_USE,
            ),
            (
                "E_STORAGE_FULL",
                strings::STARTUP_FAILED_TITLE,
                strings::STARTUP_FULL,
            ),
            (
                "E_STORAGE_READONLY",
                strings::STARTUP_FAILED_TITLE,
                strings::STARTUP_UNWRITABLE,
            ),
            (
                "E_STORAGE_IO",
                strings::STARTUP_FAILED_TITLE,
                strings::STARTUP_UNWRITABLE,
            ),
            (
                "E_STORAGE_BUSY",
                strings::STARTUP_FAILED_TITLE,
                strings::STARTUP_BUSY,
            ),
            (
                "E_MAIN_WINDOW_FAILED",
                strings::STARTUP_FAILED_TITLE,
                strings::STARTUP_OTHER,
            ),
        ] {
            let notice = alert_for(&StartupError::new(code), dir.path());
            assert_eq!(notice.title, title, "{code}");
            assert!(notice.message.starts_with(says), "{code}");
            assert!(notice.message.ends_with(&format!("Code: {code}")), "{code}");
        }
        let mut shown = Vec::new();
        report(&StartupError::new("E_DATA_FOLDER_UNKNOWN"), None, |n| {
            shown.push(n.clone())
        });
        assert!(!shown[0].message.contains("Data folder"));
        assert!(shown[0].message.ends_with("Code: E_DATA_FOLDER_UNKNOWN"));
    }

    #[test]
    fn a_launch_on_a_folder_another_devot_holds_touches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let _other = take_folder(dir.path()).unwrap();
        let mut started = false;
        let refused = open_data(dir.path(), |_| started = true)
            .err()
            .expect("refused");
        assert_eq!(refused.code(), "E_DATA_FOLDER_IN_USE");
        assert!(!started, "nothing starts on the other Devot's folder");
        assert!(
            !dir.path().join(DB_FILE).exists(),
            "the database is neither made nor migrated"
        );
    }

    #[test]
    fn a_launch_holds_the_folder_while_its_database_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let mut started = 0;
        let (held, _db) = open_data(dir.path(), |_| started += 1).unwrap();
        assert!(held.is_some(), "the folder is held");
        assert_eq!(started, 1, "started once, with the folder held");
        assert!(dir.path().join(DB_FILE).exists(), "the database is open");
        assert_eq!(
            take_folder(dir.path()).expect_err("held").code(),
            "E_DATA_FOLDER_IN_USE"
        );
    }

    #[test]
    fn a_second_devot_on_the_same_folder_is_refused_until_the_first_ends() {
        let dir = tempfile::tempdir().unwrap();
        let first = take_folder(dir.path()).unwrap();
        assert!(first.is_some(), "the folder is held");
        let second = take_folder(dir.path()).expect_err("refused");
        assert_eq!(second.code(), "E_DATA_FOLDER_IN_USE");
        assert_eq!(
            alert_for(&second, dir.path()).title,
            strings::STARTUP_IN_USE_TITLE
        );
        drop(first);
        assert!(
            take_folder(dir.path()).unwrap().is_some(),
            "free once the first has let go"
        );
    }

    /// Holds the folder named by DEVOT_FOLDER_HOLDER, says so on stdout, and
    /// waits to be ended. Run by the test below as another process.
    #[test]
    #[ignore]
    fn folder_holder_child() {
        let Ok(dir) = std::env::var("DEVOT_FOLDER_HOLDER") else {
            return;
        };
        let _held = take_folder(Path::new(&dir)).unwrap();
        println!("DEVOT_FOLDER_HELD");
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    struct Ended(std::process::Child);

    impl Drop for Ended {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn another_process_on_the_folder_refuses_this_one_until_it_dies() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = Ended(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "startup::tests::folder_holder_child",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("DEVOT_FOLDER_HOLDER", dir.path())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let mut lines = BufReader::new(child.0.stdout.take().unwrap()).lines();
        assert!(
            lines.any(|line| line.is_ok_and(|l| l.contains("DEVOT_FOLDER_HELD"))),
            "the other process holds the folder"
        );
        let refused = take_folder(dir.path()).expect_err("refused");
        assert_eq!(refused.code(), "E_DATA_FOLDER_IN_USE");
        drop(child);
        assert!(take_folder(dir.path()).unwrap().is_some());
    }
}
