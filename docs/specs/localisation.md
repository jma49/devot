# Localisation

Part of the [architecture overview](../architecture.md).

- English is the source locale and the only one shipped now.
- No UI text is written inline: every string comes from a typed message catalog by key (English in `src/renderer/src/i18n/en/`, one module per UI area, merged into one typed object), so adding a locale means adding a catalog, with English as the fallback for missing keys.
  The locale follows the macOS preferred languages.
- Placeholders (`{title}`) are filled with `format` in one pass, never with `String.replace`, whose replacement patterns (`$$`, `$&`, `$'`) would garble a title holding them; a policy test refuses `.replace('{`.
  A sentence is never built from pieces in code: each variant (with or without a count, a key or a scope) is its own catalog entry.
  No message has a `{code}` slot or names an error code; the code goes to the log ([quality](quality.md)).
- Dates, numbers and lists use `Intl`.
  When a second locale arrives, the catalogs move to ICU message syntax for plurals and placeholders, and native menu labels in Rust get the same catalog.
- Code contains no CJK characters at all; test data that needs them uses `\u` escapes.
  A test enforces this over every tracked file.
