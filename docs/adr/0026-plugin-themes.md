# Plugins add color themes

Status: accepted (2026-11-16). The second step of the plugin ecosystem's order, after easy install (ADR 0025).

A plugin with the `themes` permission (API version 2) lists color themes, and Settings > Appearance offers them for Light Mode and for Dark Mode.

## Why

- Users want Devot in colors of their own, and a theme is the plugin most people install first.
- The design tokens already name every color the interface draws, so a theme can be data, with no code and no CSS.

## Rules

- `contributes.themes` lists `{ id, title, appearance, path }`: `appearance` is `light` or `dark`, and `path` is a `.json` file in the package.
- A theme file is `{ "colors": { "<token>": "#rrggbb" | "#rrggbbaa" } }`, where a token is a `--color-*` name without that prefix (`surface-editor`), at most 64 KiB and 2048 colors.
  Rust (`theme_colors`, `src-tauri/src/plugins/package.rs`) refuses a package with a file it cannot read (`E_PLUGIN_THEME_INVALID`), and the plugin kit checks it by the same rules (`src/core/plugins/themeFile.ts`).
- A file holds colors only: no CSS, fonts, URLs or sizes, so a theme cannot load anything or break the layout.
- The choice is one theme per appearance, stored in `plugins.json` (`plugin_themes`, `plugin_theme_choose`); a choice whose plugin is off, removed or no longer lists it falls back to Devot's own theme.
- Every window draws the chosen theme over the built-in tokens by setting `--color-*` on the root element, for the tokens this build knows only (`src/renderer/src/theme/pluginThemes.ts`); a token a theme leaves out keeps Devot's color.
  A window keeps the themes in effect in its local storage and draws them before Rust answers, so a window opened later paints its plugin theme first, never Devot's theme under it.
- Icon colors are not a theme's: status marks, settings tiles, tag icons and phone status tiles keep Devot's colors whatever a theme file says, so an icon keeps its meaning and contrast in every theme.

## Consequences

- A theme that changes a few tokens is a few lines; one that changes all of them follows the token list of the Devot it was made for.
- Contrast is the theme author's; Devot does not check it.
- A theme-only plugin still names a main script; making it optional is a later change.
- Custom CSS is a later decision, needed for themes that change more than colors.
