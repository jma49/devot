# Devot design system

Devot looks and behaves like a native macOS app: a translucent sidebar, a unified toolbar, the macOS type scale, native menus and the system's SF Symbols. Its colours are cool neutrals with a blue accent, a violet caret and selection, and distinct Markdown colours in the editor.

Everything in this folder is meant to be publishable as an open-source asset library. Only add assets whose licence allows that.

## Contents

| Path                                     | What it holds                                                         |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `tokens/base.tokens.json`                | Primitives: palette, font families, type scale, spacing, radii, sizes |
| `tokens/themes/system.light.tokens.json` | The default theme, light appearance                                   |
| `tokens/themes/system.dark.tokens.json`  | The default theme, dark appearance                                    |
| `tokens/themes/ivory.light.tokens.json`  | The Ivory theme, light appearance                                     |
| `tokens/themes/ivory.dark.tokens.json`   | The Ivory theme, dark appearance                                      |
| `icons/symbols.json`                     | Devot icon names mapped to SF Symbol names                            |
| `icons/languages.json`                   | Language marks for code block headers (third party, see below)        |
| `app-icon/dove.svg`                      | The Devot dove: the logo mark, one teal vector path                   |
| `app-icon/source.svg`                    | The app icon: the dove on a light rounded tile, 2048 px canvas        |
| `app-icon/source.png`                    | `source.svg` rendered at 2048 px; `pnpm tauri icon` makes the sizes   |

