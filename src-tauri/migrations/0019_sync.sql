-- Schema v19: what sync knows of each record (docs/adr/0002-sync-latest-state-per-record.md,
-- src/core/sync). A record is a note (its tags included), a notebook or a tag, under the row's ID.
--
-- `version` is the relay's version this device last saw of the record and `fingerprint` the state
-- that version stands for here, so the engine pushes only what changed since. `body_hlc` orders the
-- note's last body change against its move to the Trash (`body_fp` is the body it was taken for).
-- Every write of a row moves `edits` on (the triggers below, in every storage alike); the engine
-- looks at a record again while `edits` differs from `synced`, the count it last looked at.
CREATE TABLE sync_records (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('note', 'book', 'tag')),
  version     INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  body_hlc    TEXT NOT NULL DEFAULT '',
  body_fp     TEXT NOT NULL DEFAULT '',
  edits       INTEGER NOT NULL DEFAULT 1,
  synced      INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

CREATE INDEX sync_pending ON sync_records (id) WHERE edits <> synced;

-- The pull cursor, the vault epoch it belongs to and the last sync's time, by key.
CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

INSERT INTO sync_records (id, kind) SELECT id, 'note' FROM notes;
INSERT INTO sync_records (id, kind) SELECT id, 'book' FROM books;
INSERT INTO sync_records (id, kind) SELECT id, 'tag' FROM tags;

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
