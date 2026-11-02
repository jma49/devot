# The iPhone's glass is drawn in CSS for now

The iPhone layout's navigation controls follow the Liquid Glass design language. The first version draws that glass in CSS: `backdrop-filter` blur 20 px with saturate 1.9 (1.6 in dark), a fill of `color.phone.glass`, a white top highlight and a 0.5 pt edge. It does not place `UIGlassEffect` views behind the web view, as `sidebar_glass` does with `NSGlassEffectView` on the Mac.

## Why

The phone's glass controls are many, small and move with the finger: a push carries a whole screen's controls, and the tab bar's lens squashes as it slides. Native views would have to follow those positions across the web view boundary in every frame, and a late frame shows as glass detached from its control. CSS moves with the page by construction and works on every iOS version the app supports.

## Consequences

- CSS glass does not refract or respond to the system's lighting as the system's material does. This is the visible cost, and is why native glass stays the intended end state.
- Glass stays on the navigation layer: bars, top bar controls, sheets' controls. Content (rows, cards, the note) is never glass, the rule that keeps the look legible under either implementation.
- Reduce Transparency replaces glass with `color.phone.glass-opaque`, and no `backdrop-filter` runs.

## Follow-up

Put `UIGlassEffect` behind the web view for the controls that rest in one place (the tab bar first), in `native/ios.rs`, as `sidebar_glass` does on the Mac, once the layout has settled.
