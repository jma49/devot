-- Schema v1: notes.
-- Shared by the Rust app and the TypeScript better-sqlite3 adapter (devot-mcp,
-- tests). Never edit a released migration; add a new numbered file instead.

CREATE TABLE notes (
  id          TEXT    PRIMARY KEY NOT NULL, -- UUIDv7
  title       TEXT    NOT NULL DEFAULT '',
  title_hlc   TEXT    NOT NULL,             -- HLC of the last title write
  body_md     TEXT    NOT NULL DEFAULT '',  -- Markdown snapshot derived from ydoc
  ydoc        BLOB    NOT NULL,             -- Yjs document state (source of truth for the body)
  created_at  INTEGER NOT NULL,             -- Unix ms
  updated_at  INTEGER NOT NULL,             -- Unix ms
  deleted_at  INTEGER,                      -- Unix ms; NULL unless in the trash
  deleted_hlc TEXT                          -- HLC of the last delete or restore
) STRICT;

CREATE INDEX notes_live_by_updated ON notes (updated_at DESC) WHERE deleted_at IS NULL;
