# Plugins with notes.read read every live note, and write none

Status: accepted (2026-11-16). Takes up the access to other notes ADR 0005 left for its own decision, in plugin API version 2 (ADR 0020).

A plugin with the `notes.read` permission lists, searches and reads the live notes outside Templates and the Trash, and lists the notebooks.
It changes none of them: the open note stays the only one a plugin may change, with `note.edit`, while one of its commands runs.

## Why

- Dashboards, task lists, indexes and statistics need more than the open note, and they need it while their panel or a preview block shows, not only while a command runs.
- A plugin cannot reach the network or another plugin, so what it reads stays on this Mac unless the user exports it; reading is the step that needs the user's approval, and the review sheet names it in words.
- Per-notebook scopes were left out: the notebooks' Allow AI Access switch answers a different question (what leaves the Mac for an AI model), and a second switch per notebook would ask the user to repeat that choice for each plugin.

## Rules

- Methods (protocol 1, API 2), all needing `notes.read` and none a running command: `notes.list` `{ limit }`, most recently changed first; `notes.search` `{ query, limit }`, as the app's search finds them; `notes.get` `{ id }`, the title, notebook and Markdown; `notebooks.list`, each notebook's ID, name and parent.
- `limit` defaults to 50 and is cut to 500 for a list and 100 for a search; a query is 1 to 200 characters and a note ID up to 64 letters, digits and hyphens.
- A note in Templates, in the Trash or missing answers `E_PLUGIN_NOTE_NOT_FOUND`.
- Reads go through the core as the app's own do (`src/renderer/src/plugins/notes.ts`), so a plugin sees what the note list sees.

## Consequences

- `note.read` keeps its meaning: the open note, while the plugin is in use.
- Tests: `protocol.test.ts`, `host.test.ts` and `tests/ui/plugin-notes.spec.ts`, which reads seeded notes from a sandboxed frame.
