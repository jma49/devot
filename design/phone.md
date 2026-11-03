# iPhone layout

The rules the iPhone layout (`src/renderer/src/phone/`) keeps. The approved screens are in `concepts/ios/` (`HANDOFF.md` holds the numbers); this file says how they apply in the app. Tokens are `size.phone-*`, `radius.phone-*`, `color.phone.*` and the `phone` motion tokens, and `tests/tokens/phone.test.ts` holds the numbers.

It follows Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) and [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass). Where a design value and these rules disagree, the look stays and the behaviour is fixed, as the sections below list.

## Glass

- Glass is on floating controls only: the tab bar, top bar buttons and capsules, the compose circle, the note's bottom bar, the keyboard's accessory bar, menus, toasts and sheets' buttons. Rows, cards and the note itself are never glass, and glass never sits on glass.
- `.phone-glass` is the one recipe: the `color.phone.glass` tint, `blur(10px) saturate(1.9) brightness(1.04)`, a 0.5 edge, inner highlights, inner glow, two drop shadows, a `size.phone-glass-rim` gradient rim (`::before`) and a radial sheen (`::after`). The pseudo-elements are taken: a glass control extends its hit area on a child.
- A pressed glass control grows to `motion.scale.phone-glass-press` and brightens to 1.05.
- Content runs the full height of the screen and scrolls under the glass, with the frosted band under each top bar: `size.phone-topbar-band` below the safe area, `blur(20px) saturate(1.8)`, `color.phone.bar`, a 0.5 hairline in `color.phone.separator`. Content starts `size.phone-content-top` below the safe area. Reduce Transparency makes the band opaque.
- Colour on glass marks what is selected only: the accent on the selected tab, the caret's violet on AI. The compose circle's icon is in the text colour.
- Curves share a centre: a capsule is height / 2, and an inner radius is the outer radius minus the inset. This wins over a design value: fields in the capture sheet are 20 (design 24 and 22). A grouped row's pressed fill is the exception: `radius.phone-row-press` 16 in a 22 card.
- CSS draws the glass (ADR 0010).
- Appearance's Interface and Glass Transparency are this iPhone's own choice, in `devot.phone.interfaceStyle` and `devot.phone.glassTransparency` in the webview's storage, never the Mac's settings and never synced (`phone/glassPrefs.ts`). Classic takes the same path as Reduce Transparency. Transparency moves `.phone-glass`'s tint: -100 is `color.phone.glass-opaque`, 0 the design, 100 half the tint's opacity. Reduce Transparency wins over both.

## Touch

