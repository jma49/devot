//! Crash reporting: Rust panics go to Sentry, only in builds made with
//! `DEVOT_SENTRY_DSN` set, in the environment or in `.env.local` (read at
//! compile time by build.rs, never committed). Every event passes
//! `crash_scrub::scrub_event` first, which rebuilds it from an allowlist of
//! fields (codes, type names, code locations, addresses inside the binaries
//! it lists), so note titles, bodies and user names never leave the machine.
//! Nothing is sent until the user turns reports on in Settings > General.

use crate::atomic_file::{Place, TempFile};
use crate::crash_reporter;
use crate::crash_scrub::scrub_event;
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

const DSN: Option<&str> = option_env!("DEVOT_SENTRY_DSN");
pub(crate) const RELEASE: &str = concat!("devot@", env!("CARGO_PKG_VERSION"));
const CHOICE_FILE: &str = "crash-reports-on";

// A panic before the data folder is known is dropped: the choice cannot be read yet.
static CHOSEN: AtomicBool = AtomicBool::new(cfg!(test));
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

fn chosen_in(data_dir: &Path) -> bool {
    data_dir.join(CHOICE_FILE).is_file()
}

/// Turning reports off also deletes those saved but not yet sent.
fn save_choice(data_dir: &Path, on: bool) -> io::Result<()> {
    let file = data_dir.join(CHOICE_FILE);
    if on {
        return TempFile::create(data_dir.join(format!("{CHOICE_FILE}.partial")))?
            .persist(&file, Place::Replace);
    }
    match std::fs::remove_file(file) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    delete_pending(data_dir)
}

fn delete_pending(data_dir: &Path) -> io::Result<()> {
    match std::fs::remove_dir_all(data_dir.join(crash_reporter::DIR)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CrashReports {
    /// False in a build without a DSN, which can send nothing.
    pub available: bool,
    pub on: bool,
}

fn crash_reports_now() -> CrashReports {
    CrashReports {
        available: dsn().is_some(),
        on: dsn().is_some() && CHOSEN.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn crash_reports_get() -> CrashReports {
    crash_reports_now()
}

#[tauri::command]
pub fn crash_reports_set(on: bool) -> Result<CrashReports, String> {
    if dsn().is_none() {
        return Err("E_CRASH_REPORTS_UNAVAILABLE".into());
    }
    let dir = DATA_DIR.get().ok_or("E_CRASH_REPORTS_NOT_READY")?;
    save_choice(dir, on).map_err(|_| "E_CRASH_REPORTS_SAVE".to_owned())?;
    CHOSEN.store(on, Ordering::SeqCst);
    Ok(crash_reports_now())
}

pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = dsn()?;
    Some(sentry::init((dsn, options())))
}

/// The default integrations add a panic's stack trace and the loaded binaries (by debug ID), so Sentry can name the functions of a stripped release build from its uploaded `devot.dSYM`; scrubbing keeps the binaries the frames are in.
fn options() -> sentry::ClientOptions {
    // `ClientOptions` is non-exhaustive, so it is filled in field by field.
    let mut options = sentry::ClientOptions::default();
    options.release = Some(RELEASE.into());
    options.environment = Some(environment().into());
    options.send_default_pii = false;
    options.max_breadcrumbs = 0;
    options.before_breadcrumb = Some(Arc::new(|_| None));
    options.before_send = Some(Arc::new(|event| {
        CHOSEN.load(Ordering::SeqCst).then(|| scrub_event(event))
    }));
    options
}

/// `crash.ts` reads it from TAURI_ENV_DEBUG, which Tauri's CLI sets for builds with debug assertions.
pub(crate) fn environment() -> &'static str {
    if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    }
}

fn dsn() -> Option<&'static str> {
    DSN.filter(|d| !d.is_empty())
}

