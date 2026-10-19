//! Crash reporting: Rust panics go to Sentry, only in builds made with
//! `DEVOT_SENTRY_DSN` set, in the environment or in `.env.local` (read at
//! compile time by build.rs, never committed). Every event passes
//! `crash_scrub::scrub_event` first, which rebuilds it from an allowlist of
//! fields (codes, type names, code locations, addresses inside the binaries
//! it lists), so note titles, bodies and user names never leave the machine.

use crate::crash_reporter;
use crate::crash_scrub::scrub_event;
use std::path::Path;
use std::sync::Arc;

const DSN: Option<&str> = option_env!("DEVOT_SENTRY_DSN");
pub(crate) const RELEASE: &str = concat!("devot@", env!("CARGO_PKG_VERSION"));

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
    options.before_send = Some(Arc::new(|event| Some(scrub_event(event))));
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
