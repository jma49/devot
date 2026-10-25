//! Fetching the Worker's signed revocation list (docs/licensing.md, Revocations): downloaded whole
//! with a plain GET, so the Worker never learns which licence a device holds. The list is verified
//! and kept by `Licence::apply_revocations`.

use std::time::Duration;

use tauri::Url;

use super::Licence;
use crate::net::{self, Fetched, Get};

/// Where the licence pages live; Settings > Licence links to the same address (`licence.ts`).
pub(crate) const SITE: &str = "https://licence.devot.online";
/// About 33 characters per revoked licence: this holds some thirty thousand.
const MAX_BYTES: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn list_url(site: &str) -> String {
    format!("{site}/revoked")
}

fn download(
    site: &str,
    get: &impl Fn(&Get) -> Result<Fetched, &'static str>,
) -> Result<String, &'static str> {
    let url = Url::parse(&list_url(site)).map_err(|_| "E_URL_INVALID")?;
    let answer = get(&Get {
        url: &url,
        accept: "text/plain",
        headers: &[],
        timeout: TIMEOUT,
        max_bytes: MAX_BYTES,
    })?;
    if answer.status != 200 {
        return Err("E_LICENCE_REVOCATIONS_STATUS");
    }
    if answer.truncated {
        return Err("E_LICENCE_REVOCATIONS_TOO_LARGE");
    }
    String::from_utf8(answer.body).map_err(|_| "E_LICENCE_MALFORMED")
}

/// Downloads the list and applies it; `false` when the licence has no use for one (the build
/// gates nothing, or no licence is held) or the list was older than the kept one. A failure
/// changes nothing. Call it from a blocking task.
pub(crate) fn refresh(
    licence: &Licence,
    site: &str,
    get: &impl Fn(&Get) -> Result<Fetched, &'static str>,
) -> Result<bool, &'static str> {
    if !licence.wants_revocations() {
        return Ok(false);
    }
    licence.apply_revocations(&download(site, get)?)
}

