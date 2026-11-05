//! Where this build is sold (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md,
//! App Store builds). An iPhone release build compiled with `DEVOT_DISTRIBUTION=app-store` beside
//! `DEVOT_RELEASE_BUILD=1` is an App Store build: it reads StoreKit, its trial is the Trial
//! purchase and it shows no way to pay outside the App Store. Every other build, the Mac's and
//! an iPhone development build's, is `Direct` and behaves as before. `build.rs` refuses any other
//! value, or the marker on a Mac.

use crate::data_folder::Build;

const APP_STORE_MARKER: &str = "app-store";

/// Enter Licence Key and `devot://licence` links in an App Store build. If App Review refuses
/// them (ADR 0014, Risks 1), turning this off is the whole change: Rust refuses keys, and the
/// windows hide the field because the snapshot says so.
const APP_STORE_TAKES_LICENCE_KEYS: bool = true;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Distribution {
    Direct,
    AppStore,
}

impl Distribution {
    pub(crate) fn of(build: Build, ios: bool, marker: Option<&str>) -> Self {
        if matches!(build, Build::Release) && ios && marker == Some(APP_STORE_MARKER) {
            Self::AppStore
        } else {
            Self::Direct
        }
    }

    pub(crate) fn this() -> Self {
        Self::of(
            Build::this(),
            cfg!(target_os = "ios"),
            option_env!("DEVOT_DISTRIBUTION"),
        )
    }

    pub(crate) fn takes_licence_keys(self) -> bool {
        match self {
            Self::Direct => true,
            Self::AppStore => APP_STORE_TAKES_LICENCE_KEYS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_iphone_release_build_with_the_marker_is_an_app_store_build() {
        let marker = Some(crate::build_env::APP_STORE);
        assert_eq!(
            Distribution::of(Build::Release, true, marker),
            Distribution::AppStore
        );
        for (build, ios, marker) in [
            (Build::Debug, true, marker),
            (Build::Local, true, marker),
            (Build::Release, false, marker),
            (Build::Release, true, None),
            (Build::Release, true, Some("")),
            (Build::Release, true, Some("appstore")),
        ] {
            assert_eq!(
                Distribution::of(build, ios, marker),
                Distribution::Direct,
                "{build:?} {ios} {marker:?}"
            );
        }
    }

    #[test]
    fn a_direct_build_always_takes_licence_keys() {
        assert!(Distribution::Direct.takes_licence_keys());
        assert_eq!(
            Distribution::AppStore.takes_licence_keys(),
            APP_STORE_TAKES_LICENCE_KEYS
        );
    }

    #[test]
    fn the_tests_build_is_direct() {
        assert_eq!(Distribution::this(), Distribution::Direct);
    }
}
