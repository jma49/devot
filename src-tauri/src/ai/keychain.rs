//! Keys live only in the OS keychain: never in a settings file, the web view or a log.

use super::provider::ProviderId;

pub const MAX_KEY_CHARS: usize = 512;

pub trait KeyStore: Send + Sync {
    /// Whether a key is stored, without reading it: no secret in memory and no access prompt.
    fn has(&self, provider: ProviderId) -> Result<bool, &'static str>;
    fn get(&self, provider: ProviderId) -> Result<Option<String>, &'static str>;
    fn set(&self, provider: ProviderId, key: &str) -> Result<(), &'static str>;
    /// Removing a key that is not there is not an error.
    fn clear(&self, provider: ProviderId) -> Result<(), &'static str>;
}

/// A key as a header can carry it: visible ASCII, no spaces.
pub fn clean_key(key: &str) -> Result<&str, &'static str> {
    let key = key.trim();
    if key.is_empty()
        || key.chars().count() > MAX_KEY_CHARS
        || !key.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err("E_AI_KEY_INVALID");
    }
    Ok(key)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn account(provider: ProviderId) -> String {
    format!("ai-key-{}", provider.as_str())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub struct Keychain {
    service: String,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl Keychain {
    /// `service` is the app's identifier, so a debug build keeps its own items.
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    fn item<'a>(&'a self, account: &'a str) -> crate::keychain::Item<'a> {
        crate::keychain::Item {
            service: &self.service,
            account,
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl KeyStore for Keychain {
    fn has(&self, provider: ProviderId) -> Result<bool, &'static str> {
        self.item(&account(provider))
            .has()
            .map_err(|_| "E_AI_KEYCHAIN_FAILED")
    }

    fn get(&self, provider: ProviderId) -> Result<Option<String>, &'static str> {
        match self.item(&account(provider)).get() {
            Ok(Some(bytes)) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "E_AI_KEYCHAIN_FAILED"),
            Ok(None) => Ok(None),
            Err(_) => Err("E_AI_KEYCHAIN_FAILED"),
        }
    }

    fn set(&self, provider: ProviderId, key: &str) -> Result<(), &'static str> {
        self.item(&account(provider))
            .set(key.as_bytes())
            .map_err(|_| "E_AI_KEYCHAIN_FAILED")
    }

    fn clear(&self, provider: ProviderId) -> Result<(), &'static str> {
        self.item(&account(provider))
            .delete()
            .map(|_| ())
            .map_err(|_| "E_AI_KEYCHAIN_FAILED")
    }
}

/// Where there is no keychain: every use fails, so a key is never kept anywhere else.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub struct Keychain;

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
impl Keychain {
    pub fn new(_service: &str) -> Self {
        Self
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
impl KeyStore for Keychain {
    fn has(&self, _: ProviderId) -> Result<bool, &'static str> {
        Err("E_AI_KEYCHAIN_UNAVAILABLE")
    }

    fn get(&self, _: ProviderId) -> Result<Option<String>, &'static str> {
        Err("E_AI_KEYCHAIN_UNAVAILABLE")
    }

    fn set(&self, _: ProviderId, _: &str) -> Result<(), &'static str> {
        Err("E_AI_KEYCHAIN_UNAVAILABLE")
    }

    fn clear(&self, _: ProviderId) -> Result<(), &'static str> {
        Err("E_AI_KEYCHAIN_UNAVAILABLE")
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryKeys(std::sync::Mutex<Vec<(ProviderId, String)>>);

#[cfg(test)]
impl KeyStore for MemoryKeys {
    fn has(&self, provider: ProviderId) -> Result<bool, &'static str> {
        Ok(self.get(provider)?.is_some())
    }

    fn get(&self, provider: ProviderId) -> Result<Option<String>, &'static str> {
        let keys = self.0.lock().map_err(|_| "E_AI_KEYCHAIN_FAILED")?;
        Ok(keys
            .iter()
            .find(|(p, _)| *p == provider)
            .map(|(_, k)| k.clone()))
    }

    fn set(&self, provider: ProviderId, key: &str) -> Result<(), &'static str> {
        self.clear(provider)?;
        self.0
            .lock()
            .map_err(|_| "E_AI_KEYCHAIN_FAILED")?
            .push((provider, key.to_string()));
        Ok(())
    }

    fn clear(&self, provider: ProviderId) -> Result<(), &'static str> {
        self.0
            .lock()
            .map_err(|_| "E_AI_KEYCHAIN_FAILED")?
            .retain(|(p, _)| *p != provider);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_visible_ascii_without_spaces() {
        assert_eq!(clean_key("  sk-ant-abc_123  "), Ok("sk-ant-abc_123"));
        for bad in [
            "",
            "   ",
            "two words",
            "line\nbreak",
            "caf\u{e9}",
            &"k".repeat(MAX_KEY_CHARS + 1),
        ] {
            assert_eq!(clean_key(bad), Err("E_AI_KEY_INVALID"), "{bad:?}");
        }
    }

    #[test]
    fn memory_keys_keep_one_key_per_provider() {
        let keys = MemoryKeys::default();
        assert_eq!(keys.get(ProviderId::Anthropic), Ok(None));
        keys.set(ProviderId::Anthropic, "a").unwrap();
        keys.set(ProviderId::Anthropic, "b").unwrap();
        keys.set(ProviderId::Openai, "c").unwrap();
        assert_eq!(keys.get(ProviderId::Anthropic), Ok(Some("b".into())));
        keys.clear(ProviderId::Anthropic).unwrap();
        keys.clear(ProviderId::Anthropic).unwrap();
        assert_eq!(keys.get(ProviderId::Anthropic), Ok(None));
        assert_eq!(keys.get(ProviderId::Openai), Ok(Some("c".into())));
    }
}
