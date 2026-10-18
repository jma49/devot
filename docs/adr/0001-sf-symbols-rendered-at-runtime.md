# SF Symbols are rendered by macOS at runtime, never stored

Devot's icons are SF Symbols. The repository and the app bundle hold symbol names only (`design/icons/symbols.json`); the `symbol_png` command asks AppKit for each image at runtime and the UI caches it per name, size and appearance.

## Licence finding

SF Symbols come with Apple's SF Symbols licence (part of the Xcode and Apple SDKs agreement). What it allows and forbids, as it applies to Devot:

- The symbols may be used in software built for Apple platforms. Devot runs on macOS only, so drawing them in its UI is allowed.
- The symbols may not be redistributed as artwork: no exported SVG, PNG or font copies in this repository, in `design/`, or in the app bundle. Asking the system for the image at runtime, as Devot does, ships nothing of Apple's.
- The symbols may not be used in a logo, app icon or trademark. Devot's dove and app icon are original artwork (`design/app-icon/`).
- Symbols that depict Apple products or services (devices, iCloud, FaceTime and the like) may only stand for those products; Devot uses none of them.
- `design/` is meant to become a publishable asset library: it may carry symbol names, which are not artwork, and nothing rendered from them.

## Consequences

- A new icon is a new entry in `symbols.json` naming an existing symbol; there is no icon artwork to review or license.
- Notebook icons the user picks come from a curated catalog of symbol names (`design/icons/notebook-symbols.json`), checked to exist on the oldest supported macOS and to depict no Apple product or service; Rust refuses any other name.
- Icons in content that leaves the app (exported HTML, a printed note) cannot be SF Symbols; they are Devot's own drawings (`src/core/preview/glyphs.ts`).
