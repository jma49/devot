# iPhone layout

The rules the iPhone layout (`src/renderer/src/phone/`) keeps. Tokens are `size.phone-*`, `radius.phone-*`, `color.phone.*` and the `phone` motion tokens, and `tests/tokens/phone.test.ts` holds the numbers.

It follows Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) and [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass). Where a design value and these rules disagree, the look stays and the behaviour is fixed, as the sections below list.

## Glass

- Glass is on floating controls only: the tab bar, top bar buttons and capsules, the note's bottom bar, the keyboard's accessory bar, menus, the undo toast and sheets' buttons. Rows, cards and the note itself are never glass, and glass never sits on glass.
- `.phone-glass` is the one recipe: the `color.phone.glass` tint, `blur(10px) saturate(1.9) brightness(1.04)`, a 0.5 edge, inner highlights, inner glow, two drop shadows, a `size.phone-glass-rim` gradient rim (`::before`) and a radial sheen (`::after`). The pseudo-elements are taken: a glass control extends its hit area on a child.
- A pressed glass control grows to `motion.scale.phone-glass-press` and brightens to 1.05.
- The peek's status bar and menu sit over the peek's own 16 px blur and draw no blur of their own: a second one would add nothing, and it would be drawn again every frame they grow.
- Content runs the full height of the screen and scrolls under the glass, with the frosted band under each top bar: `size.phone-topbar-band` below the safe area, `blur(20px) saturate(1.8)`, `color.phone.bar`, a 0.5 hairline in `color.phone.separator`. Content starts `size.phone-content-top` below the safe area. Reduce Transparency makes the band opaque.
- Colour on glass marks what is selected only: the accent on the selected tab, the caret's violet on AI.
- Curves share a centre: a capsule is height / 2, and an inner radius is the outer radius minus the inset. A grouped row's pressed fill is the exception: `radius.phone-row-press` 16 in a 22 card.
- CSS draws the glass (ADR 0010).
- Glass Transparency is this iPhone's own choice, never the Mac's settings and never synced. Under the native screens it lives in `UserDefaults` under `devot.phone.glassTransparency` (`GlassStyleStore`), taken once from the webview's storage key of the same name, and the native store sets the page's glass with `glass.set`; the web shell alone keeps it in the webview's storage (`phone/glassPrefs.ts`). It moves `.phone-glass`'s tint: -100 is `color.phone.glass-opaque`, 0 the design, 100 half the tint's opacity. Devot's native glass maps it through `GlassStyle`: -100 solid, below 0 the regular glass tinted towards `color.phone.glass-opaque`, 0 the regular glass, above 0 the clear glass with a tint that thins to nothing at 100. The system bars have no glass opacity of their own, so a value below 0 gives their scroll edge the hard style, a firmer bar, and 0 or above leaves the system's. Reduce Transparency and Increase Contrast win over it: Devot's glass turns solid and the slider is locked with a footer.
- Gradient sits under the Light and Dark Mode themes while either is a gradient theme, so choosing one moves nothing above it, and goes with the last one: a group titled Gradient whose slider runs from Solid to Full in steps of 5.
  It is the editor setting the Mac uses (`gradientStrength`, kept on this device like the theme choice), and moves `--backdrop` behind every screen under its veil.
- Appearance's Light and Dark reach UIKit too: every window takes the chosen style (`overrideUserInterfaceStyle`), so the status bar, the keyboard and the web view's `prefers-color-scheme` follow it, not only the page's tokens.

## Touch

- Every target is at least `size.phone-target` (44 pt). A smaller drawing keeps its size and extends its hit area: the formatting bar's buttons (38 by 40), the sheet's close, and the note's chips (30 in a layout item 44 tall, so wrapped rows' targets touch and never overlap).
- A back swipe starts from the left edge and tracks the finger; every push can be undone by it. A vertical scroll never starts a swipe.
- Anything a gesture does is reachable without it: a row's swipe actions are also in its context menu, and VoiceOver offers both.

