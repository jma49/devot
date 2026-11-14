# Localisation

Part of the [architecture overview](../architecture.md).

- English is the source locale; Simplified Chinese (`zh-Hans`) ships beside it.
- No UI text is written inline: every string comes from a typed message catalog by key (English in `src/renderer/src/i18n/en/`, one module per UI area, merged into one typed object), so adding a locale means adding a catalog, with English as the fallback for missing keys.
  The locale follows the system's preferred languages: `resolveLocale` takes the first tag with a catalog, matching `zh`, `zh-Hans`, `zh-CN` and `zh-SG` to Simplified Chinese and passing over Traditional Chinese tags (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`).
  The web view reports a language only when the bundle declares it, so both apps list every shipped language in `CFBundleLocalizations` (`src-tauri/Info.plist` for the Mac, `devot_iOS/Info.plist` and `project.yml` for the iPhone); a policy test checks all three.
- A translation lives in `src/renderer/src/i18n/<locale>/`, one module per area typed against the English module, so a missing or extra key fails the typecheck.
  Its `phoneWording.ts` gives the iPhone wording for exactly the keys `phone.ts` words, and a test checks that each translation keeps every key and placeholder of the English.
  A new English key gets its translation in the same change.
  A translation is a separate chunk that `setLocale` loads before the window renders, so a window parses only the English catalog and the one it shows ([startup chunks](../../tests/scripts/startup-chunks.build.test.ts)).
  The slash menu matches the English label as well as the shown one, so `/code` works in every language.
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
  Each translation adds its language to every entry of the string catalog, in its iPhone wording, and the generator refuses one whose placeholders differ from the English (`E_I18N_PLACEHOLDERS`).
  Swift never inlines a user-facing string, and Swift tests write CJK with `\u{...}` escapes.
- Dates, numbers and lists use `Intl`.
  Chinese has no plural forms, so the catalogs keep plain placeholders; a locale with plural rules moves them to ICU message syntax.
  Native menu labels in Rust (`src-tauri/src/strings.rs`) are still English and move to the catalog next.
- CJK characters appear only in the translation catalogs (`src/renderer/src/i18n/zh-Hans/`) and the generated `Localizable.xcstrings`; everywhere else, test data that needs them uses `\u` escapes.
  A test enforces this over every tracked file, and another checks the exception covers nothing more.
