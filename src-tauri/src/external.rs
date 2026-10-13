//! Web links leave the app: an https URL opens in the user's browser, and
//! the app's own page never navigates to it. Pop-ups from embeds (an iframe
//! asking for a new window) take the same path.

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Runtime, Url};

const MAX_URL_LEN: usize = 2048;

/// Accepts only plain https URLs with a host and no credentials.
fn validate(url: &str) -> Result<Url, &'static str> {
    if url.len() > MAX_URL_LEN {
        return Err("E_URL_TOO_LONG");
    }
    let parsed = Url::parse(url).map_err(|_| "E_URL_INVALID")?;
    if parsed.scheme() != "https" {
        return Err("E_URL_SCHEME_REFUSED");
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("E_URL_INVALID");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("E_URL_CREDENTIALS_REFUSED");
    }
    Ok(parsed)
}

fn open_in_browser(url: &Url) -> Result<(), &'static str> {
    #[cfg(target_os = "macos")]
    {
        // The URL starts with "https://", so `open` cannot read it as a flag.
        std::process::Command::new("/usr/bin/open")
            .arg(url.as_str())
            .spawn()
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

    #[test]
    fn refuses_credentials_and_oversized_urls() {
        assert_eq!(
            validate("https://user:pw@example.com").unwrap_err(),
            "E_URL_CREDENTIALS_REFUSED"
        );
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(validate(&long).unwrap_err(), "E_URL_TOO_LONG");
    }
}
