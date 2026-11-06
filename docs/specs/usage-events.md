# Usage events

Part of the [architecture overview](../architecture.md).

- **Catalog:** `track(name, properties)` (`src/core/usage.ts`) takes only events declared in `USAGE_EVENTS`, and every property is an enum of fixed lowercase tokens, a count or a duration (whole milliseconds), all required.
  The types reject anything else; `checkUsageEvent` rejects it again at run time (an undeclared or missing property, a string that is not a declared value, a negative, fractional or unsafe number) and copies only the declared keys.
  A policy test scans the catalog for property names that would describe content (title, name, ID, path, query and the like).
  Result counts that could fingerprint a library go in as buckets (`0`, `1`, `2-5`, `6-20`, `21-100`, `101+`).
- **Events today:** `note.created` (from New Note, the `[[` popup, Duplicate, New Note from Selection or a template), `search.run` (once results have shown for a second after typing; the scope, the number of clauses and a result bucket; reruns after edits and the same query again do not count) and `import.finished` (counts of notes, notebooks, images and problems, and the duration).
  Adding one: declare it in the catalog, label it in the i18n catalog (`usage.event.<name>`) and call `track`.
- **Store:** Rust keeps events in their own database, `<app data>/usage.sqlite` (`src-tauri/src/usage.rs`), not in the notes database: they carry no HLC and never sync, backups never include them (restoring one cannot bring back cleared events) and no AI tool ever reads the file.
  Each write and each listing drops events older than 90 days and keeps the newest 10,000.
  Deleted rows are zeroed in the file (`secure_delete`) and clearing empties the write-ahead log too; the file uses WAL with `synchronous = NORMAL`, since a crash may cost the latest events but never notes.
  The command checks the shape again (a dotted lowercase name, at most 16 properties whose values are short lowercase tokens or whole numbers).
  Recording failures are logged by code and never reach the user.
- **Access:** only the main window may record (`usage_record`); only the Settings window may read and clear (`usage_list`, `usage_clear`, `src-tauri/capabilities/settings.json`).
  The iPhone records none, so its Settings has no Usage row.
  Settings > Usage Data shows how many events are stored and of each kind (in cards), lists them on request (newest first, at most 500 shown, keys and values as stored) and clears them after a confirmation.
- **Upload (later):** `UsageTransport` is the seam for sending events off the device.
  Nothing implements it.
  It ships with accounts, behind an opt-in switch, and only then reads the stored events.
