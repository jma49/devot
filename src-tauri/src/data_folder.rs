//! Which folders the app keeps its data in. A release build uses the ones
//! named after its bundle identifier: `<app data>` is
//! `~/Library/Application Support/io.github.jma49.devot`. A debug build
//! (`pnpm dev`, `pnpm tauri build --debug`, every test build) adds `.dev`
//! to that name, so development never opens, migrates or deletes the notes
//! of an installed Devot. Everything under `<app data>` follows: the
//! database, backups, logs, crash reports, usage events and the settings
//! files. Scripts that start the app use the `.dev` folder too
//! (`scripts/app-data.sh`; `tests/policy/data-folder.test.ts`).

/// What a debug build adds to the identifier its folders are named after.
pub(crate) const DEV_SUFFIX: &str = ".dev";

/// The identifier the app's folders are named after: the bundle identifier,
/// with [`DEV_SUFFIX`] in a debug build.
pub(crate) fn folder_identifier(bundle: &str, debug: bool) -> String {
    if debug {
        format!("{bundle}{DEV_SUFFIX}")
    } else {
        bundle.to_owned()
    }
}

/// The app's context, its folders named for this kind of build. Tauri names
/// every app folder (`app_data_dir`, `app_log_dir` and the others) after the
/// configured identifier; the bundle's own identifier, in its Info.plist,
/// stays the same.
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
    fn this_build_keeps_its_data_in_the_dev_folders() {
        // Test builds are debug builds, like `pnpm dev` and debug bundles.
        assert_eq!(context().config().identifier, "io.github.jma49.devot.dev");
    }
}
