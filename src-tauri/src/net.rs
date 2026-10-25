//! Outbound web requests: the one small blocking client every feature that fetches from the web goes through. https only and public hosts only, redirects included (each hop is checked), with a time cap for the whole call and a cap on the bytes read. Errors are codes, never URLs. Call it from a blocking task, never the main thread.

use std::io::Read;
use std::time::{Duration, Instant};
use tauri::Url;

pub const MAX_URL_LEN: usize = 2048;
pub const MAX_REDIRECTS: u32 = 5;
const USER_AGENT: &str = concat!("devot/", env!("CARGO_PKG_VERSION"));

pub struct Get<'a> {
    pub url: &'a Url,
    pub accept: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    /// The whole call, from the DNS lookup to the last byte read.
    pub timeout: Duration,
    pub max_bytes: usize,
}

/// Any status: the caller decides what a 404 means.
#[derive(Debug, Clone)]
pub struct Fetched {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
    pub truncated: bool,
}

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

fn public_host(url: &Url) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr};
    let v4 = |ip: Ipv4Addr| {
        let [a, b, ..] = ip.octets();
        !(ip.is_loopback()
            || ip.is_private()
            || ip.is_link_local()
            || ip.is_unspecified()
            || ip.is_broadcast()
            || a == 0
            // Carrier-grade NAT, 100.64.0.0/10.
            || (a == 100 && (64..128).contains(&b)))
    };
    let v6 = |ip: Ipv6Addr| {
        let first = ip.segments()[0];
        match ip.to_ipv4_mapped() {
            Some(mapped) => v4(mapped),
            None => {
                !(ip.is_loopback()
                    || ip.is_unspecified()
                    // Unique local fc00::/7 and link-local fe80::/10.
                    || (first & 0xfe00) == 0xfc00
                    || (first & 0xffc0) == 0xfe80)
            }
        }
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => v4(ip),
        Ok(std::net::IpAddr::V6(ip)) => v6(ip),
        Err(_) => {
            let name = host.trim_end_matches('.').to_ascii_lowercase();
            !(name.is_empty()
                || name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local"))
        }
    }
}

fn redirect_target(
    from: &Url,
    status: u16,
    location: Option<&str>,
) -> Option<Result<Url, &'static str>> {
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    let Some(location) = location else {
        return Some(Err("E_NET_FAILED"));
    };
    Some(
        from.join(location)
            .map_err(|_| "E_NET_FAILED")
            .and_then(|next| https_url(next.as_str())),
    )
}

pub fn get(get: &Get) -> Result<Fetched, &'static str> {
    fetch(get, true)
}

/// Tests reach a server on this machine, over plain http.
#[cfg(test)]
pub fn get_local(get: &Get) -> Result<Fetched, &'static str> {
    fetch(get, false)
}

fn fetch(get: &Get, strict: bool) -> Result<Fetched, &'static str> {
    let deadline = Instant::now() + get.timeout;
    let mut url = get.url.clone();
    for _ in 0..=MAX_REDIRECTS {
        if strict && !public_host(&url) {
            return Err("E_NET_HOST_REFUSED");
        }
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or("E_NET_TIMEOUT")?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .provider(ureq::tls::TlsProvider::NativeTls)
                    .build(),
            )
            .https_only(strict)
            .max_redirects(0)
            .timeout_global(Some(left))
            .http_status_as_error(false)
            .build()
            .into();
        let mut request = agent
            .get(url.as_str())
            .header("User-Agent", USER_AGENT)
            .header("Accept", get.accept);
        for (name, value) in get.headers {
            request = request.header(*name, *value);
        }
        let mut response = request.call().map_err(|e| error_code(&e))?;
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        if let Some(next) = redirect_target(&url, status, header("location").as_deref()) {
            url = next?;
            continue;
        }
        let content_type = header("content-type").map(|t| t.to_ascii_lowercase());
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
        return Ok(Fetched {
            status,
            content_type,
            body,
            truncated,
        });
    }
    Err("E_NET_TOO_MANY_REDIRECTS")
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
    fn refuses_hosts_on_this_machine_or_the_local_network() {
        for url in [
            "https://localhost/",
            "https://app.localhost/",
            "https://printer.local/",
            "https://127.0.0.1/",
            "https://10.0.0.1/",
            "https://172.16.5.4/",
            "https://192.168.1.1/",
            "https://169.254.169.254/",
            "https://100.64.0.1/",
            "https://0.0.0.0/",
            "https://[::1]/",
            "https://[fd00::1]/",
            "https://[fe80::1]/",
            "https://[::ffff:192.168.1.1]/",
        ] {
            assert!(!public_host(&Url::parse(url).unwrap()), "{url}");
            let result = get(&Get {
                url: &Url::parse(url).unwrap(),
                accept: "*/*",
                headers: &[],
                timeout: Duration::from_secs(1),
                max_bytes: 10,
            });
            assert_eq!(result.unwrap_err(), "E_NET_HOST_REFUSED", "{url}");
        }
        for url in [
            "https://example.com/",
            "https://8.8.8.8/",
            "https://[2001:db8::1]/",
        ] {
            assert!(public_host(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn checks_every_redirect_target() {
        let from = Url::parse("https://example.com/a/b").unwrap();
        assert!(redirect_target(&from, 200, Some("/x")).is_none());
        assert_eq!(
            redirect_target(&from, 302, Some("c"))
                .unwrap()
                .unwrap()
                .as_str(),
            "https://example.com/a/c"
        );
        assert_eq!(
            redirect_target(&from, 301, Some("http://example.com/"))
                .unwrap()
                .unwrap_err(),
            "E_URL_SCHEME_REFUSED"
        );
        assert_eq!(
            redirect_target(&from, 307, Some("https://u:p@example.com/"))
                .unwrap()
                .unwrap_err(),
            "E_URL_CREDENTIALS_REFUSED"
        );
        assert_eq!(
            redirect_target(&from, 308, None).unwrap().unwrap_err(),
            "E_NET_FAILED"
        );
    }

    #[test]
    fn refuses_http_on_every_hop_before_connecting() {
        let url = Url::parse("http://93.184.215.14:9/").unwrap();
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
