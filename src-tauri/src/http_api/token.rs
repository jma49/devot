//! The per-install token: a random secret kept only in the keychain, never in a settings file or a
//! log. Settings shows it on request and makes a new one.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const PREFIX: &str = "dvt_";
const SECRET_BYTES: usize = 32;
const TOKEN_CHARS: usize = PREFIX.len() + 43;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    #[default]
    Read,
    ReadWrite,
}

pub type Token = Zeroizing<String>;

pub fn generate() -> Result<Token, &'static str> {
    let mut bytes = Zeroizing::new([0u8; SECRET_BYTES]);
    getrandom::fill(bytes.as_mut()).map_err(|_| "E_HTTP_API_RANDOM_FAILED")?;
    Ok(Zeroizing::new(format!(
        "{PREFIX}{}",
        URL_SAFE_NO_PAD.encode(bytes.as_ref())
    )))
}

pub fn is_token(text: &str) -> bool {
    text.len() == TOKEN_CHARS
        && text.starts_with(PREFIX)
        && text[PREFIX.len()..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Compares in time that depends on the length alone, which every token shares.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

pub trait TokenStore: Send + Sync {
    /// Without reading the secret: no access prompt.
    fn has(&self) -> Result<bool, &'static str>;
    fn get(&self) -> Result<Option<Token>, &'static str>;
    fn set(&self, token: &str) -> Result<(), &'static str>;
}

const ACCOUNT: &str = "http-api-token";
/// The bridge's own token (ADR 0012), so the HTTP API's can be rotated or stay off without it.
const MCP_ACCOUNT: &str = "mcp-bridge-token";

/// A generic password under the app's identifier as service, so a debug build keeps its own.
pub struct Keychain {
    #[cfg_attr(
        all(not(test), not(target_os = "macos")),
        expect(dead_code, reason = "only macOS and tests use it")
    )]
    service: String,
    #[cfg_attr(
        all(not(test), not(target_os = "macos")),
        expect(dead_code, reason = "only macOS and tests use it")
    )]
    account: &'static str,
}

impl Keychain {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
            account: ACCOUNT,
        }
    }

    pub fn for_mcp(service: &str) -> Self {
        Self {
            service: service.to_string(),
            account: MCP_ACCOUNT,
        }
    }
}

#[cfg(target_os = "macos")]
impl Keychain {
    fn item(&self) -> crate::keychain::Item<'_> {
        crate::keychain::Item {
            service: &self.service,
            account: self.account,
        }
    }
}

#[cfg(target_os = "macos")]
impl TokenStore for Keychain {
    fn has(&self) -> Result<bool, &'static str> {
        self.item().has().map_err(|_| "E_HTTP_API_KEYCHAIN_FAILED")
    }

    fn get(&self) -> Result<Option<Token>, &'static str> {
        match self.item().get() {
            Ok(Some(bytes)) => String::from_utf8(bytes)
                .map(|text| Some(Zeroizing::new(text)))
                .map_err(|_| "E_HTTP_API_KEYCHAIN_FAILED"),
            Ok(None) => Ok(None),
            Err(_) => Err("E_HTTP_API_KEYCHAIN_FAILED"),
        }
    }

    fn set(&self, token: &str) -> Result<(), &'static str> {
        self.item()
            .set(token.as_bytes())
            .map_err(|_| "E_HTTP_API_KEYCHAIN_FAILED")
    }
}

/// Where there is no keychain the API cannot be turned on: the token is never kept anywhere else.
#[cfg(not(target_os = "macos"))]
impl TokenStore for Keychain {
    fn has(&self) -> Result<bool, &'static str> {
        Err("E_HTTP_API_KEYCHAIN_UNAVAILABLE")
    }

    fn get(&self) -> Result<Option<Token>, &'static str> {
        Err("E_HTTP_API_KEYCHAIN_UNAVAILABLE")
    }

    fn set(&self, _: &str) -> Result<(), &'static str> {
        Err("E_HTTP_API_KEYCHAIN_UNAVAILABLE")
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryTokens(pub std::sync::Mutex<Option<String>>);

#[cfg(test)]
impl TokenStore for MemoryTokens {
    fn has(&self) -> Result<bool, &'static str> {
        Ok(self.0.lock().unwrap().is_some())
    }

    fn get(&self) -> Result<Option<Token>, &'static str> {
        Ok(self.0.lock().unwrap().clone().map(Zeroizing::new))
    }

    fn set(&self, token: &str) -> Result<(), &'static str> {
        *self.0.lock().unwrap() = Some(token.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_and_of_one_shape() {
        let a = generate().unwrap();
        let b = generate().unwrap();
        assert!(is_token(&a) && is_token(&b), "{}", a.len());
        assert_ne!(*a, *b);
        for bad in [
            "",
            "dvt_",
            "dvt_short",
            &format!("xyz_{}", &a[4..]),
            &format!("{}!", &a[..TOKEN_CHARS - 1]),
        ] {
            assert!(!is_token(bad), "{bad}");
        }
    }

    #[test]
    fn compares_whole_tokens() {
        assert!(same(b"dvt_abc", b"dvt_abc"));
        assert!(!same(b"dvt_abc", b"dvt_abd"));
        assert!(!same(b"dvt_abc", b"dvt_ab"));
        assert!(!same(b"", b"x"));
    }

    #[test]
    fn scopes_are_read_and_read_write() {
        assert_eq!(serde_json::to_string(&Scope::Read).unwrap(), "\"read\"");
        assert_eq!(
            serde_json::from_str::<Scope>("\"readWrite\"").unwrap(),
            Scope::ReadWrite
        );
        assert!(serde_json::from_str::<Scope>("\"admin\"").is_err());
    }

    #[test]
    fn the_bridge_and_the_http_api_keep_separate_keychain_items() {
        let (http, mcp) = (Keychain::new("x"), Keychain::for_mcp("x"));
        assert_eq!(http.service, mcp.service);
        assert_ne!(http.account, mcp.account);
    }
}
