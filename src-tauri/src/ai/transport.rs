//! Redirects and proxies are refused so a key goes only to the endpoint the user set.

use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

use super::provider::WireRequest;

pub const TIMEOUT: Duration = Duration::from_secs(180);
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const USER_AGENT: &str = concat!("devot/", env!("CARGO_PKG_VERSION"));

pub struct Answer {
    pub status: u16,
    pub body: Vec<u8>,
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .build(),
        )
        .max_redirects(0)
        .proxy(None)
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into()
}

/// Call it from a blocking task, never the main thread.
pub fn post(request: &WireRequest, timeout: Duration) -> Result<Answer, &'static str> {
    let agent = agent(timeout);
    let mut call = agent.post(&request.url).header("User-Agent", USER_AGENT);
    for (name, value) in &request.headers {
        call = call.header(*name, value.as_str());
    }
    let mut response = call.send(&request.body[..]).map_err(|e| match e {
        ureq::Error::Timeout(_) => "E_AI_TIMEOUT",
        _ => "E_AI_NETWORK_FAILED",
    })?;
    let status = response.status().as_u16();
    let limit = u64::try_from(MAX_RESPONSE_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(limit)
        .read_to_end(&mut body)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut {
                "E_AI_TIMEOUT"
            } else {
                "E_AI_NETWORK_FAILED"
            }
        })?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err("E_AI_RESPONSE_TOO_LARGE");
    }
    Ok(Answer { status, body })
}

/// One server-sent event line is never longer than this; a longer one is a broken stream.
pub const MAX_EVENT_BYTES: usize = 1024 * 1024;

pub enum Streamed {
    /// The status was 2xx and every event went to `on_data`.
    Done,
    /// The status was not 2xx; the body is read and dropped, since it can quote the prompt.
    Status(u16),
}

fn read_failed(e: &std::io::Error) -> &'static str {
    if e.kind() == std::io::ErrorKind::TimedOut {
        "E_AI_TIMEOUT"
    } else {
        "E_AI_NETWORK_FAILED"
    }
}

/// Sends `request` and hands `on_data` the data of each server-sent event as it arrives, until the stream ends or `on_data` says stop (false).
/// Call it from a blocking task, never the main thread.
pub fn post_stream(
    request: &WireRequest,
    timeout: Duration,
    mut on_data: impl FnMut(&str) -> Result<bool, &'static str>,
) -> Result<Streamed, &'static str> {
    let agent = agent(timeout);
    let mut call = agent
        .post(&request.url)
        .header("User-Agent", USER_AGENT)
        .header("accept", "text/event-stream");
    for (name, value) in &request.headers {
        call = call.header(*name, value.as_str());
    }
    let mut response = call.send(&request.body[..]).map_err(|e| match e {
        ureq::Error::Timeout(_) => "E_AI_TIMEOUT",
        _ => "E_AI_NETWORK_FAILED",
    })?;
    let status = response.status().as_u16();
    let limit = u64::try_from(MAX_RESPONSE_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut reader = BufReader::new(response.body_mut().as_reader().take(limit));
    if !(200..300).contains(&status) {
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
        return Ok(Streamed::Status(status));
    }
    let mut total = 0usize;
    let mut line = Vec::new();
    loop {
        line.clear();
        let event_limit = u64::try_from(MAX_EVENT_BYTES + 1).unwrap_or(u64::MAX);
        let n = (&mut reader)
            .take(event_limit)
            .read_until(b'\n', &mut line)
            .map_err(|e| read_failed(&e))?;
        if n == 0 {
            return Ok(Streamed::Done);
        }
        total += n;
        if total > MAX_RESPONSE_BYTES {
            return Err("E_AI_RESPONSE_TOO_LARGE");
        }
        if n > MAX_EVENT_BYTES {
            return Err("E_AI_RESPONSE_INVALID");
        }
        let text = std::str::from_utf8(&line).map_err(|_| "E_AI_RESPONSE_INVALID")?;
        let Some(data) = sse_data(text) else { continue };
        if !on_data(data)? {
            return Ok(Streamed::Done);
        }
    }
}

/// The data of a `data:` line; other fields (`event:`, `id:`, comments) carry nothing a provider needs.
pub fn sse_data(line: &str) -> Option<&str> {
    let line = line.trim_end_matches(['\r', '\n']);
    let data = line.strip_prefix("data:")?;
    Some(data.strip_prefix(' ').unwrap_or(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHILD: &str = "DEVOT_TEST_PROXY_CHILD";

    #[test]
    fn proxy_variables_are_ignored() {
        if std::env::var_os(CHILD).is_some() {
            assert!(agent(TIMEOUT).config().proxy().is_none());
            return;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ai::transport::tests::proxy_variables_are_ignored",
            ])
            .env(CHILD, "1")
            .env("ALL_PROXY", "http://127.0.0.1:9")
            .env("HTTP_PROXY", "http://127.0.0.1:9")
            .env("HTTPS_PROXY", "http://127.0.0.1:9")
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn only_data_lines_carry_an_event() {
        assert_eq!(sse_data("data: {\"a\":1}\r\n"), Some("{\"a\":1}"));
        assert_eq!(sse_data("data:[DONE]\n"), Some("[DONE]"));
        assert_eq!(sse_data("event: message_start\n"), None);
        assert_eq!(sse_data(": keep-alive\n"), None);
        assert_eq!(sse_data("\n"), None);
    }
}