## Behaviour

- Each note list section is newest first, so a new note lands at the top of Recent.
- Swipe actions are muted so their white glyphs keep 3.8:1: Pin is `color.phone.action-pin`, Trash `color.phone.action-trash` and the status action `color.phone.action-status`.
- Trashing one note or completing one from a list shows the undo toast for `motion.duration.phone-toast`.
  Undo puts the note back as it was, its place in the list too (a status write moves `updatedAt`, so `note.undoStatus` restores that as well).
  A second action replaces the toast and the first stays done.
  Completing a note already completed does nothing.
- Settings is native: every pane is a SwiftUI form (`docs/specs/iphone-screens.md`, Settings tree), and the page draws no Settings of its own.
  Keyboard, Mirror, Integrations, Local HTTP API, Plugins and Usage (the phone records no usage events) have no row on the phone, and General has one only when the build can send crash reports, its one setting there.
- A pane leaves out what only the Mac has: the Mac's Glass Transparency, the system accent color, the board, activity strip, menu bar, updates, command line tool and folder buttons, Synced Scrolling (there is no split view) and Installed Font (iOS lists no installed fonts to an app; it stays only while it is the choice).
  Import Font opens the Files picker, which hands Rust a copy of the file.
  Toolbar, worded Floating Toolbars, is the bars over selected text and tables, not the bar above the keyboard.
  Messages that name the Mac use the iPhone wording in `i18n/phone.ts`.
- A pane's row carries its label and at most one short description in `color.phone.text-secondary`, only where it adds something the label does not say: about 3-8 words, on one line at 390 pt at the default text size, worded in `i18n/phone.ts` (an empty text there means no description). A description that is the row's value or state may be longer. There are no info buttons. A group has at most a one-line footnote, and a warning before a destructive action stays in its confirmation.

## Accessibility

- Every icon-only button has a label from the message catalog.
- Text keeps 4.5:1 and marks 3:1 (`src/renderer/src/theme/contrast.test.ts`). A gradient theme's backdrop shows behind every screen at `opacity.phone-backdrop`, so page text and marks keep those ratios over every stop (`tests/tokens/themes.test.ts`); its faint text takes `color.phone.text-secondary`, as faint text has no contrast to spare. Colours moved from their design values to meet that say so in their token's description.
- Reduce Motion turns every movement into a `motion.duration.phone-crossfade` crossfade; Reduce Transparency turns glass into `color.phone.glass-opaque`, without its rim, sheen and inner light, and the top band into `color.phone.background`.
- Layout comes from `env(safe-area-inset-*)`, never fixed top and bottom offsets.

## Layout

One page background, `color.phone.background`, on plain and grouped screens.

Top bar: 44 high, `size.phone-topbar-top` below the safe area, 16 from each side. A title is 22 bold, left-aligned at x 20, or after a 44 back circle. On the right, one glass capsule of up to two `size.phone-capsule-button` by 44 buttons: Settings has pair device and search.

Plain lists sit at `size.phone-list-edge` (x 20 to 370), with text at `size.phone-list-text` (52).

A section head (`size.phone-section-head`, drawn 40 in a 44 target) has the title, a hairline and a chevron that turns when the section is collapsed; collapsing lasts the session.

Grouped pages: cards inset 16, `radius.phone-card`, `size.phone-card-inset` around their rows, no separators. Rows are 44 with `size.phone-row-pad`, and a pressed row fills to `radius.phone-row-press`. A row's value sits beside its label while both fit and goes under it when they don't, so neither breaks a letter at a time; on the Settings root and note info's icon rows it always goes under at the accessibility sizes. The Settings screen and its panes are the exception: they follow Phone grouped lists in `design/layout.md`, with `radius.phone-grouped-card`, separators and titles on the card's 16 keyline.

