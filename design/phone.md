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

- Every target is at least `size.phone-target` (44 pt). A smaller drawing keeps its size and extends its hit area: the formatting bar's buttons (38 by 40), the sheet's close and capture's Cancel and Save (40), and the note's chips (30).
- A back swipe starts from the left edge and tracks the finger; every push can be undone by it. A vertical scroll never starts a swipe.
- Anything a gesture does is reachable without it: swipe actions and the peek's actions are also VoiceOver custom actions.

## Behaviour

- The note list orders pinned notes first, then the rest, newest first in each, so a new note lands at the top of the unpinned ones.
- A move of more than 8 pt that is mostly horizontal starts a swipe; a vertical one scrolls and never swipes; a 420 ms hold without either peeks. An open row takes no peek.
- Every row has a hidden "Actions for…" button that opens the peek's menu, so the swipe and peek actions need no gesture.
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

Plain lists sit at `size.phone-list-edge` (x 20 to 370). Text moves to `size.phone-list-text` (52) when status marks replace avatars; for now it follows the avatar.

Grouped pages: cards inset 16, `radius.phone-card`, `size.phone-card-inset` around their rows, no separators. Rows are 44 with `size.phone-row-pad`, and a pressed row fills to `radius.phone-row-press`. Group titles sit at x 26, 14 medium in `color.phone.text-secondary`.

Times, counts and stats use `.phone-figures`: mono, tabular figures.

Until the compose button moves beside the tab bar, the new-note circle rests above the tab bar's right end.

The tab bar sits at the larger of `size.phone-tab-bottom` and the bottom safe area less 10, so 24 from the screen's edge at the design's 34 pt inset, clear of the home indicator on any iPhone.

## Dynamic Type

Text follows the system's text size, up to the largest accessibility size.

- Numbers in the specs are at the default size (Large). The scale is the computed size of `font: -apple-system-body` over 17, read at launch and on return to the foreground, and set on the root as `--phone-text-scale`; every font size and line height in the layout is its number times that scale.
- Heights that hold text are minimums, so `size.phone-list-row`, `size.phone-grouped-row`, `size.phone-info-row`, `size.phone-smart-tile` and `size.phone-chip` grow with their text. Nothing is positioned by assuming a row height: the list measures its rows, and a saved note's neighbours shift by the height it really takes.
- Text wraps rather than being cut wherever a row can grow. At the accessibility sizes the note list's title may take two lines, a row's time moves under its title and the four smart tiles become two rows of two. The list preview keeps its two lines.
- Icons beside text grow with it. Glass bars keep their heights and glyphs, because they sit in fixed places: the tab bar's labels and the top bar's title stop at 1.35, and a long press on a tab bar item shows its label enlarged.
- The note's editor and preview keep the text size chosen in Settings, and start from the system's scale until one is chosen.

## Icons

SF Symbols only, through `symbol_png` (ADR 0001). A selected tab uses its `.fill` symbol. The synced double tick is `check` drawn twice.
