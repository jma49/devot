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

#[cfg(target_os = "macos")]
const ACCOUNT: &str = "http-api-token";

#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// A generic password under the app's identifier as service, so a debug build keeps its own.
pub struct Keychain {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    service: String,
}

impl Keychain {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }
}

#[cfg(target_os = "macos")]
impl TokenStore for Keychain {
    fn has(&self) -> Result<bool, &'static str> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        match ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(&self.service)
            .account(ACCOUNT)
            .load_attributes(true)
            .limit(Limit::Max(1))
            .search()
        {
            Ok(found) => Ok(!found.is_empty()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
            Err(_) => Err("E_HTTP_API_KEYCHAIN_FAILED"),
        }
    }

    fn get(&self) -> Result<Option<Token>, &'static str> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(&self.service, ACCOUNT) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(|text| Some(Zeroizing::new(text)))
                .map_err(|_| "E_HTTP_API_KEYCHAIN_FAILED"),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err("E_HTTP_API_KEYCHAIN_FAILED"),
        }
    }

    fn set(&self, token: &str) -> Result<(), &'static str> {
        security_framework::passwords::set_generic_password(
            &self.service,
            ACCOUNT,
            token.as_bytes(),
        )
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

    /// Touches the real login keychain, so it runs only when asked: `cargo test -- --ignored keychain`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "uses the login keychain"]
    fn keychain_round_trip() {
        let keychain = Keychain::new("io.github.jma49.devot.test-keychain");
        let token = generate().unwrap();
        keychain.set(&token).unwrap();
        assert_eq!(keychain.has(), Ok(true));
        assert_eq!(
            keychain.get().unwrap().map(|t| t.to_string()),
            Some(token.to_string())
        );
        let _ = security_framework::passwords::delete_generic_password(
            "io.github.jma49.devot.test-keychain",
            ACCOUNT,
        );
        assert_eq!(keychain.has(), Ok(false));
    }
}
