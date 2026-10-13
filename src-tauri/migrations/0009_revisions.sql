-- Schema v9: revision history, local to this device (not synced, so no HLC
-- columns). A body version holds the note's Yjs state at that time and its
-- text length in characters; a metadata event holds the new value of the
-- title, notebook (NULL for none), status or pinned flag ('1' / '0').
-- Purging a note deletes its revisions; trashing keeps them. The core takes
-- versions and compacts them by age (src/core/revisions.ts).

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('body', 'title', 'book', 'status', 'pinned')),
  at INTEGER NOT NULL,
  ydoc BLOB,
  length INTEGER,
  value TEXT,
  CHECK ((kind = 'body') = (ydoc IS NOT NULL AND length IS NOT NULL))
);

CREATE INDEX revisions_note ON revisions (note_id, at);
