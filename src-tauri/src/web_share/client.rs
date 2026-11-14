//! The share Worker's routes (docs/specs/share-on-web.md, The Worker). `send` is `net::send`, or
//! the tests' server on this machine. Errors are codes; no token or page bytes reach a log.

use std::time::Duration;

use crate::net::{Fetched, Method, Request};

pub type Sender<'a> = &'a dyn Fn(&Request) -> Result<Fetched, &'static str>;

pub const LIFETIMES: [u8; 3] = [1, 7, 30];
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REPLY_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub id: String,
    pub token: String,
    pub expires_at: i64,
}

fn plain(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn valid_id(id: &str) -> bool {
    plain(id, 22)
}

pub fn valid_token(token: &str) -> bool {
    plain(token, 43)
}

/// `net::send` refuses anything but https to a public host; the tests' sender takes http.
fn url(host: &str, path: &str) -> Result<tauri::Url, &'static str> {
    tauri::Url::parse(&format!("{host}{path}")).map_err(|_| "E_SHARE_URL_INVALID")
}

fn refused(reply: &Fetched) -> &'static str {
    match reply.status {
        404 => "E_SHARE_NOT_FOUND",
        413 => "E_SHARE_TOO_LARGE",
        429 => "E_SHARE_RATE_LIMITED",
        _ => "E_SHARE_REFUSED",
    }
}

pub fn create(
    host: &str,
    envelope: &[u8],
    lifetime: u8,
    send: Sender,
) -> Result<Created, &'static str> {
    if !LIFETIMES.contains(&lifetime) {
        return Err("E_SHARE_LIFETIME_INVALID");
    }
    let url = url(host, "/v1/shares")?;
    let days = lifetime.to_string();
    let reply = send(&Request {
        method: Method::Post,
        url: &url,
        accept: "application/json",
        content_type: "application/octet-stream",
        headers: &[("Devot-Lifetime", days.as_str())],
        body: envelope,
        timeout: TIMEOUT,
        max_bytes: MAX_REPLY_BYTES,
    })?;
    if reply.status != 201 {
        return Err(refused(&reply));
    }
    let created: Created =
        serde_json::from_slice(&reply.body).map_err(|_| "E_SHARE_REPLY_INVALID")?;
    if !valid_id(&created.id) || !valid_token(&created.token) || created.expires_at <= 0 {
        return Err("E_SHARE_REPLY_INVALID");
    }
    Ok(created)
}

fn owned(
    host: &str,
    method: Method,
    id: &str,
    token: &str,
    envelope: &[u8],
    send: Sender,
) -> Result<Fetched, &'static str> {
    if !valid_id(id) || !valid_token(token) {
        return Err("E_SHARE_RECORD_INVALID");
    }
    let url = url(host, &format!("/v1/shares/{id}"))?;
    let bearer = format!("Bearer {token}");
    send(&Request {
        method,
        url: &url,
        accept: "application/json",
        content_type: "application/octet-stream",
        headers: &[("Authorization", bearer.as_str())],
        body: envelope,
        timeout: TIMEOUT,
        max_bytes: MAX_REPLY_BYTES,
    })
}

pub fn update(
    host: &str,
    id: &str,
    token: &str,
    envelope: &[u8],
    send: Sender,
) -> Result<(), &'static str> {
    let reply = owned(host, Method::Put, id, token, envelope, send)?;
    if reply.status == 204 {
        Ok(())
    } else {
        Err(refused(&reply))
    }
}

/// A page already gone (expired or deleted elsewhere) counts as stopped.
pub fn delete(host: &str, id: &str, token: &str, send: Sender) -> Result<(), &'static str> {
    let reply = owned(host, Method::Delete, id, token, &[], send)?;
    match reply.status {
        204 | 404 => Ok(()),
        _ => Err(refused(&reply)),
    }
}

