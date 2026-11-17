# Plugins query notes by tag, status and properties

Status: accepted (2026-11-16). Builds on reading other notes (ADR 0022) and plugin drawings (ADR 0027), for query plugins such as a Dataview-style table of notes.

A plugin with `notes.read` sees enough of each note to filter and sort it, and a block it draws from the notes follows them as they change.

## Why

- A query names notes by tag, status or a front matter field; reading every note's Markdown to find those would be slow and would make each plugin parse YAML its own way.
- A drawn block is kept by its source, which does not change when the notes it lists do, so it would go stale.

## Rules

- A note summary (`notes.list`, `notes.search`) carries its tag names, its status and whether it is pinned, besides its ID, title, notebook and dates.
- `notes.get` carries `properties`: the note's front matter as JSON values, read with the YAML core schema; front matter that is not a map, or that cannot be read, gives `{}` (`src/core/frontMatter.ts`).
- The page loads the front matter parser the first time a plugin reads a note, so the main window starts without it.
- When an enabled plugin has both `preview` and `notes.read`, every plugin block is rendered again 1 s after the notes settle from a change, made in this window or elsewhere (`src/renderer/src/plugins/libraryTurn.ts`); without such a plugin nothing is redrawn.
  Only the pieces of the note that may hold a plugin's block are rendered again (`mayHoldPluginBlock`, `src/core/preview/plugins.ts`): the rest of a long note stays as it is shown.
- An island may name a revision; the page draws an island again when its revision changes, even when its source has not (`src/renderer/src/preview/islands.ts`).

## Consequences

- A typed edit redraws such blocks at most once a second, and only while a preview shows them.
- A plugin still sees no note's text without `notes.get`, and none in Templates or the Trash.