- Every target is at least `size.phone-target` (44 pt). A smaller drawing keeps its size and extends its hit area: the formatting bar's buttons (38 by 40), the sheet's close and capture's Cancel and Save (`size.phone-capture-control`, on a `.phone-hit` child), and the note's chips (30 in a layout item 44 tall, so wrapped rows' targets touch and never overlap).
- A back swipe starts from the left edge and tracks the finger; every push can be undone by it. A vertical scroll never starts a swipe.
- Anything a gesture does is reachable without it: swipe actions and the peek's actions are also VoiceOver custom actions.

## Behaviour

- Each note list section is newest first, so a new note lands at the top of Recent.
- A move of more than 8 pt that is mostly horizontal starts a swipe; a vertical one scrolls and never swipes; a 420 ms hold without either peeks. An open row takes no peek.
- Every row has a hidden "Actions for…" button that opens the peek's menu, so the swipe and peek actions need no gesture. It stands in for VoiceOver custom actions, which a web view cannot declare.
- A swipe raises the row on a surface (`radius.phone-swipe-surface`, `size.phone-swipe-surface-inset`). Its capsules are `size.phone-swipe-action` by `size.phone-swipe-action-height` with an 11 pt label under each; Pin stays `color.phone.action-pin`, darker than the design's orange so its glyph keeps 3:1.
- Trashing or completing a note (swipe, peek or note info) shows the undo toast for `motion.duration.phone-toast`. Undo puts the note back as it was, its place in the list too (`phone/undo.ts`: a status write moves `updatedAt`, so it restores that as well). A second action replaces the toast and the first stays done. Completing a note already completed does nothing. Only a note's status picker changes a status without one.
- Settings rows open the existing Settings panes in a phone screen. Keyboard, Mirror, Integrations, Local HTTP API and Plugins show "On the Mac" and do not open.
- In a phone screen a pane leaves out what only the Mac has (`useOnPhone`): the Mac's interface style and transparency, the system accent color, and the board, activity strip, menu bar, updates, command line tool and folder buttons. A short control (switch, stepper, select, push button) sits on its label's row at its natural width, label left, control right; only a free-text field stacks under its label at the row's width. A control too wide for its row wraps under its text, on the right. At the accessibility text sizes a stepper's or select's row stacks too. Messages that name the Mac use the iPhone wording in `i18n/phone.ts`.
- A pane's row carries its label and at most one short description in `color.phone.text-secondary`, only where it adds something the label does not say: about 3-8 words, on one line at 390 pt at the default text size, worded in `i18n/phone.ts` (an empty text there means no description). A description that is the row's value or state may be longer. There are no info buttons. A group has at most a one-line footnote, and a warning before a destructive action stays in its confirmation.

## Accessibility

- Every icon-only button has a label from the message catalog.
- Text keeps 4.5:1 and marks 3:1 (`src/renderer/src/theme/contrast.test.ts`). Colours moved from their design values to meet that say so in their token's description.
- Reduce Motion turns every movement into a `motion.duration.phone-crossfade` crossfade; Reduce Transparency turns glass into `color.phone.glass-opaque`, without its rim, sheen and inner light, and the top band into `color.phone.background`.
- Layout comes from `env(safe-area-inset-*)`, never fixed top and bottom offsets.

## Layout

One page background, `color.phone.background`, on plain and grouped screens.

Top bar: 44 high, `size.phone-topbar-top` below the safe area, 16 from each side. A title is 22 bold, left-aligned at x 20, or after a 44 back circle. On the right, one glass capsule of up to two `size.phone-capsule-button` by 44 buttons: Library has new notebook and search, Notes has filter and search, Settings has pair device and search. The filter button opens a menu of All, Active, On Hold and Done, and turns the accent colour while a filter is on.

Plain lists sit at `size.phone-list-edge` (x 20 to 370), with text at `size.phone-list-text` (52).

Note list: sections Pinned, Recent (not pinned, not completed) and Completed (not pinned, completed); a pinned completed note is in Pinned, and an empty section is left out. Templates and Trash are one flat list. A head (`size.phone-section-head`, drawn 40 in a 44 target) has the title, a mono count, a hairline and a chevron that turns when the section is collapsed. Completed starts collapsed, with a dashed Show more in a `size.phone-show-more` slot, unless the status filter is on Done. Collapsing lasts the session. A saved note opens Recent, and clears a filter that would hide it.

A row is `size.phone-list-row`: a `size.icon-phone-status` status mark at x 20, the title 17 regular with the time in `.phone-figures` 14 `color.phone.text-faint` on the right, then the first tag in its colour, the excerpt 14 on one line and a pin glyph. Rows have no separators.

Grouped pages: cards inset 16, `radius.phone-card`, `size.phone-card-inset` around their rows, no separators. Rows are 44 with `size.phone-row-pad`, and a pressed row fills to `radius.phone-row-press`. Group titles sit at x 26, 14 medium in `color.phone.text-secondary`.

Library: a card of All Notes, Pinned, Active and Completed, each opening Notes filtered; then Notebooks and Tags under section heads like the note list's, without a count, and collapsing for the session; a card of Templates and Trash; a mono footer. A nested row starts at `size.phone-child-indent`, a further 28 for each level below, with a 1 pt guide through its parent's icon column; an open parent's chevron points down. Counts are in `color.phone.text-secondary` where the design has faint, which keeps 4.5:1 only on the page, not on a card.

Activity: "Week" capsule, then a card of the last 15 weeks (`size.phone-heat-cell` days, `radius.phone-heat-cell`, `size.phone-heat-gap` apart, in `color.activity.level-*`, a month over the week it starts, a less-more legend of `size.phone-heat-legend`); three stat cards, which stack as text grows; then the ranked notes under a section head, their growth in `color.phone.grow`. The capsule's menu offers This week and Last week and changes the stats and the ranking only, never the heatmap. VoiceOver reads the heatmap as one summary, not 105 cells.

Times, counts and stats use `.phone-figures`: mono, tabular figures.

Tab bar: four icon-only tabs (Notes, Library, Activity, Settings) in a `size.phone-glass-bar` glass bar at x 16, as wide as the screen leaves beside the `size.phone-compose` glass circle: 286 on a 390 screen, with the circle at x 312. The selected tab has a lens (inset 4, `radius.phone-lens-bar`) and a filled icon; Settings shows a badge when the licence needs attention. The circle is offered on the Notes and Library screens that can take a new note, and hidden on Activity, Settings, Templates, Trash, a note and a pane.

Capture: the circle grows in place into the sheet, `size.phone-sheet-inset` from the screen's sides and bottom, up to `size.phone-capture-height`. The keyboard does not move the layout, so the open sheet rides above it and shrinks to what is left under the safe area, and its contents scroll. A note saved where the list would not show it opens All Notes.

Search: an overlay over the whole screen, including the tab bar. In the top bar's place, a 44 glass field and a 44 close circle. With no query: Recent, then chips (`size.phone-search-chip`, a 44 target) for Notebooks, Status and Tags, each filling the field with `in:`, `is:` or `#`. Recent searches stay in this device's `localStorage`, added on Return or on opening a result; they are never synced or logged. Results are note rows without swipes, found words in `color.phone.match`, the notebook in mono where the time goes, the excerpt moved to start a few words before the match, since one line holds far less than the core's excerpt.

Settings: a card with the app row (dove tile, version and licence state, a badge when the licence needs attention; it opens the trial sheet during a trial and the Licence pane otherwise); General (General, Appearance, Editing, Preview, Keyboard); Sync & storage (Sync, Mirror); AI & integrations (AI, Integrations, Local HTTP API, Plugins); a card of Usage and Licence; a mono build footer. Its search button opens a glass field that filters the panes that open on a phone, by name. There is no Backups or About row: neither has a pane on the phone.

Panes: controls sit in grouped cards, `size.phone-group-gap` apart, with one rhythm: rows at least 44, `size.phone-card-inset` above and below them, `size.phone-row-pad` at the sides, and a control's right edge on that padding. A row with a description grows by `space.3` above and below; the control stays vertically centred and the description starts at the label's left edge. A select reads as an iOS row: its value in `color.phone.text-secondary` with an up and down chevron, cut with an ellipsis rather than wrapped, under the invisible native `<select>`, a 44 target. A stepper is a `size.phone-stepper-height` capsule of `size.phone-stepper-button` buttons in a 44 target. A free-text field's radius is concentric with its card. A disabled control keeps full opacity and `color.phone.text-secondary`, so it holds 4.5:1; a disabled switch has a flat `color.phone.text-secondary` thumb when off and track when on, where an enabled off switch has an elevated thumb with its shadow. A section that would repeat the screen's title (Licence, Preview, Usage's first) has no head, so its first card starts where other panes' do. At the accessibility sizes a row's buttons stack at the row's width under its text, a segmented control stacks its choices in 44 rows, and a chart's heading stacks over its caption. Theme pickers: all six themes in one row of even columns, the same in Light and Dark, each a `size.phone-theme-thumb-width` by `size.phone-theme-thumb-height` thumb (`radius.phone-theme-thumb`) with its sample and accent. The chosen thumb has a ring drawn outside the layout on the thumb's centre, `size.phone-theme-ring-gap` out and `size.phone-theme-ring` wide; a name changes colour, not weight, so choosing moves nothing. At the accessibility sizes the row takes three columns. The text size slider has its label on a row above it, and the small and large A on either side, drawn 30 high around a 44 target. Usage: the period and event type; one card of three figure rows (total, active days, notes), label left and `.phone-figures` value right, with the date range; then, with events, the charts and an events by type list of one line per type, the label first, a share bar of at most `size.phone-usage-bar`, and `.phone-figures` counts and shares on one right edge. With no events the charts and list give way to one empty state. The storage card has a figures row and action rows, the destructive one in `color.text-destructive`. Pane rows have no separators. A pane with nothing to set says so. A switch is `size.phone-switch-width` by `size.phone-switch-height`, in the accent colour. A segmented control is `size.phone-pane-segmented` high on `color.phone.lens` in a 44 target, with a `color.phone.elevated` pill. A slider has a `size.phone-slider-track` track with an accent fill and a `size.phone-slider-thumb-width` by `size.phone-slider-thumb-height` thumb in a 44 target. The text size slider keeps the setting's full range, 10 to 32. Sync: the switch and relay with a one-line footnote, then setup rows until enrolled, then Devices (mono date, a "You" badge on this device) and pairing. The recovery key shows only while a new vault's key waits to be saved, as on the Mac; once saved neither has anything to do with it, so there is no row. AI: the provider segmented control and its endpoint, model and key, then next edit suggestions. The theme pickers stay; there are no accent swatches.

Sheets: note info, the pickers, the trial and short messages rise from the bottom edge, the full width of the screen, with `radius.phone-sheet` on the top corners only, since a floating sheet's corners cannot be concentric with every device's. They render at the app's root, over the tab bar and the compose circle; the scrim covers the whole screen. The contents scroll inside, and their bottom padding clears the home indicator (`safe-area-inset-bottom` plus `size.phone-sheet-inset`, at least 16). A sheet is modal: it takes the keyboard when it opens, the rest of the app is inert behind it, Tab goes round its own controls, Escape closes it, and the keyboard goes back to what opened it. A sheet opened over a sheet is the live one until it closes.

Detail sheet, for the trial and a failed suggestion: a sheet with a `color.phone.lens` circle holding the info icon, a 20 bold title, the body 16/24 in `color.phone.text-secondary`, and a full-width glass Done, `size.phone-sheet-done` high.

Note: a note opens in Preview, and an empty one in Edit, chosen once when its body has loaded. Its text, in Edit and Preview, shares the title's left and right edges. A later change to the body never changes the mode. Back and Forward return to a note in the mode it was left in; leaving the note's screen forgets that. The top bar has a back circle, the notebook's path in mono, and a capsule of the mode toggle and info. Below it the title 26 bold, wrapping to as many lines as it needs (Return adds none), the chips, then the edit time and word count in `.phone-figures`; there is no per-note sync state. The bottom has a glass capsule of Back and Forward, a find circle and, in Edit, an AI circle with its sparkle in the caret colour. While typing the bottom fades and the formatting bar sits on the keyboard, with a hide-keyboard circle.

Find: the editor's own find, in a glass bar on the keyboard with a mono count, previous, next and a close circle. It switches a note in Preview to Edit.

Note info: the sheet has the stats in mono, in two columns at the accessibility sizes; icon rows for notebook, created, modified and, on an enrolled device, synced devices, plain rows at full opacity, not buttons, each value under its label at the accessibility sizes; backlinks, which opens the linking notes when there are any; and Move to Trash, with the undo toast. There is no revision history or export row: neither has a phone screen yet.

Undo toast: `size.phone-toast` high, centred, `size.phone-toast-bottom` above the bottom on the tab bar's safe-area logic, above the compose circle. The Undo pill (`size.phone-toast-undo`) reaches its 44 target inside the toast.

The tab bar sits at the larger of `size.phone-tab-bottom` and the bottom safe area less 10, so 24 from the screen's edge at the design's 34 pt inset, clear of the home indicator on any iPhone.

## Dynamic Type

Text follows the system's text size, up to the largest accessibility size.

- Numbers in the specs are at the default size (Large). The scale is the computed size of `font: -apple-system-body` over 17, read at launch and on return to the foreground, and set on the root as `--phone-text-scale`; every font size and line height in the layout is its number times that scale.
- Heights that hold text are minimums, so `size.phone-list-row`, `size.phone-grouped-row`, `size.phone-info-row` and `size.phone-chip` grow with their text. Nothing is positioned by assuming a row height: the list measures its rows, and a saved note's neighbours shift by the height it really takes.
- Text wraps rather than being cut wherever a row can grow. At the accessibility sizes the note list's title may take two lines, a row's time moves under its title, and its preview takes two lines.
- Icons beside text grow with it. Glass bars keep their heights and glyphs, because they sit in fixed places: the top bar's title stops at 1.35.
- The note's editor and preview keep the text size chosen in Settings, and start from the system's scale until one is chosen.

## Icons

SF Symbols only, through `symbol_png` (ADR 0001), monochrome in the text colour. A device is drawn with a generic shape (`phone.devices`), never a symbol that depicts an Apple product. Settings and Library rows have no coloured tile: a `size.icon-phone-row` line icon sits in a `size.phone-row-icon` column, a tag in the same column shows a dot in its colour. A selected tab uses its `.fill` symbol. The synced double tick is `check` drawn twice.

Weights: `regular` at 18 pt and above, and `medium` for chevrons of 14 pt and below, the closest symbol weights to the design's 1.8 and 2.2 strokes.

Status marks are `size.icon-phone-status` symbols in the status colours (`phone.status.*`): active `circle`, on hold `pause.circle`, completed `checkmark.circle.fill` with a white check, dropped `xmark.circle`, no status `circle.dashed`. The Mac's `status.*` symbols stay filled.
