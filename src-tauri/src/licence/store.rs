//! Where the licence lives: the key in the keychain beside the AI keys (a generic password under the
//! app's identifier, account `licence`), never in a file, the web view or a log; the trial's start
//! and latest time seen beside it (account `trial`), or in an App Store build the Trial purchase's
//! latest time seen (account `app-store-trial`); the last verified revocation list in
//! `<app data>/licence-revocations.txt`, since it is public.

pub(crate) const REVOCATIONS_FILE: &str = "licence-revocations.txt";

pub(crate) trait KeyStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, &'static str>;
    fn set(&self, key: &str) -> Result<(), &'static str>;
    /// Removing a key that is not there is not an error.
    fn clear(&self) -> Result<(), &'static str>;
}

pub(crate) const LICENCE_ACCOUNT: &str = "licence";
pub(crate) const TRIAL_ACCOUNT: &str = "trial";
pub(crate) const APP_STORE_TRIAL_ACCOUNT: &str = "app-store-trial";

/// A keychain status as an error code: a refused access prompt (`errSecUserCanceled`,
/// `errSecAuthFailed`) gets its own, which the windows explain.
#[cfg_attr(
    all(not(test), not(any(target_os = "macos", target_os = "ios"))),
    expect(dead_code, reason = "only the Security framework reports a status")
)]
pub(crate) fn keychain_error(status: i32) -> &'static str {
    const ERR_SEC_USER_CANCELED: i32 = -128;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;
    match status {
        ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED => "E_LICENCE_KEYCHAIN_DENIED",
        _ => "E_LICENCE_KEYCHAIN",
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) struct Keychain {
    service: String,
    account: &'static str,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl Keychain {
    /// `service` is the app's identifier, so a debug build keeps its own item.
    pub(crate) fn new(service: &str, account: &'static str) -> Self {
        Self {
            service: service.to_owned(),
            account,
        }
    }

    fn item(&self) -> crate::keychain::Item<'_> {
        crate::keychain::Item {
            service: &self.service,
            account: self.account,
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl KeyStore for Keychain {
    fn get(&self) -> Result<Option<String>, &'static str> {
        match self.item().get() {
            Ok(Some(bytes)) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "E_LICENCE_KEYCHAIN"),
            Ok(None) => Ok(None),
            Err(status) => {
                log::warn!(
                    "W_LICENCE_KEYCHAIN_READ_FAILED account={} status={status}",
                    self.account,
                );
                Err(keychain_error(status))
            }
        }
    }

    fn set(&self, key: &str) -> Result<(), &'static str> {
        self.item().set(key.as_bytes()).map_err(keychain_error)
    }

    fn clear(&self) -> Result<(), &'static str> {
        self.item().delete().map(|_| ()).map_err(keychain_error)
    }
}

/// Where there is no keychain: every use fails, so a key is never kept anywhere else.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) struct Keychain;

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
impl Keychain {
    pub(crate) fn new(_service: &str, _account: &'static str) -> Self {
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
    /// Writes fail as a denied or locked keychain does.
    pub unwritable: std::sync::atomic::AtomicBool,
    pub writes: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl MemoryKey {
    pub(crate) fn holding(text: &str) -> Self {
        Self {
            key: std::sync::Mutex::new(Some(text.to_owned())),
            ..Self::default()
        }
    }
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
        self.writes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.unwritable.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("E_LICENCE_KEYCHAIN");
        }
        *self.key.lock().map_err(|_| "E_LICENCE_KEYCHAIN")? = Some(key.to_owned());
        Ok(())
    }

    fn clear(&self) -> Result<(), &'static str> {
        *self.key.lock().map_err(|_| "E_LICENCE_KEYCHAIN")? = None;
        Ok(())
    }
}

#[cfg(test)]
mod keychain_error_tests {
    use super::keychain_error;

    #[test]
    fn a_refused_access_prompt_has_its_own_code() {
        assert_eq!(keychain_error(-128), "E_LICENCE_KEYCHAIN_DENIED");
        assert_eq!(keychain_error(-25293), "E_LICENCE_KEYCHAIN_DENIED");
        assert_eq!(keychain_error(-25308), "E_LICENCE_KEYCHAIN");
        assert_eq!(keychain_error(-34018), "E_LICENCE_KEYCHAIN");
    }
}