pub fn link(host: &str, id: &str, key: &str) -> String {
    format!("{host}/s/{id}#{key}")
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::net;

    const ID: &str = "AAAAAAAAAAAAAAAAAAAAAA";
    const TOKEN: &str = "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT";

    /// Serves one answer on this machine and returns its address with what was asked.
    fn serve(status: &str, body: &str) -> (String, Arc<Mutex<Vec<u8>>>) {
        let (status, body) = (status.to_owned(), body.to_owned());
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = format!("http://{}", listener.local_addr().expect("address"));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&seen);
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stream.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                let length = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .and_then(|n| n.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            *recorded.lock().expect("record") = request;
            let answer = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(answer.as_bytes());
        });
        (address, seen)
    }

    fn text(seen: &Arc<Mutex<Vec<u8>>>) -> String {
        String::from_utf8_lossy(&seen.lock().expect("record")).to_string()
    }

    #[test]
    fn creates_with_the_lifetime_and_the_envelope_and_reads_the_reply() {
        let reply = format!(r#"{{"id":"{ID}","token":"{TOKEN}","expiresAt":1767225600000}}"#);
        let (host, seen) = serve("201 Created", &reply);
        let created = create(&host, b"DVS1sealed", 7, &net::send_local).expect("created");
        assert_eq!(
            created,
            Created {
                id: ID.into(),
                token: TOKEN.into(),
                expires_at: 1_767_225_600_000
            }
        );
        let request = text(&seen).to_ascii_lowercase();
        assert!(request.starts_with("post /v1/shares "), "{request}");
        assert!(request.contains("devot-lifetime: 7"), "{request}");
        assert!(
            request.contains("content-type: application/octet-stream"),
            "{request}"
        );
        assert!(request.ends_with("dvs1sealed"), "{request}");
    }

    #[test]
    fn refuses_a_lifetime_the_worker_does_not_offer_before_sending() {
        let never: Sender = &|_| panic!("sent");
        for lifetime in [0, 2, 31] {
            assert_eq!(
                create("https://share.test", b"x", lifetime, never).err(),
                Some("E_SHARE_LIFETIME_INVALID")
            );
        }
    }

    #[test]
    fn refuses_a_reply_that_is_not_a_share() {
        for body in [
            "not json",
            r#"{"id":"short","token":"TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT","expiresAt":1}"#,
            r#"{"id":"AAAAAAAAAAAAAAAAAAAAAA","token":"t","expiresAt":1}"#,
            r#"{"id":"AAAAAAAAAAAAAAAAAAAAAA","token":"TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT","expiresAt":0}"#,
        ] {
            let (host, _) = serve("201 Created", body);
            assert_eq!(
                create(&host, b"DVS1", 1, &net::send_local).err(),
                Some("E_SHARE_REPLY_INVALID"),
                "{body}"
            );
        }
    }

    #[test]
    fn maps_the_worker_refusals_to_codes() {
        for (status, code) in [
            ("413 Payload Too Large", "E_SHARE_TOO_LARGE"),
            ("429 Too Many Requests", "E_SHARE_RATE_LIMITED"),
            ("400 Bad Request", "E_SHARE_REFUSED"),
            ("500 Internal Server Error", "E_SHARE_REFUSED"),
        ] {
            let (host, _) = serve(status, "{}");
            assert_eq!(
                create(&host, b"DVS1", 30, &net::send_local).err(),
                Some(code)
            );
        }
    }

    #[test]
    fn updates_and_deletes_with_the_token_as_a_bearer() {
        let (host, seen) = serve("204 No Content", "");
        update(&host, ID, TOKEN, b"DVS1next", &net::send_local).expect("updated");
        let request = text(&seen);
        assert!(
            request.starts_with(&format!("PUT /v1/shares/{ID} ")),
            "{request}"
        );
        assert!(request.contains(&format!("Bearer {TOKEN}")), "{request}");
        assert!(request.ends_with("DVS1next"), "{request}");

        let (host, seen) = serve("204 No Content", "");
        delete(&host, ID, TOKEN, &net::send_local).expect("deleted");
        assert!(text(&seen).starts_with(&format!("DELETE /v1/shares/{ID} ")));
    }

    #[test]
    fn counts_a_page_already_gone_as_stopped_but_not_as_updated() {
        let (host, _) = serve("404 Not Found", r#"{"error":"E_SHARE_NOT_FOUND"}"#);
        assert_eq!(delete(&host, ID, TOKEN, &net::send_local), Ok(()));
        let (host, _) = serve("404 Not Found", r#"{"error":"E_SHARE_NOT_FOUND"}"#);
        assert_eq!(
            update(&host, ID, TOKEN, b"DVS1", &net::send_local).err(),
            Some("E_SHARE_NOT_FOUND")
        );
    }

    #[test]
    fn sends_nothing_for_a_malformed_id_or_token() {
        let never: Sender = &|_| panic!("sent");
        assert_eq!(
            delete("https://share.test", "../x", TOKEN, never).err(),
            Some("E_SHARE_RECORD_INVALID")
        );
        assert_eq!(
            update("https://share.test", ID, "short", b"", never).err(),
            Some("E_SHARE_RECORD_INVALID")
        );
    }

    #[test]
    fn links_to_the_viewer_with_the_key_in_the_fragment() {
        assert_eq!(
            link("https://share.devot.online", ID, "k"),
            format!("https://share.devot.online/s/{ID}#k")
        );
    }
}
