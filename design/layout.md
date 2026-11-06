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
- **Note list header:** the toolbar holds only the sidebar toggle and the view's name over its count, left-aligned `space.5` (10) after the toggle on the same y = 26 line.
  The name is cut off with an ellipsis and, with the sidebar hidden, keeps clear of the traffic lights by the toolbar's start padding.
  Actions on the list sit at the end of the search row, not in the toolbar: New Note is a `size.list-action` (32, the search field's height) round tool on `color.fill.track` (hover `color.fill.tool-hover`), `space.3` (6) after the field, its right edge on the list's outer keyline (12).
  A view's own action (Empty in the Trash) takes its place.
  The List and Board control stays in the sort row below.
- **Sidebar depth:** a top-level notebook has no extra indent. Each deeper level steps 16, and the chevron hangs in the row's padding without pushing the row. The guide runs from an open notebook's icon down its children, drawn per child row; where it meets a row's chevron it breaks `space.1` clear of the chevron's 14 px box (an 18 px gap centred on the row) and continues above and below.
- **Outline:** a column `size.outline-width` (220) at the editor pane's right edge, beside the scroll bar's reserve, with rows of body size on `space.3` sides; each level steps `space.7`. It is hidden in focus mode and when the panes would fall below `size.pane-min-width` each.
- **Write mode's table bar:** above the rendered table, outside the grid, on the table's left edge (`BAR_GAP` clear of the header row). The table's first row line always carries a bar's height plus `BAR_GAP` of padding above the header, so the bar sits in that space and never covers the block above. When the editor has no room above the table the bar stays at the top of the visible part of the table, below the header row, and never covers it. Edit mode keeps the bar over the row above the caret.
- **Write mode's task box:** one drawn box for open and done tasks, 0.875 em square with `radius.mark` (4), outlined in `color.line.control` when open and filled `color.accent.fill` with a `color.accent.on-fill` check when done (one stroke rule). It stands in for the list mark, the brackets and the space after them: its left edge is the list mark's column, the bullets' column, and it centres on the item's first line. The item's text starts `space.3` after it, at one x for done and open items, and a done item's strike-through covers that text only.
- **Split view:** each pane uses the editor keyline inside its own width.
- **Scroll bars:** `.rows`, `.preview`, the editor and the Settings pane always reserve the scroll bar, pulled out of the keyline, so right edges stay put.
- **Exceptions:** in focus mode the editor toolbar starts at `window-controls-inset`, and with the sidebar hidden the list toolbar keeps its start padding, so neither meets the traffic lights. The Settings toolbar keeps its own corner rule.

## Separators and captions

- List sections have no rule between them. A later section gets `size.list-section-gap` (14) more space above it.
- One caption style for the sidebar and the list (`.section-header`, `.list-section`): caption size (11), semibold, tertiary text, no icon.
- The editor footer (`.editor-counts`, words and characters) is caption size (11) in tertiary text, right-aligned to the history bar's margin (`space.10`), with no rule above it.
- Footnotes on screen start with a 48 pt hairline (`size.footnote-rule`) on the text's edge, with text at footnote size (12) in secondary. Print keeps the full-width rule.

## Settings footnotes

A note under a card belongs to it: 8 below the card, about 24 above the next section's title. Its icon starts on the caption line (16 from the card's edge) and centres on the text's first line.

## Phone grouped lists

The iPhone's Settings screen and every pane under it are one grouped list; the Mac's Settings window keeps its own layout.
Its keyline is `size.phone-grouped-pad-x` (16) from a card's edge: section headers, row labels, descriptions, the start of each separator and footers all start on it.

- **Card:** `radius.phone-grouped-card` (24) in `color.phone.card`, no padding of its own; its rows run edge to edge and it clips their pressed fill.
- **Row:** at least `size.phone-grouped-min` (56), or `size.phone-grouped-min-described` (72) with a description, with `size.phone-grouped-pad-y` (12) above and below and `size.phone-grouped-gap` (12) between its icon, text, value and accessory.
  A row on the Settings screen keeps its icon in `size.phone-row-icon`.
