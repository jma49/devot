# Localisation

Part of the [architecture overview](../architecture.md).

- English is the source locale and the only one shipped now.
- No UI text is written inline: every string comes from a typed message catalog by key (English in `src/renderer/src/i18n/en/`, one module per UI area, merged into one typed object), so adding a locale means adding a catalog, with English as the fallback for missing keys.
  The locale follows the macOS preferred languages.
- Placeholders (`{title}`) are filled with `format` in one pass, never with `String.replace`, whose replacement patterns (`$$`, `$&`, `$'`) would garble a title holding them; a policy test refuses `.replace('{`.
  A sentence is never built from pieces in code: each variant (with or without a count, a key or a scope) is its own catalog entry.
  No message has a `{code}` slot or names an error code; the code goes to the log ([quality](quality.md)).
- The iPhone's native screens read the same catalog: `pnpm i18n:apple` (`scripts/i18n/apple.ts`) writes `Generated/Strings.swift` and `Generated/Localizable.xcstrings` under `src-tauri/apple/DevotScreens/Sources/DevotScreens/`, both committed, and `pnpm i18n:apple:check` fails CI when they are stale.
  Each key is one static function of `enum L10n`, named in camel case (`phone.tab.notes` is `L10n.phoneTabNotes()`), that takes the message's placeholders as labelled `String` arguments in the order they appear.
  The text is the iPhone's wording where it has its own (`src/renderer/src/i18n/phone.ts`), which may use only the message's own placeholders.
  `L10n` looks the key up in the string catalog with the English as its fallback, then fills the placeholders in one pass as `format` does; the catalog keeps `{name}` placeholders as they are, so a translation is written as on the page.
  The `ios-check` CI job runs that filling against the page's `format` cases (`src-tauri/apple/DevotScreens/Checks/main.swift`).
  A placeholder name must start with a letter or an underscore, since it becomes a Swift argument label (`E_I18N_PLACEHOLDER_NAME`).
  The `DevotScreens` package declares English as its default localisation and the string catalog as a resource.
  Swift never inlines a user-facing string, and Swift tests write CJK with `\u{...}` escapes.
- Dates, numbers and lists use `Intl`.
  When a second locale arrives, the catalogs move to ICU message syntax for plurals and placeholders, and native menu labels in Rust get the same catalog.
- Code contains no CJK characters at all; test data that needs them uses `\u` escapes.
  A test enforces this over every tracked file.