Activity: "Week" capsule, then a card of the last 15 weeks (`size.phone-heat-cell` days, `radius.phone-heat-cell`, `size.phone-heat-gap` apart, in `color.activity.level-*`, a month over the week it starts, the current month's included, a name in the last week ending at the grid's edge, a less-more legend of `size.phone-heat-legend`); three stat cards, which stack as text grows; then the ranked notes under a section head, their growth in `color.phone.grow`. The capsule's menu offers This week and Last week and changes the stats and the ranking only, never the heatmap. VoiceOver reads the heatmap as one summary, not 105 cells.

Times, counts and stats use `.phone-figures`: the UI font with tabular figures.
A notebook's path and the Mac key use `.phone-mono`, the mono font.

The tab bar is the system's (`docs/specs/iphone-screens.md`, Tabs): four icon-only tabs (Notes, Library, Activity, Settings), the selected one in `color.accent-text`, and a badge on Settings when the licence needs attention.
The system's search circle follows the four tabs and opens the Search tab with the keyboard up.
Without the native screens (`docs/specs/iphone-screens.md`, Kill switch) the page draws no tab bar and no lists: it opens on Activity, and its ranked notes open the editor.

The note lists, Library, Templates and Trash are system lists (`docs/specs/iphone-screens.md`, Lists).
A note list has the sections Pinned, Recent (not pinned, not completed) and Completed (not pinned, completed); a pinned completed note is in Pinned, and an empty section is left out.
Completed starts folded unless the status filter is on Done.
Templates and Trash are one flat list.
A row is a system list cell: the status mark leading, the title in body, a second line of the first tag and the excerpt in subheadline `color.phone.text-secondary`, the time trailing in `color.phone.text-faint`, and a pin glyph on a pinned note.
Rows have no unread, sync or AI marks.
VoiceOver reads a row as a button, with its status and pin in its value rather than their symbols.
A head folds its section with a chevron, for the session.
Swipe actions are the system's rectangles: Pin leading, Trash and Complete trailing (a completed note has no Complete), in the action colours of Behaviour.
A hold peeks with the system's context menu: Pin, Status, Move to, Tags, Share and Move to Trash.
Move to ticks the note's notebook, or No Notebook; the selection bar's Move ticks nothing, and New Note in a notebook offers only notebooks.
The filter button's menu offers All, Active, On Hold and Done, and Select, which turns on multiple selection with a toolbar of Pin, Move, Set Status and Trash.
The Library is an inset grouped list: the smart lists with their counts, Notebooks and Tags under heads that fold for the session, then Templates and Trash.
Its bar has New Notebook (`folder.badge.plus`) beside New Note, which adds a notebook named New Notebook at the top level, as on the Mac.
A notebook with notebooks inside has a 44 pt chevron of its own that folds them, and the rest of its row opens it.
Saved searches follow Tags under a head that folds, each with a magnifying glass, and open the Search tab with their query run.
In Trash, Restore leads and Delete Permanently trails; it and Empty Trash ask first.

New Note is the compose button in the bar of the Notes and Library lists; held, it offers New Note in a notebook and From Template.
It makes an empty note, in the notebook the list shows, else the default notebook, else none, and pushes its screen at once with the caret in the body.
Where the screen below would not list it (a status list, a tag list, the Library), its notebook's list or All Notes is put under it on the same tab, so Back finds it.
Back from a note left untouched deletes it for good.
In Templates the button is New Template and makes a template the same way.

With the native screens installed Search is a tab of its own (`docs/specs/iphone-screens.md`, Search): a navigation stack under a large title with the system's search field and its All and Titles scopes, never an overlay.
Before a query, Recent, Notebooks, Statuses and Tags are solid rows under plain heads, each filling the field with its clause and searching; recent searches stay on this iPhone.
Results are the list's note rows under a Notes head with their count, and replace the list at once when they arrive; nothing found is the system's empty view with the query.
A result opens its note on the Search tab, so Back lands in Search as it was.