pub fn start_native(data_dir: &Path) {
    let _ = DATA_DIR.set(data_dir.to_owned());
    let chosen = chosen_in(data_dir);
    CHOSEN.store(chosen, Ordering::SeqCst);
    if !chosen {
        // Written by a reporter still running when reports were turned off.
        if delete_pending(data_dir).is_err() {
            log::warn!("W_CRASH_REPORTS_DELETE_FAILED");
        }
        return;
    }
    let Some(dsn) = dsn() else {
        return;
    };
    let dir = data_dir.join(crash_reporter::DIR);
    match std::env::current_exe() {
        Ok(exe) => {
            crash_reporter::start(Some(dsn), exe, dir.clone());
        }
        Err(_) => log::warn!("W_CRASH_REPORTER_EXE_MISSING"),
    }
    let spawned = std::thread::Builder::new()
        .name("devot-crash-reports".into())
        .spawn(move || {
            if crash_reporter::send_pending(&dir, dsn) > 0 {
                log::info!("I_CRASH_REPORTS_SENT");
            }
        });
    if spawned.is_err() {
        log::warn!("W_CRASH_REPORTS_THREAD_SPAWN_FAILED");
    }
}

pub fn reporter_main(args: &[std::ffi::OsString]) -> Option<i32> {
    if dsn().is_none() {
        return args
            .get(1)
            .is_some_and(|a| a == crash_reporter::FLAG)
            .then_some(2);
    }
    crash_reporter::reporter_main(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_stay_off_until_chosen() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!chosen_in(dir.path()));
        save_choice(dir.path(), true).unwrap();
        assert!(chosen_in(dir.path()));
    }

    #[test]
    fn turning_reports_off_deletes_those_not_yet_sent() {
        let dir = tempfile::tempdir().unwrap();
        save_choice(dir.path(), true).unwrap();
        let pending = dir.path().join(crash_reporter::DIR);
        std::fs::create_dir_all(&pending).unwrap();
        std::fs::write(pending.join("report.json"), b"{}").unwrap();
        save_choice(dir.path(), false).unwrap();
        assert!(!chosen_in(dir.path()));
        assert!(!pending.exists());
        save_choice(dir.path(), false).unwrap();
    }
    use sentry::protocol::{Event, Exception, Level, Mechanism};

    #[derive(Default)]
    struct Kept(std::sync::Mutex<Vec<sentry::Envelope>>);

    impl sentry::Transport for Kept {
        fn send_envelope(&self, envelope: sentry::Envelope) {
            self.0.lock().unwrap().push(envelope);
        }
    }

    fn prepared_panic() -> Event<'static> {
        let kept = Arc::new(Kept::default());
        let transport = Arc::clone(&kept);
        let mut options = options();
        options.dsn = Some("https://public@127.0.0.1/1".parse().unwrap());
        options.transport = Some(Arc::new(move |_: &sentry::ClientOptions| {
            Arc::clone(&transport) as Arc<dyn sentry::Transport>
        }));
        let client = Arc::new(sentry::Client::from(sentry::apply_defaults(options)));
        let hub = sentry::Hub::new(Some(client), Arc::new(sentry::Scope::default()));
        hub.capture_event(Event {
            exception: vec![Exception {
                ty: "panic".into(),
                value: Some("E_TEST_PANIC: Grocery list".into()),
                stacktrace: sentry::integrations::backtrace::current_stacktrace(),
                mechanism: Some(Mechanism {
                    ty: "panic".into(),
                    handled: Some(false),
                    ..Default::default()
                }),
                ..Default::default()
            }]
            .into(),
            level: Level::Fatal,
            ..Default::default()
        });
        let envelopes = kept.0.lock().unwrap();
        envelopes
            .iter()
            .find_map(|envelope| envelope.event().cloned())
            .expect("the panic was kept")
    }

    #[test]
    fn a_panic_names_the_release_and_the_binaries_its_frames_are_in() {
        let event = prepared_panic();
        assert_eq!(event.release.as_deref(), Some(RELEASE));
        assert_eq!(event.environment.as_deref(), Some(environment()));
        let exception = &event.exception.values[0];
        assert_eq!(exception.value.as_deref(), Some("E_TEST_PANIC"));
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains("Grocery"), "{json}");
        // A stripped build's frames are addresses alone; Sentry names their
        // functions from the binary they are in, by its debug ID.
        #[cfg(target_os = "macos")]
        {
            let images: Vec<_> = event
                .debug_meta
                .images
                .iter()
                .filter_map(|image| match image {
                    sentry::protocol::DebugImage::Symbolic(image) => Some(image),
                    _ => None,
                })
                .collect();
            let addresses: Vec<u64> = exception
                .stacktrace
                .as_ref()
                .expect("a stack trace")
                .frames
                .iter()
                .filter_map(|frame| frame.instruction_addr.map(|a| a.0))
                .collect();
            let holds = |image: &&sentry::protocol::SymbolicDebugImage, address: u64| {
                image.image_addr.0 <= address && address - image.image_addr.0 < image.image_size
            };
            let exe = std::env::current_exe().unwrap();
            let name = exe.file_name().unwrap().to_str().unwrap();
            let own = images
                .iter()
                .find(|image| image.name == name)
                .unwrap_or_else(|| panic!("{name} is not listed: {json}"));
            assert!(!own.id.is_nil());
            assert!(addresses.iter().any(|&a| holds(own, a)), "{json}");
            assert!(
                addresses
                    .iter()
                    .all(|&a| images.iter().any(|i| holds(i, a))),
                "{json}"
            );
        }
    }

    /// Sends one event to the project: `DEVOT_SENTRY_DSN=… cargo test -- --ignored crash`.
    #[test]
    #[ignore = "sends a real event; run by hand with a DSN"]
    fn sends_a_test_event() {
        let guard = init().expect("E_TEST_NEEDS_DSN");
        sentry::capture_message("E_CRASH_REPORTING_TEST", sentry::Level::Info);
        assert!(guard.flush(Some(std::time::Duration::from_secs(10))));
    }

    #[test]
    fn builds_without_a_dsn_send_nothing() {
        if DSN.is_none_or(str::is_empty) {
            assert!(init().is_none());
        }
    }

    #[test]
    fn builds_without_a_dsn_refuse_to_run_as_the_crash_reporter() {
        let args = |list: &[&str]| list.iter().map(Into::into).collect::<Vec<_>>();
        assert_eq!(reporter_main(&args(&["devot"])), None);
        assert_eq!(reporter_main(&args(&["devot", "--other"])), None);
        if DSN.is_none_or(str::is_empty) {
            let reporter = args(&["devot", crash_reporter::FLAG, "x", "/tmp"]);
            assert_eq!(reporter_main(&reporter), Some(2));
        }
    }

    #[test]
    fn the_reporter_rejects_malformed_arguments() {
        let args = |list: &[&str]| list.iter().map(Into::into).collect::<Vec<_>>();
        let flag = crash_reporter::FLAG;
        let token = "0123456789abcdef0123456789abcdef";
        let service = format!("io.github.jma49.devot.crash-reporter.1.{token}");
        for bad in [
            vec!["devot", flag],
            vec!["devot", flag, &service],
            vec!["devot", flag, &service, "relative"],
            vec!["devot", flag, &service, "/tmp", "extra"],
            vec!["devot", flag, "other.service.1", "/tmp"],
            vec![
                "devot",
                flag,
                "io.github.jma49.devot.crash-reporter.1",
                "/tmp",
            ],
            vec![
                "devot",
                flag,
                "io.github.jma49.devot.crash-reporter.x.0",
                "/tmp",
            ],
            vec![
                "devot",
                flag,
                "io.github.jma49.devot.crash-reporter.1.short",
                "/tmp",
            ],
        ] {
            assert_eq!(
                crash_reporter::reporter_main(&args(&bad)),
                Some(2),
                "{bad:?}"
            );
        }
    }
}
