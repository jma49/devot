//! Asking the licence Worker for this device's seat (docs/licensing.md, Activation), and for the
//! Mac licence key of an App Store purchase (docs/licensing.md, The App Store). Keys and Apple's
//! signed transactions travel in request bodies, never a URL, and nothing but licence IDs and the
//! device's random ID is logged. Call it from a blocking task.

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Url;

use super::format::{APP_STORE_LICENSEE, MAX_LENGTH, read_licence};
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

/// The Mac licence key the Worker gave for this Apple account's Devot Pro purchase. `Debug` shows
/// the licence ID alone.
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct MacKey {
    pub key: String,
    pub id: String,
}

impl fmt::Debug for MacKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MacKey")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// The Worker's refusals the iPhone tells apart; any other is refused or failed, by its status.
const EXCHANGE_CODES: [&str; 10] = [
    "E_LICENCE_REVOKED",
    "E_LICENCE_RATE_LIMITED",
    "E_LICENCE_CONFIG",
    "E_APP_STORE_PRODUCT",
    "E_APP_STORE_FAMILY_SHARED",
    "E_APP_STORE_NOT_FOUND",
    "E_APP_STORE_MISMATCH",
    "E_APP_STORE_SIGNATURE",
    "E_APP_STORE_UNREACHABLE",
    "E_APP_STORE_UPSTREAM",
];
const EXCHANGE_FAILED: &str = "E_APP_STORE_EXCHANGE_FAILED";

fn refused(answer: &Fetched) -> &'static str {
    #[derive(Deserialize)]
    struct Refusal {
        code: String,
    }
    let named = serde_json::from_slice::<Refusal>(&answer.body)
        .ok()
        .and_then(|refusal| {
            EXCHANGE_CODES
                .into_iter()
                .find(|code| *code == refusal.code)
        });
    named.unwrap_or(match answer.status {
        429 => "E_LICENCE_RATE_LIMITED",
        400..=499 => "E_APP_STORE_EXCHANGE_REFUSED",
        _ => EXCHANGE_FAILED,
    })
}

/// A key the Worker made for an App Store purchase: shaped as one, for the licence it names. Its
/// signature is the Mac's to check.
fn parse_exchange(answer: &Fetched) -> Result<MacKey, &'static str> {
    if answer.status != 200 {
        return Err(refused(answer));
    }
    if answer.truncated {
        return Err(EXCHANGE_FAILED);
    }
    let reply: MacKey = serde_json::from_slice(&answer.body).map_err(|_| EXCHANGE_FAILED)?;
    if reply.key.len() > MAX_LENGTH {
        return Err(EXCHANGE_FAILED);
    }
    let payload = read_licence(&reply.key).ok_or(EXCHANGE_FAILED)?;
    if payload.id != reply.id || payload.licensee != APP_STORE_LICENSEE {
        return Err(EXCHANGE_FAILED);
    }
    Ok(reply)
}

/// `post` is `net::post`, or the tests' server on this machine.
pub(crate) fn exchange(
    site: &str,
    transaction: &str,
    post: &impl Fn(&Post) -> Result<Fetched, &'static str>,
) -> Result<MacKey, &'static str> {
    let url = Url::parse(&format!("{site}/app-store/exchange")).map_err(|_| "E_URL_INVALID")?;
    let body = serde_json::json!({ "transaction": transaction }).to_string();
    let answer = post(&Post {
        url: &url,
        accept: "application/json",
        content_type: "application/json",
        body: &body,
        timeout: TIMEOUT,
        max_bytes: MAX_BYTES,
    })?;
    parse_exchange(&answer)
}