Settings: a card with the app row (dove tile, version and licence state, a badge when the licence needs attention; it opens the trial sheet during a trial and the Licence pane otherwise); General (General, Appearance, Editing, Preview); Sync & storage (Sync); AI & integrations (AI); a card of Licence; a build footer in `.phone-figures`. Its search button opens a glass field that filters the panes that open on a phone, by name. There is no Backups or About row: neither has a pane on the phone.
General always lists Default Notebook, and Send Crash Reports where the build can send them.

With the native screens installed Settings is the system's (`docs/specs/iphone-screens.md`, Settings): a navigation stack under a large title, the system's search field under it and Pair a device (`qrcode.viewfinder`) as its one bar button.
The root is the same groups in an inset grouped list on `color.phone.background`, its cards on `color.phone.card`, labels 16/23 and descriptions, values and footers 14/19, both scaled with Dynamic Type.
The list ends `size.phone-tab-edge` above the tab bar, so at its foot the build footer, in `color.phone.text-secondary` like every footer, is clear of the bar's scroll edge effect.
The app row has a bird symbol on an `color.accent.fill` tile in the dove's place, as SF Symbols has no dove.
Search results come in one section per pane, at most twelve, and No matching settings is the system's empty view.
Every pane is a native page: General, Appearance, Editing, Preview, Sync, AI and License.
Native Sync draws its buttons as full-width action rows, the "You" badge on `color.phone.lens`, and the QR code on `color.qr-ground` with `color.qr-module`.
Each Editing choice (Line Wrapping, Cursor Scroll Margin, List Marker, Indent, Tab Width, Paste URL, Font Weight, Line Height) is a value row that opens its own page of checkmark rows with the setting's hint as its footer, in place of the page's selects and steppers.
Cursor Scroll Margin offers 0, 20, 40, 60, 80, 100, 150 and 200; a stored value outside those shows in its place among them.
The rows have no information buttons: a label and at most one short description.
Removing a licence asks first in the system's alert.
The Trial, Mac licence key and purchase sheets are one content-sized system sheet with a grabber, up to 92% of the height the sheet may take.

Panes: controls sit in grouped cards, `size.phone-group-gap` apart, laid out as Phone grouped lists in `design/layout.md`: rows of at least `size.phone-grouped-min`, hairlines between them from the 16 keyline, and every value, switch and chevron on one right edge.
A choice reads as an iOS row: its value in `color.phone.text-secondary` with the disclosure chevron, cut with an ellipsis rather than wrapped, and the whole row opens its page of choices.
A disabled row's contents fade once to `opacity.disabled`, its switch drawn as an enabled one.
A section that would repeat the screen's title (Licence, Preview) has no head, so its first card starts where other panes' do.
The Appearance pane shows the themes as cards, two columns of six, each with a light and a dark `size.phone-swatch` swatch drawn from that theme's own colours: the card sets both appearances, a swatch its own, and a chosen swatch has a `size.phone-swatch-ring` ring and a sun or moon badge.
Its colour scheme is three `size.phone-scheme-card` cards, each a mini phone in the chosen themes, Auto split down the middle.
Each text slider is named on a line above its track, its value on the right, with the small and large A at its ends.
The text size slider keeps the setting's full range, 10 to 32.
Switches, sliders and the segmented control are the system's, tinted in the accent colour.
A card's buttons are full-width action rows under the row's text, labels in the accent colour, wrapped rather than cut.
A button that removes something (a device, the AI key, the license) is in `color.phone.destructive`; the Mac keeps them plain and puts the warning in the confirmation.
Sync (`SyncLayout`): the switch and relay with one footnote, then setup rows until this iPhone is enrolled, then storage, then Devices and pairing.
Each device shows the date it was added or last seen, this iPhone has a `phone.sync.you` badge in place of the Mac's "This Device", and Remove is in `color.phone.destructive`.
The recovery key and every note in a card scale with the text.
The recovery key shows only while a new vault's key waits to be saved, as on the Mac; once saved neither has anything to do with it, so there is no row.
AI: the provider segmented control and its endpoint, model and key with its state under the field, then next edit suggestions.
There are no accent swatches.

