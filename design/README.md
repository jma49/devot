# Devot design system

Devot looks and behaves like a native macOS app: a translucent sidebar, a unified toolbar, the macOS type scale, native menus and the system's SF Symbols. Its colours are cool neutrals with a blue accent, a violet caret and selection, and distinct Markdown colours in the editor.

Everything in this folder is meant to be publishable as an open-source asset library. Only add assets whose licence allows that.

## Contents

| Path                                     | What it holds                                                         |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `tokens/base.tokens.json`                | Primitives: palette, font families, type scale, spacing, radii, sizes |
| `tokens/themes/system.light.tokens.json` | The default theme, light appearance                                   |
| `tokens/themes/system.dark.tokens.json`  | The default theme, dark appearance                                    |
| `icons/symbols.json`                     | Devot icon names mapped to SF Symbol names                            |
| `icons/languages.json`                   | Language marks for code block headers (third party, see below)        |
| `app-icon/dove.svg`                      | The Devot dove: the logo mark, one teal vector path                   |
| `app-icon/source.svg`                    | The app icon: the dove on a light rounded tile, 2048 px canvas        |
| `app-icon/source.png`                    | `source.svg` rendered at 2048 px; `pnpm tauri icon` makes the sizes   |

Tokens use the [W3C Design Tokens (DTCG)](https://www.designtokens.org/) format. `pnpm tokens` compiles them into `src/renderer/src/theme/tokens.css` (CSS custom properties) and `tokens.ts` (TypeScript constants); CI fails when those are stale. Components use theme tokens only, never the palette's colour primitives (`color.teal.*` and the like) and never colour literals (hex, rgb or named colours).

## Look

- **Window:** the window is transparent with the system `sidebar` effect; the sidebar shows the material through a light warm tint (`color.surface.sidebar`), while the note list and editor are opaque. Settings > Appearance can turn the material off: the sidebar then paints `color.surface.sidebar-opaque`, the same tint without transparency. The traffic lights and the sidebar toggle sit in the sidebar's top bar; a unified 52 px toolbar runs over the list and editor.
- **Type:** the system UI font (SF Pro) and SF Mono, not bundled. Body 13 pt, captions and section headers 11 pt, sidebar rows 28 px. Scroll bars are 6 px wide.
- **Selection:** the focused list shows its selection as an accent fill with white text; unfocused lists use a neutral fill.
- **Controls:** segmented controls, pop-up buttons and search fields follow AppKit sizes and shapes. A segmented control's selected segment is a raised neutral segment, not an accent fill.
- **Menus:** the menu bar and every context menu are native. Settings live in the app menu (Devot ▸ Settings…, ⌘,), not in the window.

## Tag colours

Tags may take one colour from a fixed palette of eight: red, orange, yellow, green, blue, purple, pink and gray (`color.tag.*` in each theme, light and dark). Notes store the palette ID, never a colour value, so a theme can restyle every tag. The colour shows as a dot in the sidebar and on tag chips.

## Activity heatmap

The Activity sheet shades each day from five theme colours, `color.activity.level-0` (an idle day) to `level-4` (the most writing), in light and dark: a warm neutral, then Devot teal at increasing strength. They are Devot's own teal, not the system accent, so the scale reads the same whatever accent the user picked.

## Contrast

Text meets WCAG AA in both appearances: 4.5:1 for text, 3:1 for graphics such as status dots, the caret and focus rings. `src/renderer/src/theme/contrast.test.ts` computes the ratios from the token values for the pairs the UI draws, so a later edit cannot drop one below it. The palette starts from a set of design values; where one fails its pair it is moved toward black (light) or white (dark) only as far as AA needs, keeping its hue, and the token's `$description` records the design value and how far it moved. The values in effect:

| Token                             | Light     | Dark      |
| --------------------------------- | --------- | --------- |
| `color.accent.fill` (white text)  | `#3472d6` | `#4576b2` |
| `color.accent.text`               | `#2856a2` | `#7ea6d8` |
| `color.accent.selection`          | `#e3d6fb` | `#29233a` |
| `color.accent.selection-inactive` | `#f3edfd` | `#18151f` |
| `color.text.secondary`            | `#595959` | `#a3a3a3` |
| `color.text.tertiary`             | `#676767` | `#8f8f8f` |
| `color.status.active`             | `#545d69` | `#94a3b8` |
| `color.status.hold`               | `#7f5305` | `#f59f0a` |
| `color.status.done`               | `#096848` | `#10b77f` |
| `color.status.dropped`            | `#94414e` | `#fb7085` |
| `color.syntax.heading`            | `#ab205e` | `#f471b5` |
| `color.syntax.link`               | `#09665f` | `#14b8a5` |
| `color.syntax.comment`            | `#535b67` | `#9ca3b0` |
| `color.syntax.list`               | `#4c4eb8` | `#8c8ff5` |
| `color.syntax.list-alt`           | `#93440c` | `#f97415` |
| `color.syntax.markup`             | `#1e53c5` | `#61a6fa` |
| `color.syntax.keyword`            | `#6d34d1` | `#a689fa` |
| `color.syntax.string`             | `#0e692f` | `#36d399` |
| `color.syntax.function`           | `#06637b` | `#67e8f9` |
| `color.syntax.invalid`            | `#a72f2f` | `#f36e6e` |
| `color.alert.note`                | `#2959a7` | `#5d98f8` |
| `color.alert.tip`                 | `#116831` | `#21c45d` |
| `color.alert.important`           | `#773caf` | `#bb7af9` |
| `color.alert.warning`             | `#93440c` | `#f97415` |
| `color.alert.caution`             | `#a72f2f` | `#f36e6e` |

The editor selection is a solid tint of the caret colour (`color.editor.caret`): the caret mixed into the editor surface until the selection stands 1.3:1 from the editor and from the active line (CodeMirror draws the selection under the lines, so the active line's tint, `color.editor.active-line`, lies over it there). That is the least that reads, so the editor's text colours lose as little contrast on it as they can. While the editor does not have focus the selection is the same mix at 13/30 of the strength. The editor text colours (body, front matter, links, every syntax and alert colour) keep 4.5:1 on the editor, on the active line and on both selections, which is why the light syntax colours are deeper than their design values. Only the de-emphasised tertiary text (section labels, rules) drops to 3:1, on the selection only.

The destructive label sits on a raised button face, which is lighter than the surface in the dark appearance, so it has its own token. Tag colours are labelled dots, not text, and keep the system palette.

## Accent colour

Devot uses its own blue accent unless Settings > Appearance > "Use the system accent colour" is on; then the accent follows the macOS accent colour, and Multicolor keeps Devot's blue. The system colour is adjusted per role (`src/renderer/src/theme/accent.ts`): as a fill under white text it is darkened, the editor selection is a solid tint of that fill (as `color.accent.selection` is of the caret), and as text or a link it is darkened (light) or lightened (dark), each only as far as AA needs (also on the selection), so Yellow and Green stay readable and a colour that already passes is untouched. Tokens that can follow the system carry `"$extensions": {"app.devot": {"source": "system-accent"}}`; the app reads the colour from AppKit (in Rust) and updates on change.

## Appearance

Settings > Appearance offers Light, Dark and Match System (the default), as cards with a small preview of each. A chosen appearance sets `data-appearance` on the root element, and the generated stylesheet applies that appearance's tokens whatever the system shows; Rust gives every window the same theme, so the window material and native controls match. An element with `data-appearance-preview="light|dark"` shows that appearance's tokens inside it (the cards' previews).

## Markdown in the editor

The editor keeps the Markdown source and shapes it with decorations (`src/renderer/src/editor/lineStyles.ts`): heading lines at `font.size.editor-h1` to `-h3` (level 4 and below at body size) in the heading colour, their `#`s in the markup colour; list marks in `color.syntax.list`, alternating with `color.syntax.list-alt` by depth; task boxes bold in the markup colour and a done task's text struck through; inline code in a chip around the code only (`color.editor.code-fill`, `color.editor.code-border`, `radius.mark`); `<mark>` text on `color.editor.mark-fill` with a 2 px `color.editor.mark-line` underline and its tags small in the markup colour; quote lines with a 3 px `color.editor.quote-bar` and italic `color.syntax.quote` text, an alert's bar and `[!KIND]` in its `color.alert.*`; and tables in the same box as code, pipes in the markup colour and the header row bold.

## Long names

A pop-up button (the note's Notebook and Status pickers) grows to `size.popup-max-width`, or the width of its row in a narrow window, and cuts a longer name with an ellipsis, keeping its chevron; the note list's header title is cut off the same way and never runs under the toolbar buttons. The full name is the tooltip.

## Icons

Icons are SF Symbols, rendered by macOS at runtime through AppKit (the `symbol_png` Tauri command), then cached per name, size and appearance. This repository stores symbol names only, never symbol artwork. SF Symbols may only be used in software for Apple platforms and never in logos or app icons, so Devot's own app icon and logo must be original artwork.

## Language marks

A code block in the preview with a language shows that language's mark in its header (`icons/languages.json`, read by `src/core/preview/code.ts`). The marks are third-party artwork from [simple-icons](https://github.com/simple-icons/simple-icons) 16.35.0, one 24 x 24 path each, drawn in the text colour so they follow light and dark. The package is CC0-1.0; each entry records its own licence, and only CC0-1.0 and MIT marks are kept (JavaScript and GNU Bash are MIT). Marks under share-alike or non-commercial licences are left out, and their languages show a generic mark. Add a mark only with its licence recorded in its entry.

## Themes

- **Default**: Devot's palette in the appearance chosen in Settings (the system's by default), optionally with the system accent.
- **Other themes:** fully independent of the system accent. Each provides a light and a dark appearance and follows the system's light/dark switch, unless it declares a single appearance.
- Themes are DTCG token files with the same structure as the System theme. Custom CSS for advanced themes comes in phase 2 (see `docs/architecture.md`).
