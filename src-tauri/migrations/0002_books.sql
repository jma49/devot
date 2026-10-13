-- Schema v2: nestable notebooks ("books") and each note's notebook.
-- Every synced field carries the HLC of its last write; storage keeps the
-- newer value per field (last-writer-wins), so a stale copy never wins.

CREATE TABLE books (
  id          TEXT    PRIMARY KEY NOT NULL, -- UUIDv7
  name        TEXT    NOT NULL,
  name_hlc    TEXT    NOT NULL,
  parent_id   TEXT,                         -- NULL: top level. No foreign key:
  parent_hlc  TEXT    NOT NULL,             -- sync may deliver children first.
  created_at  INTEGER NOT NULL,             -- Unix ms
  updated_at  INTEGER NOT NULL,             -- Unix ms
  deleted_at  INTEGER,                      -- Unix ms; NULL unless deleted
  deleted_hlc TEXT
) STRICT;

-- NULL: the note is in no notebook. A note whose notebook was deleted keeps
-- its book_id until it is moved; readers treat a deleted notebook as none.
ALTER TABLE notes ADD COLUMN book_id TEXT;
ALTER TABLE notes ADD COLUMN book_hlc TEXT NOT NULL DEFAULT '';

CREATE INDEX notes_live_by_book ON notes (book_id) WHERE deleted_at IS NULL;
