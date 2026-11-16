# Plugin API versions only add, and an old one runs for at least a year

Status: accepted (2026-11-16). Amends ADR 0005, whose manifest refused every API version but the current one.

A plugin's `apiVersion` names the plugin API it was written for.
Devot runs every version from `PLUGIN_API_OLDEST` to `PLUGIN_API_VERSION` (`src/core/plugins/manifest.ts`, `src-tauri/src/plugins/manifest.rs`).
A new API version only adds: methods, permissions, events and contribution points, never a change to one that exists.
So a plugin written for version 1 runs unchanged in a Devot that speaks version 2, and gets nothing of version 2.
A permission records the version that added it, and a manifest written for an older version cannot ask for it (`E_PLUGIN_PERMISSION_UNKNOWN`).

## Why

- With an exact match, the first new API version would stop every installed plugin at once, and authors would have to ship a release the same day as Devot.
- Adding only, as the wire protocol already does (`devot: 1` messages carry new methods without a new envelope), keeps the host's checks one table: each method's permission, each permission's version.
- A plugin that needs a fix made in a later Devot says so with `minAppVersion` instead of a new API version.

## Rules

- `apiVersion` is a whole number from 1.
  Above `PLUGIN_API_VERSION` the package is refused with `E_PLUGIN_API_TOO_NEW` and Settings says it needs a newer Devot; below `PLUGIN_API_OLDEST` with `E_PLUGIN_API_RETIRED`; anything else with `E_PLUGIN_API_VERSION`.
- `minAppVersion` is optional, `major.minor.patch` without a prerelease.
  Rust compares it with the build's release version, when staging a package (`E_PLUGIN_APP_TOO_OLD`, shown before anything is asked) and whenever it lists plugins (a plugin the app became too old for, after a downgrade, is left out and logged like an unreadable one).
  A beta runs plugins that need its release (`1.2.0-beta3` runs one that needs 1.2.0), and a development build (`0.0.0`, the committed version) runs every plugin.
  The page checks only its form, since it does not know the release version.
- A version is retired only by raising `PLUGIN_API_OLDEST`, at least 12 months after the next version ships, with the date in the release notes and on the site's plugin guide 3 months before.
- A change that cannot be an addition (a method whose meaning must change) is a new method or permission with its own name; the old one stays until its version is retired.

## Consequences

- `tests/fixtures/plugins/manifests.json` holds the version and `minAppVersion` cases both sides run, and `appVersions`, the release comparisons Rust runs.
- The site's plugin guide documents `minAppVersion` and the promise above.
