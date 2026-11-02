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

## Touch

- Every target is at least `size.phone-target` (44 pt). A smaller drawing keeps its size and extends its hit area: the formatting bar's buttons (38 by 40), the sheet's close and capture's Cancel and Save (`size.phone-capture-control`, on a `.phone-hit` child), and the note's chips (30).
- A back swipe starts from the left edge and tracks the finger; every push can be undone by it. A vertical scroll never starts a swipe.
- Anything a gesture does is reachable without it: swipe actions and the peek's actions are also VoiceOver custom actions.

## Behaviour

- Each note list section is newest first, so a new note lands at the top of Recent.
- A move of more than 8 pt that is mostly horizontal starts a swipe; a vertical one scrolls and never swipes; a 420 ms hold without either peeks. An open row takes no peek.
- Every row has a hidden "Actions for…" button that opens the peek's menu, so the swipe and peek actions need no gesture. It stands in for VoiceOver custom actions, which a web view cannot declare.
- A swipe raises the row on a surface (`radius.phone-swipe-surface`, `size.phone-swipe-surface-inset`). Its capsules are `size.phone-swipe-action` by `size.phone-swipe-action-height` with an 11 pt label under each; Pin stays `color.phone.action-pin`, darker than the design's orange so its glyph keeps 3:1.
- Trashing or completing a note (swipe, peek or note info) shows the undo toast for `motion.duration.phone-toast`. Undo puts the note back as it was, its place in the list too (`phone/undo.ts`: a status write moves `updatedAt`, so it restores that as well). A second action replaces the toast and the first stays done. Completing a note already completed does nothing. Only a note's status picker changes a status without one.
- Settings rows open the existing Settings panes in a phone screen. Mirror Folder, Integrations and Plugins show "On the Mac" and do not open.
- In a phone screen a pane leaves out what only the Mac has (`useOnPhone`): the interface style, Glass Transparency and the system accent color (the phone always draws its own glass), and the board, activity strip, menu bar, updates, command line tool and folder buttons. Each row stacks its control under its label at the row's width; switches stay beside their label. Messages that name the Mac use the iPhone wording in `i18n/phone.ts`.

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

Times, counts and stats use `.phone-figures`: mono, tabular figures.

Tab bar: four icon-only tabs (Notes, Library, Activity, Settings) in a `size.phone-glass-bar` glass bar at x 16, as wide as the screen leaves beside the `size.phone-compose` glass circle: 286 on a 390 screen, with the circle at x 312. The selected tab has a lens (inset 4, `radius.phone-lens-bar`) and a filled icon; Settings shows a badge when the licence needs attention. The circle is offered on the Notes and Library screens that can take a new note, and hidden on Activity, Settings, Templates, Trash, a note and a pane.

Capture: the circle grows in place into the sheet, `size.phone-sheet-inset` from the screen's sides and bottom, up to `size.phone-capture-height`. The keyboard does not move the layout, so the open sheet rides above it and shrinks to what is left under the safe area, and its contents scroll. A note saved where the list would not show it opens All Notes.

Undo toast: `size.phone-toast` high, centred, `size.phone-toast-bottom` above the bottom on the tab bar's safe-area logic, above the compose circle. The Undo pill (`size.phone-toast-undo`) reaches its 44 target inside the toast.

The tab bar sits at the larger of `size.phone-tab-bottom` and the bottom safe area less 10, so 24 from the screen's edge at the design's 34 pt inset, clear of the home indicator on any iPhone.

## Dynamic Type

Text follows the system's text size, up to the largest accessibility size.

- Numbers in the specs are at the default size (Large). The scale is the computed size of `font: -apple-system-body` over 17, read at launch and on return to the foreground, and set on the root as `--phone-text-scale`; every font size and line height in the layout is its number times that scale.
- Heights that hold text are minimums, so `size.phone-list-row`, `size.phone-grouped-row`, `size.phone-info-row`, `size.phone-smart-tile` and `size.phone-chip` grow with their text. Nothing is positioned by assuming a row height: the list measures its rows, and a saved note's neighbours shift by the height it really takes.
- Text wraps rather than being cut wherever a row can grow. At the accessibility sizes the note list's title may take two lines, a row's time moves under its title, its preview takes two lines, and the four smart tiles become two rows of two.
- Icons beside text grow with it. Glass bars keep their heights and glyphs, because they sit in fixed places: the top bar's title stops at 1.35.
- The note's editor and preview keep the text size chosen in Settings, and start from the system's scale until one is chosen.

## Icons

SF Symbols only, through `symbol_png` (ADR 0001), monochrome in the text colour. Settings and Library rows have no coloured tile: a `size.icon-phone-row` line icon sits in a `size.phone-row-icon` column, a tag in the same column shows a dot in its colour. A selected tab uses its `.fill` symbol. The synced double tick is `check` drawn twice.

Weights: `regular` at 18 pt and above, and `medium` for chevrons of 14 pt and below, the closest symbol weights to the design's 1.8 and 2.2 strokes.

Status marks are `size.icon-phone-status` symbols in the status colours (`phone.status.*`): active `circle`, on hold `pause.circle`, completed `checkmark.circle.fill` with a white check, dropped `xmark.circle`, no status `circle.dashed`. The Mac's `status.*` symbols stay filled.
