# Devot design system

Devot looks and behaves like a native macOS app: a translucent sidebar, a unified toolbar, the macOS type scale, native menus and the system's SF Symbols. Its colours are warm "paper" neutrals with a deep teal accent.

Everything in this folder is meant to be publishable as an open-source asset library. Only add assets whose licence allows that.

## Contents

| Path                                     | What it holds                                                         |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `tokens/base.tokens.json`                | Primitives: palette, font families, type scale, spacing, radii, sizes |
| `tokens/themes/system.light.tokens.json` | The default "System" theme, light appearance                          |
| `tokens/themes/system.dark.tokens.json`  | The default "System" theme, dark appearance                           |
| `icons/symbols.json`                     | Devot icon names mapped to SF Symbol names                            |
| `icons/languages.json`                   | Language marks for code block headers (third party, see below)        |
| `app-icon/dove.svg`                      | The Devot dove: the logo mark, one teal vector path                   |
| `app-icon/source.svg`                    | The app icon: the dove on a light rounded tile, 2048 px canvas        |
| `app-icon/source.png`                    | `source.svg` rendered at 2048 px; `pnpm tauri icon` makes the sizes   |

Tokens use the [W3C Design Tokens (DTCG)](https://www.designtokens.org/) format. `pnpm tokens` compiles them into `src/renderer/src/theme/tokens.css` (CSS custom properties) and `tokens.ts` (TypeScript constants); CI fails when those are stale. Components use theme tokens only, never the palette's colour primitives (`color.teal.*` and the like) and never colour literals (hex, rgb or named colours).

## Look

- **Window:** the window is transparent with the system `sidebar` effect; the sidebar shows the material through a light warm tint (`color.surface.sidebar`), while the note list and editor are opaque. Settings > Appearance can turn the material off: the sidebar then paints `color.surface.sidebar-opaque`, the same tint without transparency. The traffic lights and the sidebar toggle sit in the sidebar's top bar; a unified 52 px toolbar runs over the list and editor.
- **Type:** the system UI font (SF Pro) and SF Mono, not bundled. Body 13 pt, captions and section headers 11 pt, sidebar rows 28 px.
- **Selection:** the focused list shows its selection as an accent fill with white text; unfocused lists use a neutral fill.
- **Controls:** segmented controls, pop-up buttons and search fields follow AppKit sizes and shapes. A segmented control's selected segment is a raised neutral segment, not an accent fill.
- **Menus:** the menu bar and every context menu are native. Settings live in the app menu (Devot ▸ Settings…, ⌘,), not in the window.

## Tag colours

Tags may take one colour from a fixed palette of eight: red, orange, yellow, green, blue, purple, pink and gray (`color.tag.*` in each theme, light and dark). Notes store the palette ID, never a colour value, so a theme can restyle every tag. The colour shows as a dot in the sidebar and on tag chips.

## Activity heatmap

The Activity sheet shades each day from five theme colours, `color.activity.level-0` (an idle day) to `level-4` (the most writing), in light and dark: a warm neutral, then Devot teal at increasing strength. They are Devot's own teal, not the system accent, so the scale reads the same whatever accent the user picked.

## Contrast

Text meets WCAG AA in both appearances: 4.5:1 for text, 3:1 for graphics such as status dots, the caret and focus rings. `src/renderer/src/theme/contrast.test.ts` computes the ratios from the token values for the pairs the UI draws, so a later edit cannot drop one below it. Values chosen for this:

| Token                            | Light                | Dark                 |
| -------------------------------- | -------------------- | -------------------- |
| `color.accent.fill` (white text) | `#0e6b62` (teal 600) | `#25837a` (teal 500) |
| `color.accent.text`              | `#0d655c` (teal 700) | `#63cdbf` (teal 300) |
| `color.text.secondary`           | `#5c5952`            | `#aeaaa0`            |
| `color.text.tertiary`            | `#68655d`            | `#969288`            |
| `color.status.active`            | `#2a63c0`            | `#6898f1`            |
| `color.status.hold`              | `#905a09`            | `#e3a43a`            |
| `color.status.done`              | `#257244`            | `#46b877`            |
| `color.status.dropped`           | `#af3b36`            | `#e97873`            |
| `color.text.destructive`         | `#af3b36`            | `#f0a6a2`            |
| `color.accent.selection`         | `#d0e1df`            | `#1f3531`            |
| `color.syntax.keyword`           | `#0d655c` (teal 700) | `#63cdbf` (teal 300) |
| `color.syntax.string`            | `#395991`            | `#8fb0ea`            |
| `color.syntax.inserted`          | `#21653d`            | `#55be82`            |
| `color.syntax.deleted`           | `#9e3531`            | `#ed928e`            |
| `color.syntax.heading`           | `#a3245a`            | `#f08fb5`            |
| `color.syntax.markup`            | `#3d4fb8`            | `#a3b0f7`            |
| `color.syntax.list`              | `#9e3531`            | `#ed928e`            |

The editor selection is a solid tint of the accent fill: the fill mixed into the editor surface until the selection stands 1.3:1 from the editor and from the active line (CodeMirror draws the selection under the lines, so the active line's tint lies over it there). The values above are the teal ones; for a system accent the runtime mixes the same way, so every accent lands at the same lightness. The editor text colours (body, front matter, links and every syntax colour) keep 4.5:1 on it, also on the active line, which is why the light link and syntax colours, the dark secondary text and the editor's own inserted/deleted colours (the status green and red, deepened) are a step darker or lighter than before. Only the de-emphasised tertiary text (rules, fences, comments) drops to 3:1, on the selection only. The selection is the same colour with or without keyboard focus.

The destructive label sits on a raised button face, which is lighter than the surface in the dark appearance, so it has its own token. Tag colours are labelled dots, not text, and keep the system palette.

## Accent colour

The System theme follows the macOS accent colour. When the system accent is Multicolor, Devot uses its own teal (`color.teal.*`). The system colour is adjusted per role (`src/renderer/src/theme/accent.ts`): as a fill under white text it is darkened, the editor selection is a solid tint of that fill (as `color.accent.selection` is of teal), and as text or a link it is darkened (light) or lightened (dark), each only as far as AA needs (also on the selection), so Yellow and Green stay readable and a colour that already passes is untouched. Tokens that follow the system carry `"$extensions": {"app.devot": {"source": "system-accent"}}`; the app reads the colour from AppKit (in Rust) and updates on change.

## Long names

A pop-up button (the note's Notebook and Status pickers) grows to `size.popup-max-width`, or the width of its row in a narrow window, and cuts a longer name with an ellipsis, keeping its chevron; the note list's header title is cut off the same way and never runs under the toolbar buttons. The full name is the tooltip.

## Icons

Icons are SF Symbols, rendered by macOS at runtime through AppKit (the `symbol_png` Tauri command), then cached per name, size and appearance. This repository stores symbol names only, never symbol artwork. SF Symbols may only be used in software for Apple platforms and never in logos or app icons, so Devot's own app icon and logo must be original artwork.

## Language marks

A code block in the preview with a language shows that language's mark in its header (`icons/languages.json`, read by `src/core/preview/code.ts`). The marks are third-party artwork from [simple-icons](https://github.com/simple-icons/simple-icons) 16.35.0, one 24 x 24 path each, drawn in the text colour so they follow light and dark. The package is CC0-1.0; each entry records its own licence, and only CC0-1.0 and MIT marks are kept (JavaScript and GNU Bash are MIT). Marks under share-alike or non-commercial licences are left out, and their languages show a generic mark. Add a mark only with its licence recorded in its entry.

## Themes

- **System** (default): follows the macOS appearance and accent colour.
- **Other themes:** fully independent of the system accent. Each provides a light and a dark appearance and follows the system's light/dark switch, unless it declares a single appearance.
- Themes are DTCG token files with the same structure as the System theme. Custom CSS for advanced themes comes in phase 2 (see `docs/architecture.md`).
