//! A release build keeps its data in folders named after its bundle identifier (`~/Library/Application Support/io.github.jma49.devot`). A debug build (`pnpm dev`, `pnpm build:debug`, every test build) adds `.dev`, so development never opens, migrates or deletes an installed Devot's notes; scripts that start the app use the `.dev` folder too (`scripts/app-data.sh`, `tests/policy/data-folder.test.ts`).
//! WebKit keeps website data per bundle identifier, which a debug bundle shares with the release app, so a debug build gives every window a WebKit data store of its own ([`web_data_store`]). The release app keeps WebKit's default store, where its UI state has always been.

pub(crate) const DEV_SUFFIX: &str = ".dev";

pub(crate) fn folder_identifier(bundle: &str, debug: bool) -> String {
    if debug {
        format!("{bundle}{DEV_SUFFIX}")
    } else {
        bundle.to_owned()
    }
}

/// Fixed, so every debug run finds the state the last left.
const DEV_WEB_DATA_STORE: uuid::Uuid =
    uuid::Uuid::from_u128(0x2b0c7a52_9d4e_4f61_8a3b_6e1f0d5c9a17);

pub(crate) fn web_data_store(debug: bool) -> Option<[u8; 16]> {
    debug.then(|| DEV_WEB_DATA_STORE.into_bytes())
}

pub(crate) fn this_build_web_data_store() -> Option<[u8; 16]> {
    web_data_store(cfg!(debug_assertions))
}

/// Tauri names every app folder (`app_data_dir`, `app_log_dir`, ...) after the configured identifier; the bundle's own identifier in its Info.plist stays the same.
pub(crate) fn context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    let identifier = folder_identifier(&context.config().identifier, cfg!(debug_assertions));
    context.config_mut().identifier = identifier;
    context
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str = "io.github.jma49.devot";

    #[test]
    fn a_debug_build_names_its_folders_apart_from_the_release_app() {
        assert_eq!(folder_identifier(BUNDLE, true), "io.github.jma49.devot.dev");
        assert_eq!(folder_identifier(BUNDLE, false), BUNDLE);
        assert!(folder_identifier(BUNDLE, true).ends_with(DEV_SUFFIX));
    }

    #[test]
    fn a_debug_build_keeps_its_web_data_apart_from_the_release_app() {
        // The release app keeps WebKit's default store, so nobody's
        // localStorage moves; a debug build names a store of its own.
        assert_eq!(web_data_store(false), None);
        assert_eq!(
            web_data_store(true).map(|id| uuid::Uuid::from_bytes(id).to_string()),
            Some("2b0c7a52-9d4e-4f61-8a3b-6e1f0d5c9a17".to_owned())
        );
        assert_eq!(this_build_web_data_store(), web_data_store(true));
    }

    #[test]
    fn this_build_keeps_its_data_in_the_dev_folders() {
        assert_eq!(context().config().identifier, "io.github.jma49.devot.dev");
    }
}
