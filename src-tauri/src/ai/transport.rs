//! Redirects and proxies are refused so a key goes only to the endpoint the user set.

use std::io::Read;
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
}
