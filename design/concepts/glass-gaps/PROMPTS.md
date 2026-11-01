# Glass interface: closing the gaps with the design

Four fix prompts, one per gap, each ready to paste into a coding agent working in the Devot repository. Every prompt works on its own; run them as separate branches and pull requests, in any order.

Reference images sit beside this file. For each gap:

- `gN-device.png`: the installed app on macOS (what is wrong today).
- `gN-before.png`: the same spot in the UI test build, before the fix.
- `gN-after.png`: the target, rendered from the current code with a prototype of the fix applied (CSS injected, or DOM edited for gap 2). Match it; the prototype is not the implementation.
- `gN-pair.png`: before and after side by side.

The design itself is the Liquid Glass canvas and `design/README.md` (section Look, "Glass interface").

Every prompt assumes the rules in `CLAUDE.md`: a branch and a pull request (never `main`), tests first, theme tokens only (no colour literals; run `pnpm tokens` after editing tokens), English UI text from the i18n catalog, no CJK characters in tracked files, motion from `motion.*` tokens, and `pnpm check` green before the pull request. Every change applies to the Glass interface (`:root[data-sidebar-material='on']`). Classic must look exactly as it does now.

---

## Gap 1: content is cut off hard under the note header

Images: `g1-device.png`, `g1-pair.png`

```
In the Glass interface, when a note's editor or preview scrolls, the content disappears under the note's
title and metadata row with a hard edge: half a heading stays visible right under the pills (see
design/concepts/glass-gaps/g1-device.png and g1-before.png). The design calls for a scroll edge effect:
content fades out over about 28 px as it passes under the header (g1-after.png).

Do this:
- In src/renderer/src/app.css, Glass interface section, fade the top of `.content > .panes` with a
  mask-image gradient (transparent at 0, opaque at a new token, e.g. size.scroll-edge = 28px, added to
  design/tokens/base.tokens.json with a $description, then `pnpm tokens`).
- Show the fade only once the pane has scrolled. At rest the first line (the note info card) must stay
  fully opaque. Set a data attribute (e.g. `data-scrolled`) on `.content` from the scroll position of
  whichever pane scrolls: the preview, and the editor's scroller inside its shadow root (scroll events
  do not cross the shadow boundary, so listen on the shadow root or the scroller itself). In split view
  each pane fades on its own.
- The fade comes and goes with motion.duration.quick and motion.easing.quick; under Reduce Motion
  (`:root[data-motion='reduced']`) it switches without a transition.
- Classic keeps the hard edge.

Tests first: a unit test for the function that decides `data-scrolled` from scrollTop (0, 1, a few
pixels), and a Playwright UI test (tests/ui) that scrolls a long note in Preview and in Editor and
checks the attribute and the computed mask-image on `.panes`, and that Classic has no mask.
Pull request title: "fix: fade note content under the header as it scrolls in the Glass interface".
```

---

## Gap 2: an untitled note's row has no title line

Images: `g2-device.png`, `g2-pair.png`

```
In the note list (Glass interface), a note without a title shows its time alone on the first line,
with its first line of text, or "Untitled", in the excerpt below (design/concepts/glass-gaps/
g2-device.png, g2-before.png). Every other row shows its title on the first line with the time
at the right edge, so this row looks broken. Target: g2-after.png.

Do this in src/renderer/src/NoteRow.tsx (and its CSS in app.css):
- When the note has no title, still render the `.row-title` line. Its text is the headline the row
  already gets (the note's first line, `props.headline`). With no headline, the text is
  t('note.untitled'), drawn in color.text.tertiary (add `data-untitled` and style that; no literal
  colours).
- The excerpt then shows the rest of the text without repeating the headline. When nothing is left,
  render no excerpt line.
- The time, status, progress, tags and activity strip keep the places they have on titled rows: the
  time is on the title line at the end, and the rest goes under it.
- Search highlighting (`highlight.title` / `highlight.body`) must still mark matches in the headline
  shown as the title.
- Screen readers: the row's accessible name must not change wording beyond the title now coming
  first.
- Check Classic: it gets the same markup, so take before and after screenshots of the list in
  Classic and keep its look (same spacing; the headline was bold there already).

Tests first: update src/renderer/src/NoteRow.test.tsx. It currently expects
`<span class="row-headline">` inside the excerpt; it should now expect a `.row-title` with the
headline, an excerpt without it, "Untitled" with data-untitled for an empty note, and highlighting in
both. Add a UI test that creates an untitled note and checks that its title line and the time sit on
one line (same top within 2 px).
Pull request title: "fix: give untitled notes a title line in the note list".
```

