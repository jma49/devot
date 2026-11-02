# Glass layout

The spec for how the Glass interface sits on the screen. Everything here applies under `:root[data-sidebar-material='on']`; Classic is untouched, and exports and print keep their look unless a section says otherwise. A new element snaps to these rules; a new rule goes here with its tokens and tests.

The aim is a calm screen. Space says what a rule, an outline or a colour would repeat, so reach for space first.

## Keylines

Each column has one outer line, for backgrounds and fields, and one inner line, for text. Positions are in points from the column's left edge.

| Column    | Outer                                                                                    | Inner                                         | Tokens                                                                     |
| --------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| Sidebar   | 8 (row highlights)                                                                       | icon 18, label 44; captions on 18             | `size.sidebar-inset`, `size.sidebar-row-padding`, `size.sidebar-icon-slot` |
| Note list | 12 (search field, row highlights, the sort row's right end, right side from the divider) | 24 (sort label, captions, row text)           | `size.list-keyline-outer`, `size.list-keyline-inner`                       |
| Editor    | 32 from the divider and the window edge                                                  | the same 32 for title, pills, text and blocks | `size.editor-keyline`                                                      |

- **Toolbar:** every control is a 32 pt capsule centred on y = 26, the traffic lights' centre line. Toolbar groups start and end on the column's keylines.
- **Sidebar depth:** a top-level notebook has no extra indent. Each deeper level steps 16, and the chevron hangs in the row's padding without pushing the row.
- **Split view:** each pane uses the editor keyline inside its own width.
- **Scroll bars:** `.rows`, `.preview` and the editor always reserve the scroll bar, pulled out of the keyline, so right edges stay put.
- **Exceptions:** in focus mode the editor toolbar starts at `window-controls-inset`, and with the sidebar hidden the list toolbar keeps its start padding, so neither meets the traffic lights. The Settings toolbar keeps its own corner rule.

## Separators and captions

- List sections have no rule between them. A later section gets `size.list-section-gap` (14) more space above it.
- One caption style for the sidebar and the list (`.section-header`, `.list-section`): caption size (11), semibold, tertiary text, no icon.
- Footnotes on screen start with a 48 pt hairline (`size.footnote-rule`) on the text's edge, with text at footnote size (12) in secondary. Print keeps the full-width rule.

## Note rows

- A grid with gap 4, so a missing line leaves no hole. Padding 10 top, 11 bottom, 12 sides. Rows sit 2 apart, with no separators.
- **Line 1:** title 13 semibold on one line, with the time (11, tertiary) on its baseline.
- **Optional meta line:** 11 pt, items 6 apart. A meta line holding only the time leaves the grid.
- **Excerpt:** 12, line height 1.45, two lines, secondary.

## One stroke rule

A control or block in a note is filled or outlined, never both, and a dashed border is not used at rest. Tables (hairline edge) and callouts (tinted edge) are the only bordered blocks.

- **Pills** (notebook, status, tag): `color.fill.card`, no border, a 26 pt capsule (`size.note-pill`) with 10 sides (`size.note-pill-pad`), 6 apart. Hover uses `color.fill.tool-hover`. Coloured tags keep their tint.
- **Add Tag:** the text "+ Tag" in tertiary with 8 padding. A dashed focus-ring outline shows only while it holds the keyboard.
- **Code:** fill only. Blocks use `radius.list-row` (12), inline code `radius.inline-code` (5), in the preview and the editor.

## Note type scale

Tokens: `note.heading.glass.*`, `note.space.*`. Size / line height:

| Element | Type                      | Space               |
| ------- | ------------------------- | ------------------- |
| Title   | 28/34 bold, tracking -0.4 | pills 10 below      |
| H1      | 22/28                     |                     |
| H2      | 19/24                     | 26 above, 8 below   |
| H3      | 16/22 semibold            | 20 above, 6 below   |
| Body    | 14, line height 1.6       | paragraphs 12 apart |

In the preview the body starts 22 under the pills (the note info card, when shown, comes first); the editor keeps 8. The user's font size is the base: the preview scales by its setting over 15, the editor's heading lines by theirs over 13. The title-to-pills and pills-to-body spacing stays fixed.

## Colour

Accent means something: the selected row's icon, the active view segment. Icons and counts are otherwise secondary and tertiary, while status and tag colours stay, being data. `design/README.md` (Icons, Selection) has the detail.

## Diagrams

The house style for Mermaid, in the app and in exports. Colours are read from the live tokens at render time and diagrams redraw on an appearance or theme change; exports always use the light palette.

- **Nodes:** `radius.diagram-node` (9), `color.fill.card`, a `size.diagram-node-edge` (0.5) edge in `color.line.hairline`, text in the UI font at footnote size (12) in `color.text.primary`.
- **Edges:** `size.diagram-edge` (1) in `color.text.tertiary`, with arrowheads `size.diagram-arrow-length` (6) by `size.diagram-arrow-width` (8).
- **Edge labels:** caption size (11), `color.text.secondary` on `color.surface.sheet`, `size.diagram-label-gap` (1) beside the line, not over it.
- **Data colours:** charts (pie, gantt, git graph, journey and the like) use the tag colours, opaque, since a card's translucent fill cannot tell series apart.
- **Limits:** sequence diagrams follow the colours and font only. A label clears straight horizontal and vertical segments; on a slanted edge it may touch the line.
