//! The macOS system proxy (System Settings > Network > Proxies) for `net`: the explicit HTTPS
//! proxy and its bypass list. An automatic configuration (a PAC file or auto-discovery) is not
//! followed, and with only that on requests go direct: running it needs a JavaScript engine on a
//! run loop and a fetch of the script itself, usually from the local network `net` refuses.

use std::collections::HashMap;
use std::net::IpAddr;

// Only the macOS reader builds these; elsewhere `system()` answers no settings.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Value {
    Number(i64),
    Text(String),
    List(Vec<String>),
}

/// The proxy dictionary as SystemConfiguration answers it, keyed by its own names.
pub(crate) type Settings = HashMap<String, Value>;

#[cfg(target_os = "macos")]
const KEYS: [&str; 5] = [
    "HTTPSEnable",
    "HTTPSProxy",
    "HTTPSPort",
    "ExceptionsList",
    "ExcludeSimpleHostnames",
];

fn number(settings: &Settings, key: &str) -> Option<i64> {
    match settings.get(key) {
        Some(Value::Number(n)) => Some(*n),
        _ => None,
    }
}

/// The proxy URI for a request to `host`, or `None` to go direct.
pub(crate) fn https_proxy(settings: &Settings, host: &str) -> Option<String> {
    if number(settings, "HTTPSEnable").unwrap_or(0) == 0 {
        return None;
    }
    let Some(Value::Text(server)) = settings.get("HTTPSProxy") else {
        return None;
    };
    let server = server.trim();
    if server.is_empty() || bypassed(settings, host) {
        return None;
    }
    let server = if server.contains(':') && !server.starts_with('[') {
        format!("[{server}]")
    } else {
        server.to_string()
    };
    match number(settings, "HTTPSPort").and_then(|port| u16::try_from(port).ok()) {
        Some(port) if port > 0 => Some(format!("http://{server}:{port}")),
        _ => Some(format!("http://{server}")),
    }
}

fn bypassed(settings: &Settings, host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let ip = host.parse::<IpAddr>().ok();
    if host == "localhost" || ip.is_some_and(|ip| ip.is_loopback()) {
        return true;
    }
    if number(settings, "ExcludeSimpleHostnames").unwrap_or(0) != 0
        && ip.is_none()
        && !host.contains('.')
    {
        return true;
    }
    match settings.get("ExceptionsList") {
        Some(Value::List(patterns)) => patterns.iter().any(|p| matches(p, &host, ip)),
        _ => false,
    }
}

fn matches(pattern: &str, host: &str, ip: Option<IpAddr>) -> bool {
    let pattern = pattern.trim().trim_end_matches('.').to_ascii_lowercase();
    if pattern.is_empty() {
        return false;
    }
    if let Some((network, bits)) = cidr(&pattern) {
        return ip.is_some_and(|ip| in_network(ip, network, bits));
    }
    if let Some(suffix) = pattern.strip_prefix('*') {
        return host.ends_with(suffix);
    }
    if pattern.starts_with('.') {
        return host.ends_with(&pattern);
    }
    host == pattern
}

/// `10.0.0.0/8`, `fe80::/10`, or an IPv4 network with its trailing zeros left out (`169.254/16`).
fn cidr(pattern: &str) -> Option<(IpAddr, u8)> {
    let (address, bits) = pattern.split_once('/')?;
    let bits = bits.parse::<u8>().ok()?;
    let network = address.parse::<IpAddr>().ok().or_else(|| {
        let octets: Vec<&str> = address.split('.').collect();
        if octets.len() > 4 || octets.iter().any(|o| o.parse::<u8>().is_err()) {
            return None;
        }
        let mut padded = octets;
        padded.resize(4, "0");
        padded.join(".").parse().ok()
    })?;
    Some((network, bits))
}

