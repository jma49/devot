# Official plugins install from an index on devot.online

Status: accepted (2026-11-16). The first step of the plugin ecosystem's order: easy install, then theme plugins, then diagram renderers.

Settings > Plugins lists the official plugins from `https://devot.online/plugins/index.json`, and installs or updates one with a single click through the same review as a package the user picks.

## Why

- Installing meant downloading an archive from the site and picking it in Settings, which loses most users before they try a plugin.
- Updates were invisible: nothing told a user that a plugin they had was out of date.

## Rules

- The index (devot-site `src/lib/plugin-index.ts`) has a `schema` number and one entry per plugin, built from its manifest: ID, name, version, API version, minimum app version, description, author, permissions, archive path, size and SHA-256.
- Devot reads only schema 1 (`E_PLUGIN_INDEX_SCHEMA`) and leaves out an entry it cannot read, so a later index can list what an older build does not know (`src-tauri/src/plugins/catalog.rs`).
- An archive comes only from the index's own site, at a path `/plugins/<name>.zip`, read no further than the listed size; it must have the listed size and SHA-256 (`E_PLUGIN_ARCHIVE_MISMATCH`), and its manifest the listed ID and version.
- A plugin installs only by a listing the app fetched itself (`E_PLUGIN_NOT_LISTED`), so the page names an ID and never a URL.
- Each listing offers Install, Update (a newer version than the one installed), Installed, or Needs a Newer Devot (a newer API version or minimum app version than this build).
- Install and Update stage the package and show the review of ADR 0005: nothing is written before the user approves what it asks for.

## Consequences

- The index is trusted as far as HTTPS to devot.online is; signing packages is a later decision, needed before plugins by other authors are listed.
- Opening Settings > Plugins sends one request to devot.online; plugins themselves still reach no network.
- Automatic updates and a link on the site that opens the review in Devot build on this index.