---

## Gap 3: preview tables keep square, heavy borders

Images: `g3-device.png`, `g3-pair.png`

```
In the Glass interface every surface has rounded, concentric corners, but tables in the preview still
draw a full grid of 1 px borders with square corners (design/concepts/glass-gaps/g3-device.png,
g3-before.png). Target: g3-after.png. The table is one rounded box (corners radius.list-row, 12) with
a hairline edge. Inside it, only separators between rows and between columns, the head row on
color.table.head, header cells start-aligned, and a little more padding.

Do this in src/renderer/src/preview/content.css, scoped to `:root[data-sidebar-material='on'] .preview`
so exported and printed pages (which never carry that attribute) keep today's table:
- `border-collapse: separate; border-spacing: 0; border-radius: var(--radius-list-row); overflow: hidden;`
  and the outer edge as `box-shadow: 0 0 0 1px var(--color-line-hairline)` (no border, so the radius
  clips cleanly).
- Cells: no border except `border-bottom: 1px solid var(--color-line-separator)` and, from the second
  cell on, `border-inline-start` the same. The last row has no bottom border.
- Padding `var(--space-3) var(--space-6)`. The zebra stripe (color.table.stripe) stays.
- A table wider than the pane still scrolls sideways inside its rounded box, not the page. Check the
  existing wrapper.
- While you are there, check that code blocks, the note info card and alerts in the preview also use
  the glass radii (radius.list-row / radius.note-info), and list anything else that is still square
  in the pull request.

Tests first: a CSS policy-style test (like tests/policy/selection-fills.test.ts) that the Glass rules
for `.preview table` set a radius token and no cell `border` shorthand, and a UI test that the
computed border-radius of a preview table is 12px in Glass and 0px in Classic, and that an exported
page's table is unchanged.
Pull request title: "fix: round preview tables in the Glass interface".
```

---

## Gap 4: Settings controls are not Glass yet

Images: `g4-device.png` (the installed app at +100 transparency), `g4-pair.png`, `settings-before.png`, `settings-after.png`

```
The main window follows the Glass design (#430), but the Settings part of that work never landed. On
the device (design/concepts/glass-gaps/g4-device.png) the slider knob is a translucent, nearly invisible
disc over the track, the switch knob is a circle, and the cards keep radius 12. Target: g4-after.png
and settings-after.png: an opaque white capsule knob on the slider (32 x 22, glass rim and soft shadow),
a wider switch (44) with a capsule knob (26), and cards and picture choices at radius 18, concentric
with the floating navigation.

The original implementation is the second commit in test-results/liquid-glass.patch ("feat: Settings
follows the Glass interface"). Port it onto current main rather than writing it again:
- Tokens: radius.glass-card (18), size.glass-switch-width (44), size.glass-switch-knob-width (26),
  size.glass-slider-knob-width (32), with $descriptions; `pnpm tokens`.
- app.css, Glass interface: `--radius-settings-card: var(--radius-glass-card)` on body; the slider's
  thumb as a capsule on color.switch-handle with the glass rim; the switch track and knob widths and
  the checked translate computed from the new tokens.
- Check what main already does for the Settings navigation (#430 added a sheet around it) and keep
  one rule per property. Drop anything of the patch that main has already done.
- If main has not already done it: `sidebar_glass` serves the Settings window too (has_glass_sidebar:
  main windows and settings::LABEL), Settings calls startSidebarGlass(GLASS_SIDEBARS.settings), and
  capabilities/settings.json grants allow-sidebar-glass (and tests/security/capabilities.test.ts lists
  it).
- The slider knob must stay visible against the filled track at every value (-100, 0, +100), in light
  and dark.

Tests: the patch's tests (sidebarGlass GLASS_SIDEBARS, sidebar_glass has_glass_sidebar,
capabilities), plus a UI test reading the computed width of the switch (44px) and the slider thumb
(32px) in Glass, and the Classic values unchanged. Run `pnpm rust:check`.
Pull request title: "feat: Settings follows the Glass interface: capsule controls, larger cards".
```

---

## Not a gap (left as is)

The selected sidebar row is a neutral grey where the mock-up shows a white glass highlight. That follows the selection rules in `design/README.md`, which `tests/policy/selection-fills.test.ts` enforces: one selection strength for every pane, the accent with the keyboard, neutral without it. Change it only together with those rules.
