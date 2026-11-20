# Devot plugin kit

Types for the `devot` global a plugin runs with, and the `devot-plugin` command.

```sh
devot-plugin new word-tools          # a plugin with one command, ready to install
devot-plugin validate word-tools     # the manifest and files, by Devot's own rules
devot-plugin pack word-tools         # com.example.word-tools-0.1.0.zip, for Settings, Plugins
```

In a plugin's script, `/// <reference types="@devot/plugin-kit" />` and `// @ts-check` give the editor the API's types.
The types and CLI target Plugin API 3, including multi-note import results with HTML, tags, dates, base64 image attachments and diagnostic codes, and an import format's `maxFileBytes` up to 100 MiB.
See [the import protocol and limits](../docs/specs/extensions.md) before implementing a converter.
The kit's private package version (`0.1.0`) is independent of the manifest's `apiVersion`; new projects select the app's newest API through `PLUGIN_API_VERSION` (ADR 0024).
`DevotManifest` types `devot-plugin.json`.

The command is built from Devot's sources (`pnpm plugin-kit:build` in the Devot repository), so it checks a manifest exactly as the app does: `src/core/plugins/manifest.ts` and the package limits of `src-tauri/src/plugins/package.rs`.
The plugin API itself is described in `docs/specs/extensions.md` and ADRs 0005 and 0020 to 0023.
