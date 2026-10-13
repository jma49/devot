-- Schema v13: revision history and its compaction off the hot path
-- (src/core/revisions.ts, NoteService's sweep).

-- A note's history, and what a compaction sweep weighs, read from an index
-- that covers them, never from a row: a version's Yjs state comes before
-- `length` and `value` in the row and often fills overflow pages. It takes
-- the place of revisions_note (note_id, at), which it starts with.
DROP INDEX revisions_note;
CREATE INDEX revisions_history ON revisions (note_id, at, id, kind, length, value);

-- When the last compaction sweep ran (one row; none before the first), so a
-- sweep, the first of a session too, weighs only the notes with a version
-- that turned a day or a week old since.
CREATE TABLE compaction (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  swept_at INTEGER NOT NULL
) STRICT;
