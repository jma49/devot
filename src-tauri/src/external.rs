//! Web links leave the app: an https URL opens in the user's browser, and
//! the app's own page never navigates to it. Pop-ups from embeds (an iframe
//! asking for a new window) take the same path. `/usr/bin/open` takes the
//! URL to the browser (and the diagnostics bundle to Finder); the app never
//! waits for it, but always reaps it (`spawn_reaped`).

use std::process::Command;
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Runtime, Url};

/// Accepts only plain https URLs with a host and no credentials.
fn validate(url: &str) -> Result<Url, &'static str> {
    crate::net::https_url(url)
}

/// Starts `command` and returns its process ID without waiting for it; a
/// thread of its own waits for it to exit (and logs `code` with the exit
/// code when it failed). A child nobody waits for stays in the process table
/// as a zombie (`open` listed as defunct) until the app quits.
pub(crate) fn spawn_reaped(mut command: Command, code: &'static str) -> std::io::Result<u32> {
    let mut child = command.spawn()?;
    let pid = child.id();
    let waiting = std::thread::Builder::new()
        .name("devot-open".into())
        .spawn(move || match child.wait() {
            Ok(status) if status.success() => {}
            Ok(status) => log::warn!("{code} {}", status.code().unwrap_or(-1)),
            Err(_) => log::warn!("{code} E_WAIT_FAILED"),
        });
    if waiting.is_err() {
        log::warn!("W_CHILD_NOT_REAPED");
    }
    Ok(pid)
}

fn open_in_browser(url: &Url) -> Result<(), &'static str> {
    #[cfg(target_os = "macos")]
    {
        // The URL starts with "https://", so `open` cannot read it as a flag.
        let mut open = Command::new("/usr/bin/open");
        open.arg(url.as_str());
        spawn_reaped(open, "W_OPEN_EXITED")
            .map(drop)
            .map_err(|_| "E_OPEN_FAILED")
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("E_OPEN_UNSUPPORTED")
    }
}

/// Opens an https link from a note in the default browser.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let url = validate(&url)?;
    open_in_browser(&url).map_err(String::from)
}

/// New-window requests never create app windows; https ones go to the browser.
pub fn on_new_window<R: Runtime>(url: Url, _features: NewWindowFeatures) -> NewWindowResponse<R> {
    match validate(url.as_str()) {
        Ok(url) => {
            if open_in_browser(&url).is_err() {
                log::warn!("W_POPUP_OPEN_FAILED");
            }
        }
        Err(code) => log::warn!("W_POPUP_REFUSED {code}"),
    }
    NewWindowResponse::Deny
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_https_urls() {
        for url in ["https://example.com", "https://example.com/a?b=c#d"] {
            assert!(validate(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn refuses_other_schemes() {
        for url in [
            "http://example.com",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "devot://note/x",
            "data:text/html,x",
            "-a Calculator",
        ] {
            assert!(validate(url).is_err(), "{url}");
        }
    }

    /// Exited children nobody waited for stay in the process table as
    /// zombies (`ps` state Z, `open` listed as defunct) until the app quits:
    /// one for every link opened and every diagnostics export.
    #[cfg(unix)]
    #[test]
    fn reaps_the_programs_it_starts() {
        use std::time::{Duration, Instant};
        let pid = spawn_reaped(Command::new("true"), "W_TEST_EXITED").unwrap();
        let state = || {
            let ps = Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            String::from_utf8_lossy(&ps.stdout).trim().to_owned()
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        // `true` exits at once; once reaped it is gone from the table.
        let mut last = state();
        while !last.is_empty() {
            assert!(
                Instant::now() < deadline,
                "child {pid} is still in the process table, state {last}"
            );
            std::thread::sleep(Duration::from_millis(20));
            last = state();
        }
    }

    #[cfg(unix)]
    #[test]
    fn logs_a_failed_exit_by_its_code() {
        use std::time::{Duration, Instant};
        crate::test_log::capture();
        spawn_reaped(Command::new("false"), "W_TEST_PROGRAM_EXITED").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let logged =
            || crate::test_log::lines().contains(&String::from("WARN W_TEST_PROGRAM_EXITED 1"));
        while !logged() {
            assert!(Instant::now() < deadline, "no log line for the failed exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn refuses_credentials_and_oversized_urls() {
        assert_eq!(
            validate("https://user:pw@example.com").unwrap_err(),
            "E_URL_CREDENTIALS_REFUSED"
        );
        let long = format!(
            "https://example.com/{}",
            "a".repeat(crate::net::MAX_URL_LEN)
        );
        assert_eq!(validate(&long).unwrap_err(), "E_URL_TOO_LONG");
    }
}
