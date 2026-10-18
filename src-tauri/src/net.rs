//! Outbound web requests: the one small blocking client every feature that
//! fetches from the web goes through (link titles, GitHub snippets, and
//! later provider calls). https only, redirects included (ureq checks every
//! hop), at most a few redirects, one time cap for the whole call, and a cap
//! on the bytes read. The same TLS stack as the crash reporter. Errors are
//! codes, never URLs. Call it from a blocking task, never the main thread.

use std::io::Read;
use std::time::Duration;
use tauri::Url;

/// The longest URL Devot sends a request to.
pub const MAX_URL_LEN: usize = 2048;
/// Redirects a request follows at most, each to https only.
pub const MAX_REDIRECTS: u32 = 5;
const USER_AGENT: &str = concat!("devot/", env!("CARGO_PKG_VERSION"));

/// One GET.
pub struct Get<'a> {
    pub url: &'a Url,
    /// The `Accept` header.
    pub accept: &'a str,
    /// More headers, sent as they are.
    pub headers: &'a [(&'a str, &'a str)],
    /// The whole call, from the DNS lookup to the last byte read.
    pub timeout: Duration,
    /// The most body bytes read; the rest is never downloaded.
    pub max_bytes: usize,
}

/// What came back. Any status: the caller decides what a 404 means.
#[derive(Debug)]
pub struct Fetched {
    pub status: u16,
    /// The `Content-Type` header, lower-cased.
    pub content_type: Option<String>,
    pub body: Vec<u8>,
    /// The body went on past `max_bytes`.
    pub truncated: bool,
}

/// A plain https URL with a host and no credentials, of reasonable length.
pub fn https_url(url: &str) -> Result<Url, &'static str> {
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

fn error_code(error: &ureq::Error) -> &'static str {
    match error {
        ureq::Error::Timeout(_) => "E_NET_TIMEOUT",
        ureq::Error::RequireHttpsOnly(_) => "E_NET_HTTPS_ONLY",
        ureq::Error::TooManyRedirects => "E_NET_TOO_MANY_REDIRECTS",
        _ => "E_NET_FAILED",
    }
}

/// Sends `get` and reads at most `max_bytes` of the answer.
pub fn get(get: &Get) -> Result<Fetched, &'static str> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .build(),
        )
        .https_only(true)
        .max_redirects(MAX_REDIRECTS)
        .timeout_global(Some(get.timeout))
        .http_status_as_error(false)
        .build()
        .into();
    let mut request = agent
        .get(get.url.as_str())
        .header("User-Agent", USER_AGENT)
        .header("Accept", get.accept);
    for (name, value) in get.headers {
        request = request.header(*name, *value);
    }
    let mut response = request.call().map_err(|e| error_code(&e))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase);
    let mut body = Vec::new();
    let limit = u64::try_from(get.max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    response
        .body_mut()
        .as_reader()
        .take(limit)
        .read_to_end(&mut body)
        .map_err(|_| "E_NET_FAILED")?;
    let truncated = body.len() > get.max_bytes;
    body.truncate(get.max_bytes);
    Ok(Fetched {
        status,
        content_type,
        body,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_only_plain_https_urls() {
        assert!(https_url("https://example.com/a?b=1#c").is_ok());
        assert_eq!(
            https_url("http://example.com/").unwrap_err(),
            "E_URL_SCHEME_REFUSED"
        );
        assert_eq!(
            https_url("file:///etc/hosts").unwrap_err(),
            "E_URL_SCHEME_REFUSED"
        );
        assert_eq!(https_url("not a url").unwrap_err(), "E_URL_INVALID");
        assert_eq!(
            https_url("https://user:pw@example.com/").unwrap_err(),
            "E_URL_CREDENTIALS_REFUSED"
        );
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(https_url(&long).unwrap_err(), "E_URL_TOO_LONG");
    }

    #[test]
    fn refuses_http_on_every_hop_before_connecting() {
        // The agent checks the scheme of every request it sends, redirects
        // included, before it connects: an http URL fails without a socket.
        let url = Url::parse("http://127.0.0.1:9/").unwrap();
        let result = get(&Get {
            url: &url,
            accept: "*/*",
            headers: &[],
            timeout: Duration::from_secs(1),
            max_bytes: 10,
        });
        assert_eq!(result.unwrap_err(), "E_NET_HTTPS_ONLY");
    }
}