- **Separator:** a `size.phone-separator` hairline in `color.phone.separator` between rows, from the keyline (the label's keyline on the Settings screen) to the card's right edge; none above a card's first row.
- **Text:** label 16/23 in the body colour; at most one short description under it, 14/19 in `color.phone.text-secondary`, `space.2` below the label.
- **Trailing edge:** a value, a switch, a stepper and a chevron end on one right edge, `size.phone-grouped-pad-x` from the card's edge, in every row and every pane.
  At the accessibility sizes a select or a stepper goes under its label and stays on that edge.
- **Values and pickers:** a select's value is 14/19 in `color.phone.text-secondary`, at most 40% of the row, on one line cut with an ellipsis, then the disclosure chevron.
  The label wraps before a short value is cut.
  The whole row opens the picker.
  A picker among a row's actions (the imported font) is a row of its own: its value on the keyline, the chevron on the right edge.
- **Stepper:** its value as a trailing value, then a `size.phone-stepper-height` pair of `size.phone-stepper-button` buttons on `color.phone.lens`, its outer corners concentric with the card; it never stretches.
  The value comes first in reading and tab order, and each button is a 44 by 44 target.
- **Controls that fill a row:** a segmented control or a slider takes the row's width with `size.phone-grouped-pad-x` on every side, so its corners are concentric with the card; its name is the section header, never a label inside the card.
  A free-text field goes under its label at the row's width.
- **Actions:** each is a full-width row of its own, its label in `color.accent.text` on the keyline, and in `color.phone.destructive` when it removes something.
  A row's actions sit under its text, parted by separators.
  An action beside a row's text (a device's Remove) is the tinted label alone.
- **Disabled:** the row's contents fade once to `opacity.disabled`, its control drawn as an enabled one and its label in the body colour; the hairline above it does not fade.
  A disabled action row fades the same way.
- **Focus:** the ring goes round the whole row, inside it, since the card clips anything outside.
- **Headers and footers:** 14/19 in `color.phone.text-secondary` on the keyline, a header medium and `space.4` above its card, a footer `space.4` below it.
  At most one footer per card.

## Note rows

- A grid with gap 4, so a missing line leaves no hole. Padding 10 top, 11 bottom, 12 sides. Rows sit 2 apart, with no separators.
- **Line 1:** title 13 semibold on one line, with the time (11, tertiary) on its baseline.
- **Optional meta line:** 11 pt, items 6 apart. A meta line holding only the time leaves the grid.
- **Excerpt:** 12, line height 1.45, two lines, secondary.

## Board

The width, the empty line, the fade, the meta line and the drag hold in Classic too; Classic keeps its column tiles, card edge and selection.

- **Columns:** on the note list's keylines: the board sits 12 from the pane's sides (`size.list-keyline-outer`), columns `size.board-column-width` (180) wide and 10 apart (`space.5`).
  A column has no tile behind it.
  In a narrow pane columns shrink to `size.board-column-min-width` (150), then scroll sideways.
- **Width:** until the user drags the pane's edge, the board is as wide as its columns: 2 × 12 + n × 180 + (n − 1) × 10, so 964 for five columns and 774 with Dropped hidden.
  A drag keeps the user's width; a double-click or Enter on the edge goes back to the fitted width.
- **Header:** 32 tall (`space.10`), its text on the inner keyline: the status mark in the status colour, the name 13 semibold in primary, then the count in caption size (11) in tertiary.
- **Empty column:** one line, "No Notes", in tertiary at footnote size, centred.
- **Cards:** 6 apart (`space.3`), filled only with `color.fill.card` (one stroke rule), `radius.list-row` (12) and the note row's padding: 10 top, 11 bottom (`size.list-row-padding-bottom`), 12 sides, lines 4 apart.
  The title is 13 semibold on up to three lines; under it the meta line, 11 on a 14 line (`size.card-meta-line`) in secondary: the time, then a dot per tag ending 12 inside the card's right edge.
  A card in the Dropped column draws its title in secondary unless it is selected.
- **States:** under the pointer a card takes `color.fill.tool-hover`; selected, the list's accent wash (`color.accent.fill` at `opacity.list-selected` over `color.fill.card`), with no bar; with the keyboard the inset `color.focus.ring` ring.
- **Fade:** a column's cards fade out over their last 18 (`space.8`) instead of being cut.
- **Drag:** the dragged cards stay in place at `opacity.card-dragged` (0.35), and the column under the pointer takes `color.fill.track` at `radius.list-row`, in place of an outline.
  The drag image is a copy of the card on the popover's shadow, with an accent count badge when it carries several notes.

## Gallery cards

- A grid 12 from the pane's sides (`size.list-keyline-outer`), cards 10 apart (`space.5`), each between `size.gallery-card-min-width` (220) and `size.gallery-card-max-width` (300) wide.
  As many go across as keep each at most 300, unless that would make one narrower than 220.
  The pane's width is the board's (see Board), fitted to the board's columns until the user drags it.
- **Cell:** the card is the list row's highlight: transparent, `radius.list-row` (12), padding 4 (`space.2`).
  Under the pointer it takes `color.fill.row-selected-inactive`, selected the accent wash at `opacity.list-selected`, and with the keyboard the inset `color.focus.ring` ring, as a row does.
  No bar.
