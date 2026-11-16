# Plugins keep their own data and declare settings Devot draws

Status: accepted (2026-11-16). Takes up the persistent storage ADR 0005 left for its own decision, in plugin API version 2 (ADR 0020).

A plugin with the `storage` permission keeps JSON values under keys of its own, and a plugin of any permissions declares settings in its manifest that Devot draws in Settings > Plugins.
Rust holds both, per plugin, in `<app data>/plugin-data/<id>.json` (`src-tauri/src/plugins/storage.rs`).

## Why

- A plugin's frame has an opaque origin, so it has no storage of its own, and every plugin that remembers anything (a count, a cache, a choice) needed somewhere to put it.
- A store Rust keeps outside the frame keeps the sandbox whole: the frame still has no storage, and the host binds every call to the plugin whose port it came on, so a plugin reaches only its own values.
- Settings drawn by Devot from a declaration need no UI permission and look like every other setting; a plugin's own page never draws in Settings.

## Rules

- Methods (protocol 1, API 2): `storage.get` `{ key }` answers the value or null, `storage.set` `{ key, value }`, `storage.delete` `{ key }`, `storage.keys`; `settings.get` answers every declared setting with its value; the host sends the event `settings.changed` when the user changes one.
  The storage methods need `storage`, `settings.get` nothing; none needs a running command, so a preview renderer or an import can use them.
- A key is a letter or digit then letters, digits and `._:/-`, at most 128.
  A value is plain JSON (no other object kinds, no non-finite numbers, no lone surrogates, 32 levels deep at most), 256 KiB at most as JSON; the page and Rust both check.
  A plugin's file holds at most 1 MiB and 1000 keys (`E_PLUGIN_STORAGE_FULL`).
- `contributes.settings`, at most 20: `id`, `title`, optional `description` and `default`, and a `type`: `toggle`, `text` (one line, 1000 characters), `number` (optional `min` and `max`) or `choice` (`choices`, 1 to 20, `id` and `title` each).
  A manifest for API version 1 cannot declare them.
  Settings stores only a value that fits the declaration (`E_PLUGIN_SETTING_INVALID`), and `settings.get` answers the default for one stored value that no longer fits after an update.
- The data never syncs and backups leave it out, as plugins themselves; an update keeps it, and removing the plugin deletes it.

## Consequences

- New commands `plugin_storage_get`, `plugin_storage_set`, `plugin_storage_delete`, `plugin_storage_keys` and `plugin_settings_get` for the main windows, and `plugin_settings_get` and `plugin_settings_set` for Settings, which emits `devot://plugin-settings-changed` for the main windows to tell the plugin.
- The runtime adds `devot.storage` and `devot.settings` and reports `devot.apiVersion` 2.
- Tests: the shared manifest cases, `protocol.test.ts`, `host.test.ts`, Rust's `plugins::storage` tests, `tests/ui/plugin-storage.spec.ts` and the settings case in `tests/ui/plugin-settings.spec.ts`.