/// What the daily schedule runs: the list from the licence pages, over the system TLS stack and
/// the proxy settings the web client reads from the environment.
pub(crate) fn refresh_from_site(licence: &Licence) {
    match refresh(licence, SITE, &net::get) {
        Ok(_) => {}
        Err(code) => log::warn!("W_LICENCE_REVOCATIONS_FETCH_FAILED {code}"),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::super::testing::{ID, key, licence, sign};
    use super::*;

    fn list(issued_at: &str, ids: &[&str]) -> String {
        sign(
            "devot1rev",
            &json!({ "kid": "test", "issuedAt": issued_at, "ids": ids }),
        )
    }

    fn fetched(status: u16, body: &str) -> Fetched {
        Fetched {
            status,
            content_type: Some("text/plain".into()),
            body: body.as_bytes().to_vec(),
            truncated: false,
        }
    }

    /// A licence held, in a build that gates.
    fn held() -> (tempfile::TempDir, std::sync::Arc<Licence>) {
        let dir = tempfile::tempdir().expect("temp dir");
        let licence = licence(dir.path(), true);
        licence.set(&key(ID, "2027-10-24")).expect("set");
        (dir, licence)
    }

    /// Serves `answers` one connection each on this machine; returns the address and the requests
    /// as read.
    fn serve(answers: Vec<String>) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let site = format!("http://{}", listener.local_addr().expect("addr"));
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let log = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
            for answer in answers {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                log.lock()
                    .expect("log")
                    .push(String::from_utf8_lossy(&request).into_owned());
                let _ = stream.write_all(answer.as_bytes());
            }
        });
        (site, seen)
    }

    fn http(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn the_list_is_the_revoked_path_of_the_licence_site() {
        assert_eq!(list_url(SITE), "https://licence.devot.online/revoked");
        assert!(SITE.starts_with("https://"));
    }

    #[test]
    fn the_site_is_the_one_settings_links_to() {
        let ui = include_str!("../../../src/renderer/src/licence.ts");
        assert!(ui.contains(&format!("export const LICENCE_SITE = '{SITE}'")));
    }

    #[test]
    fn asks_for_the_list_whole_with_nothing_that_says_whose_device_it_is() {
        let (site, requests) = serve(vec![http("200 OK", "list")]);
        let body = download(&site, &net::get_local).expect("downloaded");
        assert_eq!(body, "list");
        let requests = requests.lock().expect("requests");
        let request = &requests[0];
        let mut lines = request.lines();
        assert_eq!(lines.next(), Some("GET /revoked HTTP/1.1"));
        let names: Vec<String> = lines
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once(':'))
            .map(|(name, _)| name.to_ascii_lowercase())
            .collect();
        for name in &names {
            assert!(
                ["host", "user-agent", "accept"].contains(&name.as_str()),
                "{name}"
            );
        }
        assert!(!request.contains(ID));
    }

    #[test]
    fn a_fetched_list_revokes_the_licence_and_an_older_one_is_ignored() {
        let (_dir, licence) = held();
        let newer = list("2026-11-01T00:00:00Z", &[ID]);
        let (site, _) = serve(vec![http("200 OK", &newer)]);
        assert_eq!(refresh(&licence, &site, &net::get_local), Ok(true));
        assert!(licence.revoked().contains(ID));
        assert_eq!(
            licence.snapshot().state,
            super::super::LicenceState::Revoked
        );

        let older = list("2026-10-01T00:00:00Z", &[]);
        let (site, _) = serve(vec![http("200 OK", &older)]);
        assert_eq!(refresh(&licence, &site, &net::get_local), Ok(false));
        assert!(licence.revoked().contains(ID));
    }

    #[test]
    fn a_failure_changes_nothing() {
        let (_dir, licence) = held();
        let good = list("2026-11-01T00:00:00Z", &[ID]);
        let mut tampered = good.clone();
        let last = if tampered.ends_with('A') { 'B' } else { 'A' };
        tampered.pop();
        tampered.push(last);
        let cases = [
            (
                http("503 Service Unavailable", &good),
                "E_LICENCE_REVOCATIONS_STATUS",
            ),
            (http("404 Not Found", ""), "E_LICENCE_REVOCATIONS_STATUS"),
            (http("200 OK", &tampered), "E_LICENCE_SIGNATURE"),
            (http("200 OK", "not a list"), "E_LICENCE_MALFORMED"),
            (
                http("200 OK", &key(ID, "2027-10-24")),
                "E_LICENCE_MALFORMED",
            ),
        ];
        for (answer, code) in cases {
            let (site, _) = serve(vec![answer]);
            let result = refresh(&licence, &site, &net::get_local);
            assert_eq!(result, Err(code));
            assert!(licence.revoked().is_empty(), "{code}");
        }
        let nobody = TcpListener::bind("127.0.0.1:0").expect("bind");
        let site = format!("http://{}", nobody.local_addr().expect("addr"));
        drop(nobody);
        assert!(refresh(&licence, &site, &net::get_local).is_err());
        assert!(licence.revoked().is_empty());
        assert_eq!(licence.snapshot().state, super::super::LicenceState::Valid);
    }

    #[test]
    fn refuses_a_list_too_large_or_not_text() {
        let truncated = Fetched {
            truncated: true,
            ..fetched(200, "x")
        };
        assert_eq!(
            download(SITE, &|_: &Get| Ok(truncated.clone())),
            Err("E_LICENCE_REVOCATIONS_TOO_LARGE")
        );
        let binary = Fetched {
            body: vec![0xff, 0xfe],
            ..fetched(200, "")
        };
        assert_eq!(
            download(SITE, &|_: &Get| Ok(binary.clone())),
            Err("E_LICENCE_MALFORMED")
        );
    }

    #[test]
    fn asks_only_when_the_build_gates_and_a_licence_is_held() {
        let calls = AtomicUsize::new(0);
        let get = |_: &Get| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(fetched(200, &list("2026-11-01T00:00:00Z", &[ID])))
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let no_licence = licence(dir.path(), true);
        assert_eq!(refresh(&no_licence, SITE, &get), Ok(false));

        let dir = tempfile::tempdir().expect("temp dir");
        let ungated = licence(dir.path(), false);
        ungated.set(&key(ID, "2027-10-24")).expect("set");
        assert_eq!(refresh(&ungated, SITE, &get), Ok(false));

        let dir = tempfile::tempdir().expect("temp dir");
        let invalid = licence(dir.path(), true);
        assert!(invalid.set("devot1.nope.nope").is_err());
        assert_eq!(refresh(&invalid, SITE, &get), Ok(false));
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let (_dir, held) = held();
        assert_eq!(refresh(&held, SITE, &get), Ok(true));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_request_asks_for_no_more_than_the_cap_within_the_time_limit() {
        let seen = Mutex::new(None);
        let _ = download(SITE, &|get: &Get| {
            *seen.lock().expect("seen") = Some((
                get.url.as_str().to_owned(),
                get.headers.len(),
                get.max_bytes,
                get.timeout,
            ));
            Ok(fetched(200, "x"))
        });
        let seen = seen.lock().expect("seen").clone().expect("asked");
        assert_eq!(seen.0, "https://licence.devot.online/revoked");
        assert_eq!(seen.1, 0);
        assert_eq!(seen.2, MAX_BYTES);
        assert_eq!(seen.3, TIMEOUT);
    }
}
