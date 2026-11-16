# Plugins read the selection, write in its place, and hear which note opens

Status: accepted (2026-11-16). Adds editor calls to plugin API version 2 (ADR 0020), under the permissions ADR 0005 already has.

A command can read the editor's selection in the open note and put text in its place, as one undo step; a plugin with `notes.read` hears which note the editor shows.

## Why

- Text tools, citations and snippets change the words the user picked, not the whole note: with only `note.replace` a plugin had to send the note back whole and could not see the selection.
- A dashboard or a panel that follows the open note needs to know when it changes, without waiting for a command.

## Rules

- `note.selection` (`note.read`, while a command runs or the panel shows) answers `{ from, to, text }` for the main selection, in UTF-16 offsets of the note's Markdown; the caret is an empty selection.
- `note.insert` `{ text, selected? }` (`note.edit`, while active) puts `text` in place of the main selection and leaves the caret after it, as one undo step in the editor.
  With `selected`, it is refused with `E_PLUGIN_NOTE_CHANGED` once the selection no longer holds that text, so a plugin that read the selection never overwrites a newer one.
  A note it would take past the body limit is refused with `E_NOTE_BODY_TOO_LARGE`; a read-only licence refuses it with `E_LICENCE_REQUIRED`.
- Both act on the editor only while it shows the open note; otherwise they answer `E_PLUGIN_NO_NOTE`.
- The host sends `note.opened` `{ id }` (the note's ID, or null when none is open) to each running plugin with `notes.read`, when the open note changes and when such a plugin starts.
  The runtime keeps the last ID for `devot.notes.opened()` and calls `devot.notes.onOpened` listeners with it.

## Consequences

- The edit goes through the editor, as typing does, so it syncs and saves like the user's own; `note.replace` stays the way to change the whole note through the core.
- A plugin without `notes.read` learns nothing about which note is open outside its own commands.
- Tests: `protocol.test.ts`, `host.test.ts`, `editor/pluginText.test.ts` and `tests/ui/plugin-editor.spec.ts`.
