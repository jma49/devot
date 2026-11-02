# Motion

The spec for every motion in Devot. A new or changed interaction is classified here before it is built, and this file changes with the code. `tests/policy/motion-tokens.test.ts` enforces the parts a test can read.

It draws on Apple's [Human Interface Guidelines: Motion](https://developer.apple.com/design/human-interface-guidelines/motion), [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) and [Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/). Those give principles, not numbers; the numbers are Devot's tokens.

## Should it move?

Decide in this order; the first match wins.

1. **It follows the pointer or the keyboard directly** (a pane being resized, a drag image, typing): no motion. It is already moving with the hand.
2. **People do it constantly and read the result at once** (another note, another view, palette results while typing, a row's selection): no movement. A colour fade of `motion.duration.quick` at most.
3. **It says where something went or came from** (a sidebar opening, a row or card moving, a pop-up from its button): move it, or fade it when CodeMirror or a remount rules out moving.
4. **It confirms an action on a control** (a press, a switch, a segment): brief feedback on that control only.
5. **It only decorates:** no motion.

Motion never carries meaning alone: the final state must say everything without it. Nothing waits for a motion to end: the new state takes keys, focus and clicks from the first frame.

Native menus and other system-drawn things keep the system's motion.

## Which motion

| What happens                                       | Motion                  | Duration                                         | Curve          |
| -------------------------------------------------- | ----------------------- | ------------------------------------------------ | -------------- |
| Hover, selection, focus: colour                    | fade                    | `hover`, or `quick` on sidebar and Settings rows | `out`, `quick` |
| Press                                              | shrink to `scale.press` | `quick`                                          | `move`         |
| Press released, segment's thumb                    | return, slide           | `settle`                                         | `spring`       |
| Two-state change (chevron, section, switch's knob) | turn, unfold, slide     | `toggle`                                         | `move`         |
| Pane, row or card changing place                   | slide                   | `slide`                                          | `move`         |
| Something growing                                  | size                    | `grow`                                           | `move`         |
| Pop-up from an anchor                              | grow and fade           | `popover`                                        | `move`         |
| Modal dialog                                       | grow, unblur and fade   | `dialog`                                         | `move`         |
| Content replaced in place (List or Board)          | fade in only            | `popover` or `toggle`                            | `standard`     |
| Colour meant to be noticed                         | fade                    | `color`                                          | `standard`     |

## Springiness

`motion.easing.move` has no overshoot and stays the curve for everything that travels. `motion.easing.spring` overshoots by about 3% and is for a press released. A segment's thumb under the pointer uses real springs (`motion.spring.*`, drawn by `springEasing`), with little overshoot. Apple's own controls respond more strongly to touch than to a trackpad, so even this stays slight on a Mac. Never use it on panes, rows, dialogs or menus. Reduced motion turns it off with the rest. Devot follows the system's Reduce Motion by default.

## Glass

A web view cannot bend light, so Devot does not imitate refraction in motion. It keeps what can be kept: a pop-up grows out of the control it belongs to, a pressed control answers in its first frame, and a thumb travels between segments rather than appearing. New Glass motion uses the same tokens and rules as Classic: the two styles differ in surfaces, not timing.

## Rules

- **One curve for movement.** Whatever moves, grows, unfolds or turns uses `motion.easing.move`: a critically damped spring drawn as a curve. It is already moving fast in its first frame, so the window answers at once; it settles softly and never overshoots. Ease-in-out (`motion.easing.standard`) is for opacity and colour only; hover and focus keep their own quick curves.
- **Interruptible.** A change that comes while a move is under way carries on from where things are seen, at the speed they have: a slide adds to the one under way (`composite: 'add'`, measured without it by `drawnOffset`), and a fade turns back from how opaque it is. Nothing jumps or restarts from rest.
- **Final state first.** The layout takes its new state at once; the motion plays from the old place to it on top (transforms), and is removed when it ends.
- **Compositor only.** Motion animates `transform` and `opacity`. Widths, paddings and heights change at once, and whatever they move slides there by a transform. A section opening and the backlinks expanding still animate their height (small areas; each is a known exception).
- **One speed factor.** Every timing comes from `motionTiming.ts`. In a development build `localStorage['devot.motionScale'] = '5'` plays all of it (the stylesheet's durations too) five times slower, to watch motion closely.
- **Waiting things wait in place.** A motion that starts after a delay holds its first frame (`fill: 'backwards'`) until it starts.

- Hover, press and selection: a control's fill, colour and edge ease over `motion.duration.hover` (180 ms, `motion.easing.out`); a sidebar row's over `motion.duration.quick` (100 ms, `motion.easing.quick`). A focus ring closes in on its control's edge as it comes, its colour and offset over `motion.duration.quick`, and so does a field's edge. Two-state changes (a disclosure chevron turning, a section opening) take `motion.duration.toggle` (200 ms); colour changes meant to be noticed take `motion.duration.color` (400 ms).
- Hiding or showing the sidebar (or entering focus mode): the pane that goes or comes fades and leaves or takes its room at once, and the panes that stay slide to their new places over `motion.duration.slide` (380 ms, `motion.easing.move`). A toolbar's room for the traffic lights opens at once, and the toolbar items it moves slide to their places with the panes.
- Rows: the sidebar's notebooks and tags that come, go or move fade and slide over `motion.duration.slide` (`motion.easing.move`), and its rows slide 80 px as a workspace opens or closes. A note that comes into or leaves the note list fades in or out where it is, over `motion.duration.insert` (300 ms), while the notes after it slide to their new places over `motion.duration.slide`, as do notes that change order. Only a small change to the list's own data moves (`rowMotion.ts`): another view, scrolling or a section opening never does.
- Sizes: the image viewer between Fit and Actual Size, a progress bar filling and the backlinks opening move over `motion.duration.grow` (300 ms, `motion.easing.move`); a tag chip just added grows from `motion.scale.chip-enter` as it fades in.
- A toolbar button's tooltip shows after the pointer rests `motion.delay.tooltip` (400 ms); it fades in and out over `motion.duration.popover`, without growing.

- Floating bar buttons (selection toolbar, image size bar): under the pointer and pressed look the same, a `color.line.control` ring over `color.fill.tool-hover`. The text colour eases over `motion.duration.color` (`motion.easing.standard`), the ring over `motion.duration.ring` (`motion.easing.out`); the fill snaps.
- Pop-ups we place ourselves (pickers, tag suggestions) grow from `motion.scale.popover-enter` out of their notch or anchor while they fade in, over `motion.duration.popover`, on their own layer. They rest on the two-layer `shadow.popover-*` shadow in the `color.shadow.popover-*` colours; menus (pickers, tag suggestions) have a 1px hairline edge and `radius.card` corners, and toolbar tooltips a notch pointing at their button.
- Completion lists, which CodeMirror places, only fade in, over `motion.duration.fade`: CodeMirror places a tooltip from its measured box, which a growing one would throw off. A code block's copy button grows from `motion.scale.popover-enter` as it fades in, over `motion.duration.toggle`.
- Menus (pickers, tag suggestions) also unfold from the edge they hang from over `motion.duration.toggle`, and fold back as they fade out.
- Modal dialogs grow from `motion.scale.dialog-enter` out of a `motion.blur.dialog` blur as they fade in, over `motion.duration.dialog`; closing, they blur and fade out over the same time while the dim fades out over `motion.duration.backdrop-exit` (400 ms), from as dark as it had become (its fade in lasts `motion.duration.backdrop`), played by an inert copy (`dialogMotion.ts`).
- Closing runs the opening backwards: pickers and tag suggestions shrink to `motion.scale.popover-exit` toward the same notch or anchor while they fade out, over `motion.duration.popover`; completion lists only fade out, over `motion.duration.fade`; floating bars come and go at once, with the selection (`floating.test.ts`). The pop-up itself goes at once, so focus, keys and the accessibility tree move on without waiting; an inert copy that assistive tech does not see plays the motion where it was (`closing.ts`), and a pop-up that opens again replaces its copy.
- Settings > Appearance > Motion > Animations (Always; Follow System, the default; Off) decides whether motion is reduced, shown on the root as `data-motion` (`motionPreference.ts`); every rule below for Reduce Motion reads it (`:root[data-motion='reduced']` in CSS, `motionReduced()` in code), never the system's media query alone.
- Reduced motion sets `--popover-enter-scale`, `--popover-exit-scale`, `--dialog-enter-scale` and `--chip-enter-scale` to 1 and the dialog blur to none (`app.css`), and stops chevrons turning, sections, menus and rows sliding or unfolding, and dialogs' closing copies: everything fades or shows at once, nothing grows, shrinks, turns or slides.

## Interactions

- **Buttons, tools, pop-up buttons, segments, a field's clear button:** shrink to `motion.scale.press` while pressed, and spring back on release. Editor floating bar buttons and rows do not: their pressed state is a fill.
- **Segmented controls:** the pressed look takes its new place at once, and a copy of it slides there on top (`segmentSlide.ts`) on a settling spring. Pressing the pressed segment picks the copy up: it can be dragged to another segment, in both interfaces, and the choice applies on release. In Glass it also lifts to `motion.scale.segment-lift`; a Classic toolbar's frame would clip that, so Classic does not lift. A control that remounts on the change gives the place it came from; another view never slides it. A pressed segment does not shrink.
- **Switch:** the knob widens by `motion.scale.knob-press` while pressed, away from the side it rests on, and stays a capsule. It animates width (small; a known exception to compositor only).
- **Task checkbox in the preview:** shrinks while pressed; the item's colour fades over `motion.duration.toggle`. The strike-through appears at once. A note that opens never plays this.
- **Status dot:** its colour fades over `motion.duration.toggle`.
- **Edit, Split and Preview:** a pane that comes slides in from its own side while it fades, and a pane that stays slides to its new place, over `motion.duration.slide`. Widths change at once; a pane that goes leaves at once. Reduced motion: the new pane only fades, over `motion.duration.toggle`.
- **List and Board:** the new body fades in over `motion.duration.popover`, in the same view only.
- **Board cards:** one that changes column flies there on a copy above the columns, as a column would clip it; the others slide as rows do (`rowMotion.ts`).
- **Settings:** a section fades in and rises `space.4` over `motion.duration.toggle`, without the rise under reduced motion; its row's fill eases over `motion.duration.quick`.
- **Dragging:** a drop line fades in and a column's or row's highlight eases over `motion.duration.quick`. The other rows stay where they are: moving them would change what is under the pointer, and the zones that tell before, into and after apart.
- **Image viewer:** opens and closes as a modal dialog does. **Plugin panel:** opens as one and closes at once, because a closing copy would run its frame again.

## Stays instant

Another note; another view; palette results; the editor's floating bars; a pane being resized; a window's theme or appearance changing (`data-appearance-changing` turns transitions off, because WKWebView can keep half-transitioned layers when a background window changes theme); text folding (it would animate height inside CodeMirror's measured layout).
