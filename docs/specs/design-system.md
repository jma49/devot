# Design system

Part of the [architecture overview](../architecture.md).
The native look of the interface, its menus, lists and keyboard, is in [native-look.md](native-look.md).

- Direction: native macOS structure with cool neutrals, a blue accent and distinct Markdown colours in the editor.
  Details in `design/README.md`.
- Assets live in `design/`, to the standard of an open-source asset library:
  - Design tokens in W3C Design Tokens (DTCG) JSON: `design/tokens/`.
    A build step generates CSS custom properties and TypeScript constants.
  - Icons are SF Symbols rendered at runtime; `design/icons/symbols.json` maps Devot icon names to symbol names.
    No symbol artwork is stored in the repository (license finding: `docs/adr/0001-sf-symbols-rendered-at-runtime.md`).
  - Fonts are the system's (SF Pro, SF Mono) and are not bundled.
    Any bundled font must have an open license (such as OFL).
- Every asset comes from a source that can be open-sourced.
  Devot's app icon and logo must be original artwork: the dove in `design/app-icon/` (`dove.svg` the mark, `source.svg` the flat app icon, `AppIcon.icon` the layered one; `design/README.md`, App icon).
  `pnpm app-icon` makes `src-tauri/icons/` from them.
- The bundle lists the layered icon, which Tauri compiles with `actool` into `Assets.car` (named by `CFBundleIconName`; what macOS 26 shows), and keeps `icon.icns` as `CFBundleIconFile`, the fallback.
  Without `actool` from Xcode 26 or later (the Command Line Tools alone have none) the bundler only logs and leaves `Assets.car` out, so the release workflow checks that the bundle has it.
  Under the Node CLI the bundler starts `actool` with stdin closed, and `actool` then crashes (tauri-apps/tauri#15315): `pnpm tauri` (and so `pnpm build` and the release workflow) puts `scripts/shims/` first on PATH, whose `actool` runs the real one with an empty stdin.
  Remove the shim once the bundler does that itself (tauri-apps/tauri#15991).
  A crashed `actool` can leave an `ibtoold` behind that fails the next runs too; `killall ibtoold` clears it.
- _Open:_ whether `design/` becomes its own repository.

## Theming

- **Default theme:** Devot's palette in the appearance chosen in Settings > Appearance: Light, Dark or Auto (the default, CSS `prefers-color-scheme`).
  A chosen appearance is `data-appearance` on the root element, which the generated tokens read, and Rust gives every window that theme (`editor_settings::announce`).
  The accent is Devot's blue unless "Use the System Accent Color" is on: then Rust reads the accent from AppKit for both appearances and pushes changes from `AppleColorPreferencesChangedNotification`, and the UI sets `--system-accent-fill-<appearance>`, `--system-accent-text-<appearance>`, `--system-accent-selection-<appearance>` and `--system-accent-selection-inactive-<appearance>` (solid tints of the fill that stand 1.3:1 from the editor and the active line, behind selected editor text) (`src/renderer/src/theme/accent.ts`).
  The system colour is used raw for neither: yellow or green under white text would be 1.6:1 to 2.4:1, so each role takes the system colour moved toward black or white only as far as WCAG AA (4.5:1) needs (`contrast.ts`; a colour that already passes is left alone): the fill under the on-fill colour, the text and links on the surfaces, the fills drawn over them and the editor selection.
  Multicolor, or the option off, removes the overrides and the tokens fall back to Devot's palette.
- **Contrast:** every colour pair the UI draws meets WCAG AA in light and dark (4.5:1 for text, 3:1 for marks such as status dots and the caret), for the default palette and for every system accent.
  `src/renderer/src/theme/contrast.test.ts` computes the ratios from the token values, so a token edit that drops a pair below the line fails the unit tests.
  The editor's colours come from the same tokens: its highlight style (`editor/markdown.ts`) and theme (`editor/theme.ts`) use theme variables only, never CodeMirror's light-only defaults, and `tests/ui-csp` reads the computed colours of a link, a rule, the active line, the gutter and the selection in both appearances.
- **Tokens build:** `pnpm tokens` compiles `design/tokens` into `src/renderer/src/theme/tokens.css` and `tokens.ts` (committed); `pnpm tokens:check` fails CI when they are stale.
  Each built-in theme besides the default is listed in `scripts/tokens/themes.ts` and compiled from its own `design/tokens/themes/<id>.light|dark.tokens.json`; a test fails when a theme lacks a token of the default theme or has an extra one.
  Only theme colours and non-colour base tokens are exported, and a policy test rejects colour literals in UI styles.
- **Other themes:** independent of the system accent.
  Each provides light and dark appearances and follows the system's light/dark switch, unless it declares a single appearance.
  The built-in one is Ivory, a warm theme.
  The gradient themes (Dawn, Tide, Sage, Ember) are the default theme plus a translucent gradient over the sidebar and the note list (`--backdrop`, from `design/tokens/backdrops.tokens.json`); they follow the system accent like Default.
- **Theme setting:** each appearance has its own theme: Settings > Appearance > Light Mode and Dark Mode each choose Default, Ivory or a gradient, and the one for the appearance shown is marked Active.
  They are the `lightTheme` and `darkTheme` editor settings (`default`, `ivory`, `dawn`, `tide`, `sage` or `ember`), stored with the other editor settings, validated in Rust (`editor_settings::Theme`; an unknown stored value reads as Default, an unknown value in a change is refused with `E_EDITOR_SETTINGS_INVALID`) and sent to every window with the other settings (`editor_settings::announce`).
  A settings file from before them holds one `theme`, which fills whichever of the two it lacks (in Rust when the file is read, and in `parseEditorSettings`); the next write leaves `theme` out.
  The page marks the root element with the theme for the appearance it shows, `data-theme='ivory'` (`themeInEffect`, `theme/appearance.ts`; Default leaves it off), and marks it again when the system's appearance switches while the window follows it.
  The generated stylesheet scopes each built-in theme by that attribute, after the default theme's rules and one attribute heavier, so a theme wins in every combination of theme, chosen appearance and system appearance; `[data-theme-preview]` shows a theme in a card whatever the page has.
  Ivory ignores the system accent, so "Use the System Accent Color" is hidden while it is the theme in effect.
- **Token themes (phase 1):** a theme is a DTCG token file with the same structure as `design/tokens/themes/system.*.tokens.json`.
  Built-in themes use this format too.
- **Custom CSS (phase 2):** user CSS loads in `@layer user`, after the app's own layers.
  It targets stable `data-devot-part` attributes, which are a documented, versioned surface; class names are not.
  The CSP blocks external `url()` loads, so a theme cannot send data out.
