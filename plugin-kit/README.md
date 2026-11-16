# Devot plugin kit

Types for the `devot` global a plugin runs with, and the `devot-plugin` command.

```sh
devot-plugin new word-tools          # a plugin with one command, ready to install
devot-plugin validate word-tools     # the manifest and files, by Devot's own rules
devot-plugin pack word-tools         # com.example.word-tools-0.1.0.zip, for Settings, Plugins
```

In a plugin's script, `/// <reference types="@devot/plugin-kit" />` and `// @ts-check` give the editor the API's types.
`DevotManifest` types `devot-plugin.json`.

The command is built from Devot's sources (`pnpm plugin-kit:build` in the Devot repository), so it checks a manifest exactly as the app does: `src/core/plugins/manifest.ts` and the package limits of `src-tauri/src/plugins/package.rs`.
The plugin API itself is described in `docs/specs/extensions.md` and ADRs 0005 and 0020 to 0023.
