//! What the unit tests logged. A process has one logger, set once, so every
//! test module that checks a log line captures through this one.

use std::sync::{Mutex, Once};

static LOGGED: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct Capture;

impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        if let Ok(mut lines) = LOGGED.lock() {
            lines.push(format!("{} {}", record.level(), record.args()));
        }
    }

    fn flush(&self) {}
}

/// Starts capturing log lines (from Info up), once per test binary.
pub fn capture() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        log::set_logger(&Capture).expect("no other logger in unit tests");
        log::set_max_level(log::LevelFilter::Info);
    });
}

/// Every line logged so far by any test, as `LEVEL message`.
pub fn lines() -> Vec<String> {
    LOGGED.lock().map(|lines| lines.clone()).unwrap_or_default()
}
