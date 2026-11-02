# iPhone layout

The rules the iPhone layout (`src/renderer/src/phone/`) keeps. The approved screens are in `concepts/ios/` (`HANDOFF.md` holds the numbers); this file says how they apply in the app. Tokens are `size.phone-*`, `radius.phone-*`, `color.phone.*` and the `phone` motion tokens, and `tests/tokens/phone.test.ts` holds the numbers.

It follows Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) and [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass). Where a design value and these rules disagree, the look stays and the behaviour is fixed, as the sections below list.

## Glass

- Glass is the navigation layer only: the tab bar, top bar controls, the status filter, the note's bottom bar and the keyboard's accessory bar. Rows, cards, tiles and the note itself are never glass, and glass never sits on glass.
- Content runs the full height of the screen and scrolls under the glass, with the blurred edge effect (`size.phone-edge-effect`) under each top bar.
- Colour on glass marks what is selected or the screen's main action only: the accent on the selected tab and the new-note circle, the caret's violet on AI.
- Curves share a centre: a capsule is height / 2, and an inner radius is the outer radius minus the inset. This wins over a design value: cards in the note info sheet are 22 (design 26), and fields in the capture sheet are 20 (design 24 and 22).
- CSS draws the glass for now (ADR 0010).

## Touch

- Every target is at least `size.phone-target` (44 pt). A smaller drawing keeps its size and extends its hit area: the formatting bar's buttons (38 by 40), the sheet's close and capture's Cancel and Save (40), and the note's chips (30).
- A back swipe starts from the left edge and tracks the finger; every push can be undone by it. A vertical scroll never starts a swipe.
- Anything a gesture does is reachable without it: swipe actions and the peek's actions are also VoiceOver custom actions.

## Accessibility

- Every icon-only button has a label from the message catalog.
- Text keeps 4.5:1 and marks 3:1 (`src/renderer/src/theme/contrast.test.ts`). Colours moved from their design values to meet that say so in their token's description.
- Reduce Motion turns every movement into a `motion.duration.phone-crossfade` crossfade; Reduce Transparency turns glass into `color.phone.glass-opaque`.
- Layout comes from `env(safe-area-inset-*)`, never fixed top and bottom offsets.

## Dynamic Type

Text follows the system's text size, up to the largest accessibility size.

- Numbers in the specs are at the default size (Large). The scale is the computed size of `font: -apple-system-body` over 17, read at launch and on return to the foreground, and set on the root as `--phone-text-scale`; every font size and line height in the layout is its number times that scale.
- Heights that hold text are minimums, so `size.phone-list-row`, `size.phone-grouped-row`, `size.phone-info-row`, `size.phone-smart-tile` and `size.phone-chip` grow with their text. Nothing is positioned by assuming a row height: the list measures its rows, and a saved note's neighbours shift by the height it really takes.
- Text wraps rather than being cut wherever a row can grow. At the accessibility sizes the note list's title may take two lines, a row's time moves under its title and the four smart tiles become two rows of two. The list preview keeps its two lines.
- Icons beside text grow with it. Glass bars keep their heights and glyphs, because they sit in fixed places: the tab bar's labels and the status filter stop at 1.35, and a long press on a tab bar item shows its label enlarged.
- The note's editor and preview keep the text size chosen in Settings, and start from the system's scale until one is chosen.

## Icons

SF Symbols only, through `symbol_png` (ADR 0001). A selected tab uses its `.fill` symbol. The synced double tick is `check` drawn twice.
