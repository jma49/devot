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

- **Toolbar:** every control is a 32 pt capsule centred on y = 26, the traffic lights' centre line. Toolbar groups start and end on the column's keylines. The editor toolbar ends with Write Mode (a 32 pt circle, a `.tool`), the Edit, Split and Preview group (three `size.view-segment-width` segments) and More, `space.4` apart, the last on the editor's right keyline.
- **Sidebar depth:** a top-level notebook has no extra indent. Each deeper level steps 16, and the chevron hangs in the row's padding without pushing the row. The guide runs from an open notebook's icon down its children, drawn per child row; where it meets a row's chevron it breaks `space.1` clear of the chevron's 14 px box (an 18 px gap centred on the row) and continues above and below.
- **Outline:** a column `size.outline-width` (220) at the editor pane's right edge, beside the scroll bar's reserve, with rows of body size on `space.3` sides; each level steps `space.7`. It is hidden in focus mode and when the panes would fall below `size.pane-min-width` each.
- **Write mode's table bar:** above the rendered table, outside the grid, on the table's left edge (`BAR_GAP` clear of the header row). The table's first row line always carries a bar's height plus `BAR_GAP` of padding above the header, so the bar sits in that space and never covers the block above. When the editor has no room above the table the bar stays at the top of the visible part of the table, below the header row, and never covers it. Edit mode keeps the bar over the row above the caret.
- **Split view:** each pane uses the editor keyline inside its own width.
- **Scroll bars:** `.rows`, `.preview` and the editor always reserve the scroll bar, pulled out of the keyline, so right edges stay put.
- **Exceptions:** in focus mode the editor toolbar starts at `window-controls-inset`, and with the sidebar hidden the list toolbar keeps its start padding, so neither meets the traffic lights. The Settings toolbar keeps its own corner rule.

## Separators and captions

- List sections have no rule between them. A later section gets `size.list-section-gap` (14) more space above it.
- One caption style for the sidebar and the list (`.section-header`, `.list-section`): caption size (11), semibold, tertiary text, no icon.
- The editor footer (`.editor-counts`, words and characters) is caption size (11) in tertiary text, right-aligned to the history bar's margin (`space.10`), with no rule above it.
- Footnotes on screen start with a 48 pt hairline (`size.footnote-rule`) on the text's edge, with text at footnote size (12) in secondary. Print keeps the full-width rule.

## Settings footnotes

A note under a card belongs to it: 8 below the card, about 24 above the next section's title. Its icon starts on the caption line (16 from the card's edge) and centres on the text's first line.

## Note rows

- A grid with gap 4, so a missing line leaves no hole. Padding 10 top, 11 bottom, 12 sides. Rows sit 2 apart, with no separators.
- **Line 1:** title 13 semibold on one line, with the time (11, tertiary) on its baseline.
- **Optional meta line:** 11 pt, items 6 apart. A meta line holding only the time leaves the grid.
- **Excerpt:** 12, line height 1.45, two lines, secondary.

## One stroke rule

A control or block in a note is filled or outlined, never both, and a dashed border is not used at rest. A rendered table (hairline edge) and a callout (tinted edge) are the only bordered blocks; the table box behind Edit mode's source is fill only, like code.

- **Pills** (notebook, status, tag): `color.fill.card`, no border, a 26 pt capsule (`size.note-pill`) with 10 sides (`size.note-pill-pad`), 6 apart. Hover uses `color.fill.tool-hover`. Coloured tags keep their tint.
- **Add Tag:** the text "+ Tag" in tertiary with 8 padding. A dashed focus-ring outline shows only while it holds the keyboard.
- **Code:** fill only. Blocks use `radius.list-row` (12), inline code `radius.inline-code` (5), in the preview and the editor. Edit mode's table box takes the same fill and `radius.list-row`.

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
- **Edge labels:** caption size (11), `color.text.secondary`, `size.diagram-label-gap` (1) beside the line, not over it, with nothing painted behind: a translucent ground over a line fades it in print.
- **Data colours:** charts take `color.chart.series-1` to `-6`, opaque, in that order: muted hues that alternate deep and pale, so neighbours differ in lightness for colour-blind readers and in greyscale print. Tag colours are for tags. Labels on them are `color.chart.on-series`, 4.5:1 on all six; a pale series may fall under 3:1 on a light surface, so a chart keeps its gaps, legend and labels.
- **Pie:** opaque slices the colour of their legend swatches, `space.1` (2) see-through gaps cut out with a mask, since no line colour can match glass, and no outer ring.
- **Gantt:** bars have no edge and `radius.diagram-bar` (4) corners: `color.chart.bar-task`, `-active` and `-crit` with `color.chart.on-bar` text at 4.5:1; a done bar is `color.fill.card` with `color.text.secondary` text. The today line is `size.diagram-edge` in `color.text.tertiary`, under the bars. Sections have no bands. The chart is drawn for its pane's width in steps of 40 (at least 320), exports for `size.reading-width`, with short dates, and a date label that would collide is dropped.
- **Other charts:** git graph lines `size.diagram-git-line` (3) and commits `size.diagram-git-commit` (6); axis lines `size.diagram-edge` in `color.text.tertiary`; nothing keeps Mermaid's inverted or brightened colours.
- **Limits:** sequence diagrams follow the colours and font only. A label clears straight horizontal and vertical segments; on a slanted edge it may touch the line.