Sheets: note info, the pickers, the trial and short messages rise from the bottom edge, the full width of the screen, with `radius.phone-sheet` on the top corners only, since a floating sheet's corners cannot be concentric with every device's. They render at the app's root, over everything; the scrim covers the whole screen. The contents scroll inside, and their bottom padding clears the home indicator (`safe-area-inset-bottom` plus `size.phone-sheet-inset`, at least 16). A sheet is modal: it takes the keyboard when it opens, the rest of the app is inert behind it, Tab goes round its own controls, Escape closes it, and the keyboard goes back to what opened it. A sheet opened over a sheet is the live one until it closes. The tag field's corners are concentric with the sheet (`radius.phone-sheet` less `size.phone-sheet-pad`), and the colour picker's previews cut a long name with an ellipsis and stack at the accessibility sizes.

Detail sheet, for the trial and a failed suggestion: a sheet with a `color.phone.lens` circle holding the info icon, a 20 bold title, the body 16/24 in `color.phone.text-secondary`, and a full-width glass Done, `size.phone-sheet-done` high.

Purchase sheet (App Store builds): its head is the dove in a `color.phone.lens` circle, a 20 bold title and the glass close circle on the trailing edge, a 44 target that closes it as Escape and a drag down do.
The title is Devot Pro, and says the trial has ended once it has.
Under it, three lines of what Devot Pro unlocks, each with a check in `color.accent.text`, in the grouped row's text sizes: 16/23 in the body colour, and under the first, 14/19 in `color.phone.text-secondary`, that reading and search stay free.
Then one filled action, `size.phone-sheet-done` high: Try Free while the trial is available, with Buy Once and StoreKit's price as a 44 accent text button under it; once the trial has ended, Buy Devot Pro with the price is the filled action and the trial is gone.
The price always sits in the buy action, and Buy names no price until StoreKit gives one.
Restore Purchases and Enter License Key share the last line, each a 44 target in 15 accent text, with a `size.phone-separator` hairline in `color.phone.separator` between them; Enter License Key and the hairline are there only in a build that takes keys.
Opened by a write while editing is locked, its title says that Devot Pro is not active while the trial is available, and that the trial has ended once it has; the rest is the same.

Pro sheet, for a write while editing is locked in every other state: the dove in a 56 `color.phone.lens` circle, then a 20/25 bold title and one 16/24 line in `color.phone.text-secondary`.
Then one filled action, `size.phone-sheet-done` high, and Not Now as a 44 target in 17 accent text.
The action is Enter License Key when no license is held, Open License Settings when the license or this device's seat needs attention, and Try Again while App Store purchases or the keychain could not be read.
While App Store purchases could not be read, Restore Purchases follows Not Now as a third.
It has no close circle, names no price and links nowhere; a check in progress or a failure shows in one 14/19 line under the action.
Every write the phone offers goes through one gate (`phone/requireEditing.ts`), so a tap shows one sheet and never a write that silently fails.

Note: a note opens in Preview, and an empty one in Edit, chosen once when its body has loaded.
While editing is locked a note opens in Preview and stays there: the mode toggle, a task box, the title, the chips and the AI circle show the lock's sheet instead.
Its text, in Edit and Preview, shares the title's left and right edges. A later change to the body never changes the mode. Back and Forward return to a note in the mode it was left in; leaving the note's screen forgets that. The top bar has a back circle, the notebook's path in mono, and a capsule of the mode toggle and info. Below it the title 26 bold, wrapping to as many lines as it needs (Return adds none), the chips, a long name cut with an ellipsis at the screen's width, then the edit time and word count in `.phone-figures`; there is no per-note sync state. The bottom has a glass capsule of Back and Forward, a find circle and, in Edit, an AI circle with its sparkle in the caret colour. While typing the bottom fades and the formatting bar sits on the keyboard, with a hide-keyboard circle.
Under the native screens a note is its own screen pushed over the list, full bleed under the system bar, which holds Back, More, the mode toggle and Info; the toggle shows the mode it switches to.
More holds Pin, Status, Move to Notebook, Tags, Share, Find in Note, Duplicate and Move to Trash.
The system's bottom toolbar holds Back, Forward, Find and, in Edit, AI, and steps aside while the keyboard is up.
The page then draws none of its own bars: no top bar, no bottom capsule, no formatting bar, no find bar and no info sheet, since the screens' stack is the note's history and a link pushes the linked note's screen.
While typing in Edit the native formatting bar sits on the keyboard: a glass capsule of 44 pt buttons and a Hide Keyboard circle, solid under Reduce Transparency or Increase Contrast.
The chips open the native pickers; Info opens Note Info as a system sheet with its figures, notebook, the created and modified dates, the backlinks and Move to Trash.
The bar shows the title only once the note's own has scrolled under it.