- **Sheet:** a 3:4 page, so its height follows the card's width: `color.surface.editor` with `radius.card` (8), 4 inside the cell so the radii are concentric.
  It has no hairline; a soft two-layer shadow (`color.shadow.page-key` and `color.shadow.page-ambient`, with `shadow.page-*`) lifts it off the list.
  The page sits 8 (`space.4`) inside the sheet; the bottom fades out instead of being cut.
- **Page:** the note's first page laid out at `size.gallery-page-width` (480) and scaled to the sheet, about one half: the title in the note's title style (28/34 bold, scaled with the body), then the body on the note type scale, headings primary and text secondary.
  An untitled note starts with its first line, or "Untitled" in tertiary when it has none.
  A diagram, math, a frame or an image from the web shows as a placeholder in a `color.fill.track` box with tertiary text.
- **Caption:** one line 6 (`space.3`) under the sheet on the inner keyline, 11 (`font-size.caption`) in tertiary, the board card's meta line led by the marks: the pin, the status mark in its colour, the time, then the tag dots at the line's end.
  The title is not repeated, as the page shows it.

## One stroke rule

A control or block in a note is filled or outlined, never both, and a dashed border is not used at rest. A rendered table (hairline edge) and a callout (tinted edge) are the only bordered blocks; the table box behind Edit mode's source is fill only, like code.

- **Pills** (notebook, status, tag): `color.fill.card`, no border, a 26 pt capsule (`size.note-pill`) with 10 sides (`size.note-pill-pad`), 6 apart. Hover uses `color.fill.tool-hover`. Coloured tags keep their tint.
- **Add Tag:** the text "+ Tag" in tertiary with 8 padding. A dashed focus-ring outline shows only while it holds the keyboard.
- **Code:** fill only. Blocks use `radius.list-row` (12), inline code `radius.inline-code` (5), in the preview and the editor. Edit mode's table box takes the same fill and `radius.list-row`.

## Note info card

- **Summary:** the last item of the pill row, after "+ Tag": tertiary text on a 26 pt capsule (`size.note-pill`, `size.note-pill-pad` sides) with no fill at rest, `color.fill.tool-hover` under the pointer and `color.fill.card` while its card is open.
  It keeps its place while the counts load, so the row never shifts.
- **Card:** a glass popover `size.note-info-width` (320) wide, `space.3` under the summary and kept `size.popover-margin` inside the window; `radius.glass-popover` (18), inset `size.glass-popover-inset` (6), on `color.surface.popover` with the glass rim and the popover shadow.
- **Keylines:** from the card's edge, 6 for row highlights, 16 for icons and captions, 42 for labels and 116 for values.
  A row is a grid of the 16 pt icon slot, the label column `size.note-info-label` (64) and the value, `space.5` apart, with `space.5` sides; a value that has no label (a backlink) starts on 42.
- **Rows:** at least `size.note-info-row` (30) tall, highlighted in `radius.glass-menu-row` (12), concentric with the card.
  Labels are secondary, values primary; a date being set shows in `color.accent.text`.
- **Sections:** Properties and Backlinks open under a caption row `size.note-info-caption` (24) tall in the one caption style (11, semibold, tertiary), with the count beside the title and the disclosure chevron at the row's right end, shown under the pointer or the keyboard.
- **Foot:** pinned under the scrolling sections, `space.2` below them with no rule: the Tasks meter (a `size.note-info-meter` (4) capsule in `color.fill.track`, filled `color.accent.fill`, then "1/4") and Words.
- **Date picker:** a glass popover `size.date-picker-width` (276) wide that hangs from its date row (above it when the window has no room below), with the card's radius and inset.
  A head row `size.date-picker-head` (32) has the month and three `size.date-picker-nav` (26) circles (previous, today, next); weekday captions are `size.date-picker-week` (22) tall; days are `size.date-picker-cell` (32) rows with a `size.date-picker-day` (30) circle, the selected day filled `color.accent.fill`, today in `color.accent.text`, days of the months around in tertiary and days ruled out at `opacity.disabled`.
  The time row sits on `color.fill.card` in `radius.glass-menu-row`, and Cancel and Set share the foot, Set filled with the accent.

## Note type scale

Tokens: `note.heading.glass.*`, `note.space.*`. Size / line height:

| Element | Type                      | Space               |
| ------- | ------------------------- | ------------------- |
| Title   | 28/34 bold, tracking -0.4 | pills 10 below      |
| H1      | 22/28                     |                     |
| H2      | 19/24                     | 26 above, 8 below   |
| H3      | 16/22 semibold            | 20 above, 6 below   |
| Body    | 14, line height 1.6       | paragraphs 12 apart |

In the preview the body starts 22 under the pills; the editor keeps 8. The user's font size is the base: the preview scales by its setting over 15, the editor's heading lines by theirs over 13. The title-to-pills and pills-to-body spacing stays fixed.

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