Tokens use the [W3C Design Tokens (DTCG)](https://www.designtokens.org/) format. `pnpm tokens` compiles them into `src/renderer/src/theme/tokens.css` (CSS custom properties) and `tokens.ts` (TypeScript constants); CI fails when those are stale. Components use theme tokens only, never the palette's colour primitives (`color.teal.*` and the like) and never colour literals (hex, rgb or named colours).

## Look

- **Window:** the window is transparent with the system under-window background material behind all of it, always active; each region shows it through its own wash: the sidebar `color.surface.sidebar`, the note list `color.surface.list-wash`, the editor pane `color.surface.editor-wash` (the editor itself is transparent). The toolbar has no wash of its own; pop-ups and menus stay opaque. Settings > Appearance > Transparency, a slider from Opaque to Transparent that starts at these washes (with a Reset back to them), adjusts every wash's alpha a to 1 - (1 - a) x (1 + level / 100), clamped, for a level from -100 (opaque) through 0 (as designed) to 100 (twice as clear). Settings > Appearance can turn the material off: the window then paints `color.surface.window` and the regions `color.surface.sidebar-opaque`, `color.surface.list` and `color.surface.editor`. The traffic lights sit in the sidebar's top bar, and the sidebar toggle at the start of the note list's header (after `size.window-controls-inset` of room for the traffic lights while the sidebar is hidden); a unified 52 px toolbar runs over the list and editor, and the traffic lights sit on its centre line.
- **Type:** the system UI font (SF Pro) and SF Mono, not bundled. Body 13 pt, captions and section headers 11 pt, sidebar rows 30 px with no gap between them. Scroll bars are 6 px wide.
- **Selection:** the sidebar draws a selected row with an accent wash (`color.fill.row-selected-unemphasized`) while it does not have the keyboard, a solid `color.accent.fill` with `color.accent.on-fill` text and marks while it does. The note list draws every selected row with a wash of `color.accent.fill` at `opacity.list-selected`, focused or not, and its text keeps its colours; while the list has the keyboard, the open note's row also has a `size.list-focus-bar` bar in `color.accent.fill` on its left edge.
- **Text and lines:** tiers of one ink per appearance (`color.ink.text`, `color.ink.line`). Text: body 87%, under the pointer 80%, secondary 60%, placeholders and disabled 40%, selected 95% (`color.text.*`, each naming its tier); a tier is the ink over the editor, moved toward black or white only where contrast needs it. Lines: borders 15% (light) or 10% (dark), internal dividers 10% (`color.line.hairline`, `color.line.separator`).
- **Surfaces:** the sidebar sits furthest from the editor, the note list one small step closer, the editor at the end; panes are divided by 1 px lines, never shadows. Floating things rest on the two-layer pop-up shadow.
- **Focus:** custom controls show one ring, `size.focus-ring` wide in `color.focus.ring` on their edge (just inside a control that clips, such as a scroll list); native form controls keep the system ring. The ring is the accent fill at a design strength of 40% (light) or 30% (dark), raised to the least that keeps 3:1 on every surface (79% and 97%); with the system accent it is worked out the same way (`theme/accent.ts`).
- **Disabled:** a control that cannot be used shows at `opacity.disabled`.
- **Controls:** segmented controls, pop-up buttons and search fields follow AppKit sizes and shapes. A segmented control's selected segment is a raised neutral segment, not an accent fill.
- **Floating bars:** the selection toolbar and the image size bar float over the editor on `color.surface.float-bar` (`radius.floating-bar`, a soft `color.line.shadow`), with a notch pointing at the text; a button under the pointer gets a round `color.line.control` ring, and tooltips show the command's key in a chip. The link dialog uses the same surface with `radius.dialog`.
- **Menus:** the menu bar and every context menu are native. Settings live in the app menu (Devot ▸ Settings…, ⌘,), not in the window.

## Tag colours

Tags may take one colour from a fixed palette of eight: red, orange, yellow, green, blue, purple, pink and gray (`color.tag.*` in each theme, light and dark). Notes store the palette ID, never a colour value, so a theme can restyle every tag. The colour shows as a dot in the sidebar and on tag chips. A coloured tag's chip mixes its colour with transparent: fill at `opacity.tag.fill` (10%), edge at `opacity.tag.border` (20%), and under the pointer or pressed 20% and 30%; its label is `color.tag-text.*`, the tag colour moved toward black (light) or white (dark) only as far as 4.5:1 on the chip needs. The dot is the colour at `opacity.tag.dot` (30%) inside a solid edge. The strengths are the same in both appearances; only the colours change.

## Activity heatmap

The Activity sheet shades each day from five theme colours, `color.activity.level-0` (an idle day) to `level-4` (the most writing), in light and dark: a warm neutral, then Devot teal at increasing strength. They are Devot's own teal, not the system accent, so the scale reads the same whatever accent the user picked.

## Contrast

Text meets WCAG AA in both appearances: 4.5:1 for text, 3:1 for graphics such as status dots, the caret and focus rings. `src/renderer/src/theme/contrast.test.ts` computes the ratios from the token values for the pairs the UI draws, so a later edit cannot drop one below it. The palette starts from a set of design values; where one fails its pair it is moved toward black (light) or white (dark) only as far as AA needs, keeping its hue, and the token's `$description` records the design value and how far it moved. The values in effect:

| Token                             | Light     | Dark      |
| --------------------------------- | --------- | --------- |
| `color.accent.fill` (white text)  | `#3472d6` | `#4576b2` |
| `color.accent.text`               | `#2856a2` | `#7ea6d8` |
| `color.accent.selection`          | `#e3d6fb` | `#29233a` |
| `color.accent.selection-inactive` | `#efe7fd` | `#1d1927` |
| `color.text.secondary`            | `#595959` | `#a3a3a3` |
| `color.text.tertiary`             | `#676767` | `#909090` |
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

A code block in the preview with a language shows that language's mark in its header (`icons/languages.json`, read by `src/core/preview/code.ts`). The marks are third-party artwork from [simple-icons](https://github.com/simple-icons/simple-icons) 16.35.0, one 24 x 24 path each, drawn in the text colour so they follow light and dark. The package is CC0-1.0; each entry records its own licence, and only CC0-1.0 and MIT marks are kept (JavaScript and GNU Bash are MIT). The GitHub mark heads a code block whose `url=` points at github.com; it is not tied to a language. Marks under share-alike or non-commercial licences are left out, and their languages show a generic mark. Add a mark only with its licence recorded in its entry.

## Preview blocks

The preview draws its blocks from their own theme tokens: `color.code-block.*` and `color.code-header.bg` for code, `color.table.head` and `color.table.stripe` for tables, `color.quote.bar`, `color.mark.bg` for highlighted text, `color.fill.card` for the note info card, and `color.alert.*` for the five alert kinds (note blue, tip green, important purple, warning orange, caution red), each in light and dark. Alert titles keep 4.5:1 on the editor (`contrast.test.ts`). The small line icons drawn into a note's content (alert kinds, note statuses, a broken link) are Devot's own drawings in `src/core/preview/glyphs.ts`, stroked in the text colour.

## Motion

Floating things move by the `motion.*` tokens; a policy test rejects literal durations and curves in UI code.

- Hover, press and selection: a control's fill, colour and edge ease over `motion.duration.hover` (180 ms, `motion.easing.out`). Two-state changes (a disclosure chevron turning, a section opening) take `motion.duration.toggle` (200 ms); colour changes meant to be noticed take `motion.duration.color` (400 ms).
- Hiding or showing the sidebar (or entering focus mode): the pane that goes or comes fades and leaves or takes its room at once, and the panes that stay slide to their new places over `motion.duration.slide` (400 ms, `motion.easing.slide`). A toolbar's room for the traffic lights opens and closes over `motion.duration.inset` (300 ms, `motion.easing.out`).
- A toolbar button's tooltip shows after the pointer rests `motion.delay.tooltip` (400 ms) and hides at once.

- Floating bar buttons (selection toolbar, image size bar): under the pointer and pressed look the same, a `color.line.control` ring over `color.fill.tool-hover`. The text colour eases over `motion.duration.color` (`motion.easing.standard`), the ring over `motion.duration.ring` (`motion.easing.out`); the fill snaps.
- Pop-ups we place ourselves (pickers, tag suggestions, toolbar tooltips, a bar button's tooltip) grow from `motion.scale.popover-enter` out of their notch or anchor while they fade in, over `motion.duration.popover`, on their own layer. They rest on the two-layer `shadow.popover-*` shadow in the `color.shadow.popover-*` colours; menus (pickers, tag suggestions) have a 1px hairline edge and `radius.card` corners, and toolbar tooltips a notch pointing at their button.
- Pop-ups CodeMirror places (the floating bars, completion lists) and a code block's copy button only fade, over `motion.duration.fade`: CodeMirror places a tooltip from its measured box, which a growing one would throw off.
- Closing runs the opening backwards: pickers, tag suggestions and tooltips shrink to `motion.scale.popover-exit` toward the same notch or anchor while they fade out, over `motion.duration.popover`; floating bars and completion lists only fade out, over `motion.duration.fade`. The pop-up itself goes at once, so focus, keys and the accessibility tree move on without waiting; an inert copy that assistive tech does not see plays the motion where it was (`closing.ts`), and a pop-up that opens again replaces its copy.
- Reduce Motion sets `--popover-enter-scale` and `--popover-exit-scale` to 1 (`app.css`) and stops chevrons turning and sections sliding open: everything fades, nothing grows, shrinks, turns or slides.

## Themes

- **Default**: Devot's palette in the appearance chosen in Settings (the system's by default), optionally with the system accent.
- **Other themes:** fully independent of the system accent. Each provides a light and a dark appearance and follows the system's light/dark switch, unless it declares a single appearance.
- Themes are DTCG token files with the same structure as the System theme: every colour token of `system.*.tokens.json` and no other (a test fails on a missing or an extra one). Custom CSS for advanced themes comes in phase 2 (see `docs/architecture.md`).
- **Choosing one:** Settings > Appearance > Theme offers Default and Ivory as cards that show each in both appearances. The choice is the `theme` editor setting; a chosen theme other than Default is `data-theme` on the root element, and each built-in theme's rules in `tokens.css` are scoped by it (`scripts/tokens/themes.ts` lists them). An element with `data-theme-preview="ivory"` and `data-appearance-preview="light|dark"` shows that theme's tokens inside it. The default theme's output does not change when a theme is added.

### Ivory

A warm theme: ivory surfaces and warm near-black text (light), warm charcoal and ivory text (dark). Typography and icons are the default theme's. The accent is Devot's own blue, the System theme's accent tokens; Ivory does not follow the macOS accent colour, so "Use the system accent colour" is disabled, with a hint, while Ivory is chosen. Row selection follows the System theme's recipe (an accent wash on an unfocused list, the solid accent fill on a focused one, the same strengths), and the pop-up shadow uses the System theme's strengths cast from `#1f1e1d`.

| Token                                                    | Light                          | Dark                                          |
| -------------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| `color.surface.sidebar` (material)                       | `#f5f4ed` at 2%                | `#1f1e1d` at 10%                              |
| `color.surface.sidebar-opaque`                           | `#f5f4ed`                      | `#1f1e1d`                                     |
| `color.surface.list`                                     | `#faf9f5`                      | `#262624`                                     |
| `color.surface.list-wash` (material)                     | `#faf9f5` at 80%               | `#262624` at 50%                              |
| `color.surface.editor`                                   | `#ffffff`                      | `#30302e`                                     |
| `color.surface.editor-wash` (material)                   | `#ffffff` at 70%               | `#30302e` at 60%                              |
| `color.surface.window`                                   | `#ffffff`                      | `#1f1e1d`                                     |
| `color.surface.popover`                                  | `#ffffff`                      | `#353533`                                     |
| `color.surface.float-bar`                                | `#ffffff`                      | `#353533`                                     |
| `color.text.primary`, `color.text.editor`                | `#141413`                      | `#faf9f5`                                     |
| `color.text.secondary`                                   | `#3d3d3a`                      | `#c2c0b6`                                     |
| `color.text.tertiary`                                    | `#696862` (design `#73726c`)   | `#aba9a2` (design `#9c9a92`)                  |
| `color.text.placeholder`, `.disabled`                    | primary at 50% over the editor | primary at 50% over the editor                |
| `color.line.hairline`, `.separator`                      | `#1f1e1d` at 15%               | `#faf9f5` at 10%                              |
| `color.line.control`                                     | `#1f1e1d` at 30%               | `#faf9f5` at 30%                              |
| `color.alert.note` (info)                                | `#2e5d9d` (design `#3266ad`)   | `#80aadd`                                     |
| `color.alert.caution`, destructive (danger)              | `#7f2c28`                      | `#ee8a86` (design `#ee8884`); label `#f3a9a6` |
| `color.alert.tip`, `color.status.done` (success)         | `#265b19`                      | `#7ab948`; status `#9aca74`                   |
| `color.alert.warning`, `color.status.hold` (warning)     | `#5a4815`                      | `#d1a041`; status `#dcb870`                   |
| `color.status.active`                                    | `#5e5d59`                      | `#bebcb7`                                     |
| `color.status.dropped`                                   | `#7f2c28`                      | `#f3aba8`                                     |
| `color.alert.important`                                  | `#6b4a9a`                      | `#b8a3e3`                                     |
| `color.accent.fill` (text on it: `color.accent.on-fill`) | `#3472d6` (white)              | `#5884ba` (`#141413`)                         |
| `color.accent.text`                                      | `#2856a2`                      | `#a2bfe3`                                     |
| `color.accent.selection` / `-inactive`                   | `#e3d6fb` / `#efe7fd`          | `#1c1828` / `#27262b`                         |

The tag colours keep their hues in warm, softer tints (red `#c8483c`, orange `#d97a2b`, yellow `#c99a1f`, green `#4f9a3a`, blue `#3f7fc4`, purple `#8a5cc0`, pink `#cc5a85`, gray `#8a8982` in light; `#e5776d`, `#e8955a`, `#d9ae4a`, `#82c261`, `#6aa3de`, `#b394e0`, `#e48aab`, `#a3a199` in dark); each chip label is the tag colour moved toward black (light) or white (dark) as far as 4.5:1 on its chip needs. Syntax colours are the default theme's, warm-shifted only for quote and comment (warm greys), and moved only where a pair failed. The menu row hover (`color.fill.hover`) is the warm ink at 5% (light) or 8% (dark), and the dim behind a dialog (`color.fill.backdrop`) is `#1f1e1d` at 30% (light) or 50% (dark; the dark surfaces are close to that ink, so it needs more). The kit's "strong" line (40%) has no counterpart token, so no token uses it.

Ivory is held to the same pairs as the default theme in `contrast.test.ts` (4.5:1 for text, 3:1 for marks), in light and dark. The palette values above are the design values; these moved, each only as far as the pair needed:

- Light: `color.text.tertiary` `#73726c` to `#696862` (3.32:1 on the lightest tinted fill it sits on); `color.alert.note` `#3266ad` to `#2e5d9d` (3.97:1 on the selection); `color.syntax.comment` and `.markup` by a step (4.48 and 4.43).
- Dark: the editor is lighter than the default theme's, so more had to move. `color.text.tertiary` `#9c9a92` to `#aba9a2` (3.80:1 on the unfocused selected row); `color.text.destructive` `#ee8884` to `#f3a9a6` (2.70:1 on a raised button face; the face is the primary text at 14% over the surface, a lighter step than the default theme's 22%); the status colours `active`, `hold`, `done` and `dropped` to `#bebcb7`, `#dcb870`, `#9aca74` and `#f3aba8` (3.0 to 3.6:1 on the selected-row wash); `color.alert.caution` and `color.syntax.list-alt` by a step.
- Dark accent: white text on the System theme's dark blue `#4576b2` (4.5:1) and that blue against the lighter editor (3:1) cannot both hold, so the fill is lightened to `#5884ba` and the text on it is the warm ink `#141413`; the accent text and links become `#a2bfe3` (3.40:1 on the selected-row wash). The focus ring is the fill at 90% (the least that keeps 3:1 on every surface; the System theme's is 97% of its own fill).
- Dark selection: the System theme's `#29233a` stands only 1.14:1 from the lighter editor, so the selection is `#1c1828`, a recessed tint (1.3:1 from the editor and from the active line); the inactive one is the same tint at 13/30 of its strength.
