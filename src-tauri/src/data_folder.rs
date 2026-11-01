//! Only the release workflow's build keeps its data, keychain items and WebKit store under its bundle identifier (`~/Library/Application Support/io.github.jma49.devot`): the workflow sets `DEVOT_RELEASE_BUILD=1` when it compiles. A debug build (`pnpm dev`, `pnpm build:debug`, every test build) adds `.dev`; a release build made anywhere else (`pnpm build` on a Mac) adds `.local`. So neither ever opens, migrates or deletes an installed Devot's notes, or joins the access list of its keychain items, which makes macOS ask the installed app for the login password again. Scripts that start the app use the `.dev` folder (`scripts/app-data.sh`, `tests/policy/data-folder.test.ts`).
//! WebKit keeps website data per bundle identifier, which every build shares, so the other builds give every window a WebKit data store of their own ([`web_data_store`]). The release app keeps WebKit's default store, where its UI state has always been.

pub(crate) const DEV_SUFFIX: &str = ".dev";
pub(crate) const LOCAL_SUFFIX: &str = ".local";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Build {
    Debug,
    Local,
    Release,
}

impl Build {
    pub(crate) fn of(debug: bool, release_marker: Option<&str>) -> Self {
        match (debug, release_marker) {
            (true, _) => Self::Debug,
            (false, Some("1")) => Self::Release,
            (false, _) => Self::Local,
        }
    }

    pub(crate) fn this() -> Self {
        Self::of(cfg!(debug_assertions), option_env!("DEVOT_RELEASE_BUILD"))
    }
}

pub(crate) fn folder_identifier(bundle: &str, build: Build) -> String {
    match build {
        Build::Debug => format!("{bundle}{DEV_SUFFIX}"),
        Build::Local => format!("{bundle}{LOCAL_SUFFIX}"),
        Build::Release => bundle.to_owned(),
    }
}

/// Fixed, so every run of a build finds the state the last left.
const DEV_WEB_DATA_STORE: uuid::Uuid =
    uuid::Uuid::from_u128(0x2b0c7a52_9d4e_4f61_8a3b_6e1f0d5c9a17);
const LOCAL_WEB_DATA_STORE: uuid::Uuid =
    uuid::Uuid::from_u128(0x7e3f19c4_52a8_4b0d_9c61_d84a2e5b0f93);

pub(crate) fn web_data_store(build: Build) -> Option<[u8; 16]> {
    match build {
        Build::Debug => Some(DEV_WEB_DATA_STORE.into_bytes()),
        Build::Local => Some(LOCAL_WEB_DATA_STORE.into_bytes()),
        Build::Release => None,
    }
}

pub(crate) fn this_build_web_data_store() -> Option<[u8; 16]> {
    web_data_store(Build::this())
}

/// Tauri names every app folder (`app_data_dir`, `app_log_dir`, ...) and the keychain items after the configured identifier; the bundle's own identifier in its Info.plist stays the same.
pub(crate) fn context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    let identifier = folder_identifier(&context.config().identifier, Build::this());
    context.config_mut().identifier = identifier;
    context
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str = "io.github.jma49.devot";

    #[test]
    fn only_the_release_workflow_build_is_the_release_app() {
        assert_eq!(Build::of(true, Some("1")), Build::Debug);
        assert_eq!(Build::of(false, Some("1")), Build::Release);
        assert_eq!(Build::of(false, None), Build::Local);
        assert_eq!(Build::of(false, Some("")), Build::Local);
        assert_eq!(Build::of(false, Some("0")), Build::Local);
    }

    #[test]
    fn every_other_build_names_its_folders_apart_from_the_release_app() {
        assert_eq!(folder_identifier(BUNDLE, Build::Release), BUNDLE);
        assert_eq!(
            folder_identifier(BUNDLE, Build::Debug),
            "io.github.jma49.devot.dev"
        );
        assert_eq!(
            folder_identifier(BUNDLE, Build::Local),
            "io.github.jma49.devot.local"
        );
    }

    #[test]
    fn every_other_build_keeps_its_web_data_apart_from_the_release_app() {
        // The release app keeps WebKit's default store, so nobody's localStorage moves.
        assert_eq!(web_data_store(Build::Release), None);
        assert_eq!(
            web_data_store(Build::Debug).map(|id| uuid::Uuid::from_bytes(id).to_string()),
            Some("2b0c7a52-9d4e-4f61-8a3b-6e1f0d5c9a17".to_owned())
        );
        assert!(web_data_store(Build::Local).is_some());
        assert_ne!(web_data_store(Build::Local), web_data_store(Build::Debug));
        assert_eq!(this_build_web_data_store(), web_data_store(Build::Debug));
    }

    #[test]
    fn this_build_keeps_its_data_in_the_dev_folders() {
        assert_eq!(context().config().identifier, "io.github.jma49.devot.dev");
    }
}
