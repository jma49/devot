//! Reads `DEVOT_SENTRY_DSN` from the repository's `.env.local` (git-ignored),
//! for build.rs; Vite reads the same file for the UI. Shared with the library
//! only so the parser has tests.

const KEY: &str = "DEVOT_SENTRY_DSN";

/// The DSN in a `.env` style text, if it is set to an https URL.
pub fn sentry_dsn(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.strip_prefix("export ").unwrap_or(line).split_once('='))
        .filter(|(key, _)| key.trim() == KEY)
        .map(|(_, value)| {
            value
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .to_owned()
        })
        .next_back()
        .filter(|value| value.starts_with("https://") && !value.contains(char::is_whitespace))
}

/// The release workflow sets it (YYYY-MM-DD, UTC); `licence::keys` reads it with `option_env!`.
pub const RELEASE_DATE_KEY: &str = "DEVOT_RELEASE_DATE";

/// What the build script tells Cargo to watch for the DSN: the environment
/// variable, and `.env.local` while it exists. A missing file is never
/// listed, and neither is the folder it would be created in: Cargo treats a
/// missing path as always changed and scans a folder with everything below
/// it (including `target`), so either one would rebuild the app on every
/// `cargo` command. A `.env.local` created later is picked up by the next
/// build after `build.rs` changes or the variable is set (see
/// `.env.example`).
pub fn watch_lines(env_file: &str, exists: bool) -> Vec<String> {
    let mut lines = vec![format!("cargo:rerun-if-env-changed={KEY}")];
    if exists {
        lines.push(format!("cargo:rerun-if-changed={env_file}"));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::{RELEASE_DATE_KEY, sentry_dsn, watch_lines};

    const DSN: &str = "https://key@o1.ingest.us.sentry.io/2";

    #[test]
    fn reads_the_dsn_in_any_common_form() {
        for text in [
            format!("DEVOT_SENTRY_DSN={DSN}"),
            format!("DEVOT_SENTRY_DSN=\"{DSN}\""),
            format!("export DEVOT_SENTRY_DSN='{DSN}'\n"),
            format!("# Devot\nOTHER=1\n  DEVOT_SENTRY_DSN = {DSN}  \n"),
        ] {
            assert_eq!(sentry_dsn(&text).as_deref(), Some(DSN), "{text}");
        }
    }

    #[test]
    fn ignores_other_projects_comments_and_bad_values() {
        assert_eq!(sentry_dsn(&format!("SENTRY_DSN={DSN}")), None);
        assert_eq!(sentry_dsn(&format!("# DEVOT_SENTRY_DSN={DSN}")), None);
        assert_eq!(sentry_dsn("DEVOT_SENTRY_DSN="), None);
        assert_eq!(sentry_dsn("DEVOT_SENTRY_DSN=http://key@host/1"), None);
        assert_eq!(sentry_dsn(""), None);
    }

    #[test]
    fn the_release_date_is_read_from_the_variable_the_workflow_sets() {
        assert_eq!(RELEASE_DATE_KEY, "DEVOT_RELEASE_DATE");
        let workflow = include_str!("../.github/workflows/release.yml");
        assert!(workflow.contains(&format!("{RELEASE_DATE_KEY}: ")));
    }

    #[test]
    fn watches_the_file_only_while_it_exists() {
        assert_eq!(
            watch_lines("../.env.local", true),
            [
                "cargo:rerun-if-env-changed=DEVOT_SENTRY_DSN",
                "cargo:rerun-if-changed=../.env.local"
            ]
        );
        // Nothing is watched by path without the file: Cargo would see a
        // missing path (or a whole folder, `target` included) as changed.
        assert_eq!(
            watch_lines("../.env.local", false),
            ["cargo:rerun-if-env-changed=DEVOT_SENTRY_DSN"]
        );
    }
}
