# Plugins edit the blocks they draw

Status: accepted (2026-11-16). Builds on plugin drawings (ADR 0027), for drawing plugins whose blocks are edited by hand, such as a sketch board.

A drawn renderer marked `editable` gives its drawing an Edit button; the plugin edits the block in its panel and the page puts the new text back in the note, in place of the block's content.

## Why

- A drawing kept as JSON in a code block cannot be edited by typing it.
- A whole-note `note.replace` from a command would make the plugin find the block itself and would rewrite text it never meant to touch.

## Rules

- `contributes.previewRenderers[].editable` is true or false (the default); it may be true only for an `svg` renderer (`E_PLUGIN_CONTRIBUTION_INVALID`).
- A drawn island names where its block is in the note (`data-block-from`, `data-block-to`, counted like the other offsets of a piece).
- The Edit button shows on hover or focus, only in a preview whose note can be changed, and never in print.
- The page asks the plugin through `preview.edit` with the block's content; the plugin is active while it answers, so it may show its panel and read the note, and it has an hour.
- Closing the plugin's panel ends the edit as declined; a plugin edits one block at a time (`E_PLUGIN_BUSY`).
- The answer is new content or null; it must be well-formed text within a note's size.
- The page puts it in the block's own fence, lengthened when the content holds as long a run of the fence's character, inside the same list item or quote, as one undo step (`src/core/plugins/blockEdit.ts`).
- The edit is refused with `E_PLUGIN_NOTE_CHANGED` when the editor moved to another note or the block's content is no longer what the plugin was given.

## Consequences

- Editing needs no `note.edit` permission: the plugin changes only the block the user chose to edit, and only when the user saves in its panel.
- Exported and printed pages show the block as code, as before.
