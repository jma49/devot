//! Where the licence lives: the key in the keychain beside the AI keys (a generic password under the
//! app's identifier, account `licence`), never in a file, the web view or a log; the last verified
//! revocation list in `<app data>/licence-revocations.txt`, since it is public.

pub(crate) const REVOCATIONS_FILE: &str = "licence-revocations.txt";

pub(crate) trait KeyStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, &'static str>;
    fn set(&self, key: &str) -> Result<(), &'static str>;
    /// Removing a key that is not there is not an error.
    fn clear(&self) -> Result<(), &'static str>;
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const ACCOUNT: &str = "licence";

#[cfg(any(target_os = "macos", target_os = "ios"))]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) struct Keychain {
    service: String,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl Keychain {
    /// `service` is the app's identifier, so a debug build keeps its own item.
    pub(crate) fn new(service: &str) -> Self {
        Self {
            service: service.to_owned(),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl KeyStore for Keychain {
    fn get(&self) -> Result<Option<String>, &'static str> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(&self.service, ACCOUNT) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "E_LICENCE_KEYCHAIN"),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err("E_LICENCE_KEYCHAIN"),
        }
    }

    fn set(&self, key: &str) -> Result<(), &'static str> {
        security_framework::passwords::set_generic_password(&self.service, ACCOUNT, key.as_bytes())
            .map_err(|_| "E_LICENCE_KEYCHAIN")
    }

    fn clear(&self) -> Result<(), &'static str> {
        match security_framework::passwords::delete_generic_password(&self.service, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(_) => Err("E_LICENCE_KEYCHAIN"),
        }
    }
}

/// Where there is no keychain: every use fails, so a key is never kept anywhere else.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) struct Keychain;

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
impl Keychain {
    pub(crate) fn new(_service: &str) -> Self {
        Self
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
impl KeyStore for Keychain {
    fn get(&self) -> Result<Option<String>, &'static str> {
        Err("E_LICENCE_KEYCHAIN_UNAVAILABLE")
    }

    fn set(&self, _: &str) -> Result<(), &'static str> {
        Err("E_LICENCE_KEYCHAIN_UNAVAILABLE")
    }

    fn clear(&self) -> Result<(), &'static str> {
        Err("E_LICENCE_KEYCHAIN_UNAVAILABLE")
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryKey {
    pub key: std::sync::Mutex<Option<String>>,
    pub reads: std::sync::atomic::AtomicUsize,
    /// Reads fail as a non-UTF-8 or denied item does; writes still succeed.
    pub unreadable: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl KeyStore for MemoryKey {
    fn get(&self) -> Result<Option<String>, &'static str> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.unreadable.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("E_LICENCE_KEYCHAIN");
        }
        Ok(self.key.lock().map_err(|_| "E_LICENCE_KEYCHAIN")?.clone())
    }

    fn set(&self, key: &str) -> Result<(), &'static str> {
        *self.key.lock().map_err(|_| "E_LICENCE_KEYCHAIN")? = Some(key.to_owned());
        Ok(())
    }

    fn clear(&self) -> Result<(), &'static str> {
        *self.key.lock().map_err(|_| "E_LICENCE_KEYCHAIN")? = None;
        Ok(())
    }
}
