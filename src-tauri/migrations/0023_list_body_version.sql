-- Schema v23: the note list carries each note's body version, so the mirror
-- can tell a body that changed while its update time stayed (an older edit
-- synced in keeps the newer time). The index holds it with the rest of what
-- the list shows (see v14), so the list still never reads a row.
DROP INDEX notes_list;
CREATE INDEX notes_list ON notes (
  updated_at DESC, id DESC, title, book_id, status, pinned, created_at, deleted_at, purged_at,
  body_version
) WHERE deleted_at IS NULL;
