-- Schema v25: saved searches, the sidebar's rows under Status (src/core/savedSearches.ts). A row
-- is a name and a query in the search field's syntax, kept as typed: notebook and tag names in it
-- are resolved when it runs, so one that names something deleted matches nothing and stays.
-- `sort_key` orders the rows by hand (src/core/order.ts), like notebooks. Synced as a record of
-- its own kind ('search'), merged per field by HLC like a tag.
CREATE TABLE saved_searches (
  id           TEXT    PRIMARY KEY NOT NULL, -- UUIDv7
  name         TEXT    NOT NULL,
  name_hlc     TEXT    NOT NULL,
  query        TEXT    NOT NULL,
  query_hlc    TEXT    NOT NULL,
  sort_key     TEXT    NOT NULL DEFAULT '',
  sort_key_hlc TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,             -- Unix ms
  updated_at   INTEGER NOT NULL,             -- Unix ms
  deleted_at   INTEGER,                      -- Unix ms; NULL unless deleted
  deleted_hlc  TEXT
) STRICT;

-- A Devot from before saved searches skipped their records on pull and noted the build that did
-- (sync_state 'skippedBy'); the engine of a newer build pulls everything again, so no cursor is
-- reset here.

-- sync_records takes a fifth kind, which a CHECK cannot be altered into: the table is made again.
DROP TRIGGER sync_note_insert;
DROP TRIGGER sync_note_update;
DROP TRIGGER sync_note_tag_insert;
DROP TRIGGER sync_note_tag_update;
DROP TRIGGER sync_book_insert;
DROP TRIGGER sync_book_update;
DROP TRIGGER sync_tag_insert;
DROP TRIGGER sync_tag_update;
DROP TRIGGER sync_file_insert;
DROP TRIGGER sync_file_update;
DROP TRIGGER sync_file_delete;

CREATE TABLE sync_records_v25 (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('note', 'book', 'tag', 'file', 'search')),
  version     INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  body_hlc    TEXT NOT NULL DEFAULT '',
  body_fp     TEXT NOT NULL DEFAULT '',
  edits       INTEGER NOT NULL DEFAULT 1,
  synced      INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

INSERT INTO sync_records_v25 SELECT * FROM sync_records;
DROP TABLE sync_records;
ALTER TABLE sync_records_v25 RENAME TO sync_records;
CREATE INDEX sync_pending ON sync_records (id) WHERE edits <> synced;

CREATE TRIGGER sync_note_insert AFTER INSERT ON notes BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'note')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_note_update AFTER UPDATE ON notes BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'note')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_note_tag_insert AFTER INSERT ON note_tags BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.note_id, 'note')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_note_tag_update AFTER UPDATE ON note_tags BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.note_id, 'note')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_book_insert AFTER INSERT ON books BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'book')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_book_update AFTER UPDATE ON books BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'book')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_tag_insert AFTER INSERT ON tags BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'tag')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_tag_update AFTER UPDATE ON tags BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'tag')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_file_insert AFTER INSERT ON files BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'file')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_file_update AFTER UPDATE ON files BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'file')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_file_delete AFTER DELETE ON files BEGIN
  INSERT INTO sync_records (id, kind) VALUES (OLD.id, 'file')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_search_insert AFTER INSERT ON saved_searches BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'search')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_search_update AFTER UPDATE ON saved_searches BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.id, 'search')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