fn in_network(ip: IpAddr, network: IpAddr, bits: u8) -> bool {
    match (ip, network) {
        (IpAddr::V4(ip), IpAddr::V4(network)) if bits <= 32 => {
            let mask = u32::MAX.checked_shl(32 - u32::from(bits)).unwrap_or(0);
            u32::from(ip) & mask == u32::from(network) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(network)) if bits <= 128 => {
            let mask = u128::MAX.checked_shl(128 - u32::from(bits)).unwrap_or(0);
            u128::from(ip) & mask == u128::from(network) & mask
        }
        _ => false,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn system() -> Settings {
    use system_configuration::core_foundation::array::CFArray;
    use system_configuration::core_foundation::number::CFNumber;
    use system_configuration::core_foundation::string::CFString;
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;

    let mut settings = Settings::new();
    let Some(proxies) = SCDynamicStoreBuilder::new("devot")
        .build()
        .and_then(|store| store.get_proxies())
    else {
        return settings;
    };
    for key in KEYS {
        let Some(found) = proxies.find(CFString::from_static_string(key)) else {
            continue;
        };
        let value = if let Some(n) = found.downcast::<CFNumber>() {
            n.to_i64().map(Value::Number)
        } else if let Some(text) = found.downcast::<CFString>() {
            Some(Value::Text(text.to_string()))
        } else {
            found
                .downcast::<CFArray>()
                .map(|list| Value::List(crate::native::macos::cf_array_strings(&list)))
        };
        if let Some(value) = value {
            settings.insert(key.to_string(), value);
        }
    }
    settings
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn system() -> Settings {
    Settings::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(entries: &[(&str, Value)]) -> Settings {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect()
    }

    fn enabled(extra: &[(&str, Value)]) -> Settings {
        let mut all = settings(&[
            ("HTTPSEnable", Value::Number(1)),
            ("HTTPSProxy", Value::Text("proxy.example".into())),
            ("HTTPSPort", Value::Number(8443)),
        ]);
        all.extend(settings(extra));
        all
    }

    fn list(items: &[&str]) -> Value {
        Value::List(items.iter().map(|s| (*s).to_string()).collect())
    }

    #[test]
    fn uses_the_https_proxy_only_when_it_is_on_and_named() {
        assert_eq!(
            https_proxy(&enabled(&[]), "licence.devot.online").as_deref(),
            Some("http://proxy.example:8443")
        );
        assert_eq!(https_proxy(&Settings::new(), "example.com"), None);
        assert_eq!(
            https_proxy(
                &enabled(&[("HTTPSEnable", Value::Number(0))]),
                "example.com"
            ),
            None
        );
        assert_eq!(
            https_proxy(
                &enabled(&[("HTTPSProxy", Value::Text("  ".into()))]),
                "example.com"
            ),
            None
        );
        assert_eq!(
            https_proxy(
                &settings(&[
                    ("HTTPSProxy", Value::Text("proxy.example".into())),
                    ("HTTPSPort", Value::Number(8443)),
                ]),
                "example.com"
            ),
            None
        );
    }

    #[test]
    fn ignores_an_automatic_configuration_on_its_own() {
        let pac = settings(&[
            ("ProxyAutoConfigEnable", Value::Number(1)),
            (
                "ProxyAutoConfigURLString",
                Value::Text("http://wpad.example/proxy.pac".into()),
            ),
        ]);
        assert_eq!(https_proxy(&pac, "example.com"), None);
    }

    #[test]
    fn writes_the_port_and_an_ipv6_server_as_a_uri_takes_them() {
        assert_eq!(
            https_proxy(&enabled(&[("HTTPSPort", Value::Number(0))]), "example.com").as_deref(),
            Some("http://proxy.example")
        );
        assert_eq!(
            https_proxy(
                &enabled(&[("HTTPSPort", Value::Number(70_000))]),
                "example.com"
            )
            .as_deref(),
            Some("http://proxy.example")
        );
        assert_eq!(
            https_proxy(
                &enabled(&[("HTTPSProxy", Value::Text("fd00::8".into()))]),
                "example.com"
            )
            .as_deref(),
            Some("http://[fd00::8]:8443")
        );
    }

    #[test]
    fn goes_direct_for_hosts_on_the_bypass_list() {
        let proxied = enabled(&[(
            "ExceptionsList",
            list(&[
                "*.local",
                "169.254/16",
                "intranet.example",
                ".corp.example",
                "10.0.0.0/8",
                "fe80::/10",
            ]),
        )]);
        for direct in [
            "printer.local",
            "169.254.1.2",
            "intranet.example",
            "INTRANET.example.",
            "a.corp.example",
            "10.20.30.40",
            "[fe80::1]",
            "localhost",
            "127.0.0.1",
            "[::1]",
        ] {
            assert_eq!(https_proxy(&proxied, direct), None, "{direct}");
        }
        for through in [
            "example.com",
            "sub.intranet.example",
            "corp.example",
            "11.0.0.1",
            "169.255.0.1",
            "[2001:db8::1]",
        ] {
            assert!(https_proxy(&proxied, through).is_some(), "{through}");
        }
    }

    #[test]
    fn goes_direct_for_simple_host_names_when_asked() {
        let simple = enabled(&[("ExcludeSimpleHostnames", Value::Number(1))]);
        assert_eq!(https_proxy(&simple, "intranet"), None);
        assert!(https_proxy(&simple, "intranet.example").is_some());
        assert!(https_proxy(&enabled(&[]), "intranet").is_some());
    }

    #[test]
    fn skips_bypass_entries_it_cannot_read() {
        let odd = enabled(&[("ExceptionsList", list(&["", "10.0/abc", "300.1/8"]))]);
        assert!(https_proxy(&odd, "example.com").is_some());
        assert!(https_proxy(&odd, "10.0.0.1").is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_the_system_settings_without_failing() {
        let read = system();
        assert!(read.keys().all(|key| KEYS.contains(&key.as_str())));
    }
}
