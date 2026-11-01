//! Asking the licence Worker for this device's seat (docs/licensing.md, Activation). The key
//! travels in the request body, never a URL, and nothing but the licence ID and the device's random
//! ID is logged. Call it from a blocking task.

use std::time::Duration;

use serde::Deserialize;
use tauri::Url;

use super::revoked::SITE;
use crate::net::{self, Fetched, Post};

const MAX_BYTES: usize = 8 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    pub lease: String,
    pub used: u32,
    pub limit: u32,
}

fn activate_url(site: &str) -> String {
    format!("{site}/activate")
}

fn parse(answer: &Fetched) -> Result<Reply, &'static str> {
    match answer.status {
        200 => {}
        409 => return Err("E_LICENCE_DEVICE_LIMIT"),
        410 => return Err("E_LICENCE_REVOKED"),
        429 => return Err("E_LICENCE_RATE_LIMITED"),
        400..=499 => return Err("E_LICENCE_ACTIVATION_REFUSED"),
        _ => return Err("E_LICENCE_ACTIVATION_FAILED"),
    }
    if answer.truncated {
        return Err("E_LICENCE_ACTIVATION_FAILED");
    }
    let reply: Reply =
        serde_json::from_slice(&answer.body).map_err(|_| "E_LICENCE_ACTIVATION_FAILED")?;
    if reply.lease.len() > 1024 || reply.lease.len() < 16 {
        return Err("E_LICENCE_ACTIVATION_FAILED");
    }
    Ok(reply)
}

/// `post` is `net::post`, or the tests' server on this machine.
pub(crate) fn activate(
    site: &str,
    key: &str,
    device: &str,
    label: &str,
    post: &impl Fn(&Post) -> Result<Fetched, &'static str>,
) -> Result<Reply, &'static str> {
    let url = Url::parse(&activate_url(site)).map_err(|_| "E_URL_INVALID")?;
    let body = serde_json::json!({ "key": key, "device": device, "label": label }).to_string();
    let answer = post(&Post {
        url: &url,
        accept: "application/json",
        content_type: "application/json",
        body: &body,
        timeout: TIMEOUT,
        max_bytes: MAX_BYTES,
    })?;
    parse(&answer)
}

/// What the daily schedule and Settings > Licence run: the seat from the licence pages.
pub(crate) fn activate_from_site(
    key: &str,
    device: &str,
    label: &str,
) -> Result<Reply, &'static str> {
    activate(SITE, key, device, label, &net::post)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    use super::*;

    /// Serves one answer on this machine and returns its address with what was asked.
    fn serve(status: &str, body: &str) -> (String, std::sync::Arc<Mutex<String>>) {
        let (status, body) = (status.to_owned(), body.to_owned());
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = format!("http://{}", listener.local_addr().expect("address"));
        let seen = std::sync::Arc::new(Mutex::new(String::new()));
        let recorded = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while let Ok(read) = stream.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(length) = text
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .and_then(|n| n.trim().parse::<usize>().ok())
                        && request.len() >= text.find("\r\n\r\n").unwrap_or(0) + 4 + length
                    {
                        break;
                    }
                }
            }
            *recorded.lock().expect("record") = String::from_utf8_lossy(&request).to_string();
            let answer = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(answer.as_bytes());
        });
        (address, seen)
    }

    #[test]
    fn asks_with_the_key_in_the_body_and_reads_the_lease() {
        let (site, seen) = serve(
            "200 OK",
            r#"{"lease":"devot1dev.abc.def","used":2,"limit":3}"#,
        );
        let reply = activate(
            &site,
            "devot1.key.sig",
            "device-id",
            "Mac",
            &net::post_local,
        )
        .expect("activated");
        assert_eq!(reply.lease, "devot1dev.abc.def");
        assert_eq!(reply.used, 2);
        assert_eq!(reply.limit, 3);
        let request = seen.lock().expect("record").clone();
        assert!(request.starts_with("POST /activate "), "{request}");
        assert!(request.contains("\"key\":\"devot1.key.sig\""), "{request}");
        assert!(request.contains("\"device\":\"device-id\""), "{request}");
    }

    #[test]
    fn maps_the_worker_refusals_to_codes() {
        for (status, code) in [
            ("409 Conflict", "E_LICENCE_DEVICE_LIMIT"),
            ("410 Gone", "E_LICENCE_REVOKED"),
            ("429 Too Many Requests", "E_LICENCE_RATE_LIMITED"),
            ("400 Bad Request", "E_LICENCE_ACTIVATION_REFUSED"),
            ("500 Internal Server Error", "E_LICENCE_ACTIVATION_FAILED"),
        ] {
            let (site, _) = serve(status, "{}");
            assert_eq!(
                activate(&site, "k", "d", "Mac", &net::post_local).map(|_| ()),
                Err(code),
                "{status}"
            );
        }
    }
}
