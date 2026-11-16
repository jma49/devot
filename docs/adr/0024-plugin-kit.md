# The plugin kit is built from the app's own rules

Status: accepted (2026-11-16). The developer tools the plugin ecosystem plan puts first, after API version 2 (ADRs 0020 to 0023).

`plugin-kit/` is the package `@devot/plugin-kit`: the types of the `devot` global and of `devot-plugin.json`, and the `devot-plugin` command with `new`, `validate` and `pack`.

## Why

- A plugin author learned the API only from the spec, and learned that a package was refused only when Devot refused to install it.
- A second implementation of the manifest rules would drift from the app's: the command is bundled from `src/core/plugins/manifest.ts` itself, so it refuses exactly what Devot refuses, with the same codes.

## Rules

- `devot-plugin new <folder>` writes a plugin with one command that works on the selection and appears in the slash menu, for the newest API version.
- `devot-plugin validate [folder]` reads the folder as Devot reads a package (`src-tauri/src/plugins/package.rs`): hidden files left out, links and names outside the rules refused, the same limits, the manifest by the app's rules, the main script present.
- `devot-plugin pack [folder]` writes `<id>-<version>.zip` from the same files, deflated in name order with a fixed time, so the same files pack to the same bytes.
- Both leave out what only development needs: `node_modules`, `package.json`, lock files and `.zip` files at the top.
- The types name every part of the runtime's API (`src-tauri/plugin-frame/runtime.js`); a test fails when a call has no type.
- `pnpm plugin-kit:build` bundles the command with esbuild into `plugin-kit/dist/devot-plugin.js`, which runs on Node 22.2 or later with no dependencies.

## Consequences

- The package stays private until a release publishes it to npm; until then an author runs the built script from a Devot checkout.
- A change to the package limits or the runtime's API fails the kit's tests until the kit follows: `tests/plugin-kit/`, and Rust's `reads_the_archive_the_plugin_kit_packs`, which installs an archive the kit packed.
- A dev mode that reloads a plugin folder as it changes is a later decision: it needs Devot to watch a folder outside its own data.
