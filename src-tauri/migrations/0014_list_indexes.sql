-- Schema v14: the note list, the Trash and search read notes from indexes
-- that cover them, never from a row. A note's small columns come after its
-- Markdown and its Yjs state in the row (columns added later go last), so
-- reading one from the row walks every overflow page of both, and a list
-- would cost more the longer the notes are.

-- Live notes in list order, with what the list shows and search filters on.
-- It takes the place of notes_live_by_updated (updated_at DESC), which it
-- starts with. `deleted_at` and `purged_at` are always null here (a purge
-- also sets `deleted_at`), but the statements name them, and an index
-- covers a statement only when it holds every column the statement names.
DROP INDEX notes_live_by_updated;
CREATE INDEX notes_list ON notes (
  updated_at DESC, id DESC, title, book_id, status, pinned, created_at, deleted_at, purged_at
) WHERE deleted_at IS NULL;

-- The Trash in its order, with what it shows. It takes the place of the
-- index of the same name (deleted_at DESC), which it starts with.
DROP INDEX notes_trash;
CREATE INDEX notes_trash ON notes (deleted_at DESC, id DESC, title, book_id, purged_at)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
