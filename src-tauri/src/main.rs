// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // DSN builds start a second copy of this binary as the crash reporter.
    if let Some(code) = devot_lib::crash_reporter_main() {
        std::process::exit(code);
    }
    devot_lib::run()
}
