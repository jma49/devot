# First-launch notes

Part of the [architecture overview](../architecture.md).

A library that has never held anything (no live note, no note in the Trash, no notebook) gets a "Getting started" notebook with a welcome note and a Markdown example, once (`seedWelcome` in `src/core/welcome.ts`).
The notebook and notes have fixed IDs, so deleting them never brings them back (a purged note is never written again, and a trashed one keeps the library non-empty) and devices that seed separately merge.
Each body is seeded as a Yjs state every device builds alike (`NoteService.seed`: one insert by a Yjs client derived from the note's ID and text), so two seeded copies merge as one body; the note's later edits are made by the device's own client.
A device whose build seeded another text gets another client; when sync merges two such copies and one of them was never edited (its state holds the seed's client alone), the merge deletes that copy's characters, so the note shows the other copy's text once and both lineages go on (`mergeNote` in `src/core/sync/records.ts`).
Copies that were both edited keep both texts whole, one after the other, never mixed.
The text is bundled Markdown in `src/renderer/src/welcome/`; `{{key:<command>}}` is replaced with the command's default key from the registry.
The UI tests' libraries start empty unless a test sets `devotSeedWelcome`.