Find: the editor's own find, in a glass bar on the keyboard with a count, its numbers in `.phone-figures` and its words in the body font, previous, next and a close circle. It switches a note in Preview to Edit.
Under the native screens the find bar is native, in the formatting bar's place, its count in monospaced digits.
While editing is locked that editor takes no caret, so a tap in the text raises no keyboard.

Note info: the sheet has the stats in mono, in two columns at the accessibility sizes; icon rows for notebook, created, modified and, on an enrolled device, synced devices, plain rows at full opacity, not buttons, each value under its label at the accessibility sizes; backlinks, which opens the linking notes when there are any; and Move to Trash. There is no revision history or export row: neither has a phone screen yet.

Undo toast: regular glass, not interactive, `size.phone-toast` high between the `size.phone-screen-edge` keylines, `size.phone-toast-gap` above the tab bar (or above the safe area where no bar is up, and above the keyboard while it is), over a `shadow.phone-float-*` shadow in `color.phone.float-shadow`; the kind's glyph, the message and the Undo pill.
The Undo pill (`size.phone-toast-undo`) reaches its 44 target inside the toast.

## Dynamic Type

Text follows the system's text size, up to the largest accessibility size.

- Numbers in the specs are at the default size (Large). The scale is the computed size of `font: -apple-system-body` over 17, read at launch and on return to the foreground, and set on the root as `--phone-text-scale`; every font size and line height in the layout is its number times that scale.
- Heights that hold text are minimums, so `size.phone-list-row`, `size.phone-grouped-row`, `size.phone-info-row` and `size.phone-chip` grow with their text. Nothing is positioned by assuming a row height.
- Text wraps rather than being cut wherever a row can grow. At the accessibility sizes a note row's title may take two lines.
- Icons beside text grow with it. Glass bars keep their heights and glyphs, because they sit in fixed places: the top bar's title stops at 1.35.
- The note's editor and preview keep the text size chosen in Settings, and start from the system's scale until one is chosen.
- Preview Font Size is the preview body's size in pixels: the phone draws the Glass type scale at the body size (`note.heading.glass.body-size`) rather than at `preview-reference`, so headings keep their ratios to it.

## Icons

SF Symbols only, through `symbol_png` (ADR 0001), monochrome in the text colour. A device is drawn with a generic shape (`phone.devices`), never a symbol that depicts an Apple product. Settings and Library rows have no coloured tile: a `size.icon-phone-row` line icon sits in a `size.phone-row-icon` column, a tag in the same column shows a dot in its colour. A selected tab uses its `.fill` symbol. The synced double tick is `check` drawn twice.

Weights: `regular` at 18 pt and above, and `medium` for chevrons of 14 pt and below, the closest symbol weights to the design's 1.8 and 2.2 strokes.

Status marks are `size.icon-phone-status` symbols in the status colours (`phone.status.*`): active `circle`, on hold `pause.circle`, completed `checkmark.circle.fill` with a white check, dropped `xmark.circle`, no status `circle.dashed`. The Mac's `status.*` symbols stay filled.
