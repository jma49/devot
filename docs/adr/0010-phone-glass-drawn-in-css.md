# The iPhone's glass is drawn in CSS

Status: accepted; superseded by ADR 0018 (docs/adr/0018-iphone-native-shell-around-a-web-editor.md) from its stage 4 on, when the web shell and its CSS glass go.
Until then the web shell keeps this recipe.

The iPhone layout's floating controls follow the Liquid Glass design language, drawn in CSS. The recipe: a light fill of `color.phone.glass`, `backdrop-filter` blur 10 px with saturate 1.9 and brightness 1.04, a 0.5 pt edge, inner highlights at the top left and bottom right, a soft inner glow, a two-layer drop shadow, a 1.2 pt gradient rim that is bright at the top left and bottom right and clear between, and a radial sheen from the top left. It does not place `UIGlassEffect` views behind the web view, and it uses no SVG refraction filter, which WebKit does not apply to a backdrop.

## Why

The phone's glass controls are many, small and move with the finger: a push carries a whole screen's controls, and the tab bar's lens squashes as it slides. Native views would have to follow those positions across the web view boundary in every frame, and a late frame shows as glass detached from its control. CSS moves with the page by construction and works on every iOS version the app supports.

## Consequences

- CSS glass does not refract or respond to the system's lighting as the system's material does. This is the accepted visible cost.
- Glass stays on floating controls: top bar buttons and capsules, the tab bar, the compose circle, the note's bottom bar, the keyboard's accessory bar, menus, toasts and sheets' buttons. Content (rows, cards, the note) is never glass, the rule that keeps the look legible.
- Reduce Transparency and Increase Contrast replace glass with `color.phone.glass-opaque`: no `backdrop-filter` runs, and the rim, the sheen and the inner light go.