pub(crate) fn exchange_from_site(transaction: &str) -> Result<MacKey, &'static str> {
    exchange(SITE, transaction, &net::post)
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

    use super::super::testing::{ID, key, sign};
    use super::*;

    fn app_store_key(id: &str) -> String {
        sign(
            "devot1",
            &serde_json::json!({
                "id": id,
                "kid": "test",
                "plan": "pro",
                "licensee": APP_STORE_LICENSEE,
                "issuedAt": "2026-11-05T09:30:00Z",
            }),
        )
    }

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

    #[test]
    fn sends_the_signed_transaction_in_the_body_and_reads_the_purchases_key() {
        let issued = app_store_key(ID);
        let (site, seen) = serve(
            "200 OK",
            &serde_json::json!({ "key": issued, "id": ID }).to_string(),
        );
        let reply = exchange(&site, "header.payload.signature", &net::post_local).expect("key");
        assert_eq!(
            reply,
            MacKey {
                key: issued.clone(),
                id: ID.to_owned()
            }
        );
        assert!(!format!("{reply:?}").contains(&issued));
        let request = seen.lock().expect("record").clone();
        assert!(
            request.starts_with("POST /app-store/exchange "),
            "{request}"
        );
        assert!(
            request.contains(r#"{"transaction":"header.payload.signature"}"#),
            "{request}"
        );
    }

    #[test]
    fn takes_only_a_key_for_the_licence_it_names_made_for_an_app_store_purchase() {
        let other = "AAAAAAAAAAAAAAAAAAAAAA";
        for (issued, id) in [
            (app_store_key(other), ID),
            (key(ID), ID),
            ("devot1.not-a-key.x".to_owned(), ID),
            (
                format!("{}{}", app_store_key(ID), "A".repeat(MAX_LENGTH)),
                ID,
            ),
        ] {
            let (site, _) = serve(
                "200 OK",
                &serde_json::json!({ "key": issued, "id": id }).to_string(),
            );
            assert_eq!(
                exchange(&site, "jws", &net::post_local),
                Err("E_APP_STORE_EXCHANGE_FAILED")
            );
        }
        let (site, _) = serve("200 OK", r#"{"lease":"x"}"#);
        assert_eq!(
            exchange(&site, "jws", &net::post_local),
            Err("E_APP_STORE_EXCHANGE_FAILED")
        );
    }

    #[test]
    fn names_the_workers_refusal_by_its_code_or_its_status() {
        for (status, body, code) in [
            (
                "410 Gone",
                r#"{"code":"E_LICENCE_REVOKED"}"#,
                "E_LICENCE_REVOKED",
            ),
            (
                "403 Forbidden",
                r#"{"code":"E_APP_STORE_FAMILY_SHARED"}"#,
                "E_APP_STORE_FAMILY_SHARED",
            ),
            (
                "403 Forbidden",
                r#"{"code":"E_APP_STORE_PRODUCT"}"#,
                "E_APP_STORE_PRODUCT",
            ),
            (
                "409 Conflict",
                r#"{"code":"E_APP_STORE_MISMATCH"}"#,
                "E_APP_STORE_MISMATCH",
            ),
            (
                "503 Service Unavailable",
                r#"{"code":"E_APP_STORE_UNREACHABLE"}"#,
                "E_APP_STORE_UNREACHABLE",
            ),
            (
                "503 Service Unavailable",
                r#"{"code":"E_APP_STORE_UPSTREAM"}"#,
                "E_APP_STORE_UPSTREAM",
            ),
            ("429 Too Many Requests", "{}", "E_LICENCE_RATE_LIMITED"),
            (
                "400 Bad Request",
                r#"{"code":"E_SOMETHING_NEW"}"#,
                "E_APP_STORE_EXCHANGE_REFUSED",
            ),
            ("502 Bad Gateway", "<html>", "E_APP_STORE_EXCHANGE_FAILED"),
        ] {
            let (site, _) = serve(status, body);
            assert_eq!(
                exchange(&site, "jws", &net::post_local),
                Err(code),
                "{status} {body}"
            );
        }
    }

    #[test]
    fn the_app_store_licensee_is_the_workers() {
        let worker = include_str!("../../../licence/src/format.ts");
        assert!(worker.contains(&format!(
            "export const APP_STORE_LICENSEE = '{APP_STORE_LICENSEE}'"
        )));
        let ui = include_str!("../../../src/renderer/src/licence.ts");
        assert!(ui.contains(&format!(
            "export const APP_STORE_LICENSEE = '{APP_STORE_LICENSEE}'"
        )));
    }
}
