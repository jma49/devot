-- Schema v22: attachments in sync (docs/adr/0003-sync-attachments-as-records.md). A file is a
-- sync record of kind 'file' under its own ID. `note_hlc` is the clock of the last change of
-- `note_id` (the higher one wins when two devices pass a file to different notes); '' for a file
-- never passed on. A file purged on any device has no row here, only its sync_records entry: the
-- tombstone the engine pushes and keeps.
ALTER TABLE files ADD COLUMN note_hlc TEXT NOT NULL DEFAULT '';

-- A release that skipped file records still moved its pull cursor past them: pulling again from
-- the start brings the images in (the records already held are skipped by version).
DELETE FROM sync_state WHERE key = 'since';

-- sync_records takes a fourth kind, which a CHECK cannot be altered into: the table is made again.
DROP TRIGGER sync_note_insert;
DROP TRIGGER sync_note_update;
DROP TRIGGER sync_note_tag_insert;
DROP TRIGGER sync_note_tag_update;
DROP TRIGGER sync_book_insert;
DROP TRIGGER sync_book_update;
DROP TRIGGER sync_tag_insert;
DROP TRIGGER sync_tag_update;

CREATE TABLE sync_records_v22 (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('note', 'book', 'tag', 'file')),
  version     INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  body_hlc    TEXT NOT NULL DEFAULT '',
  body_fp     TEXT NOT NULL DEFAULT '',
  edits       INTEGER NOT NULL DEFAULT 1,
  synced      INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

INSERT INTO sync_records_v22 SELECT * FROM sync_records;
DROP TABLE sync_records;
ALTER TABLE sync_records_v22 RENAME TO sync_records;
CREATE INDEX sync_pending ON sync_records (id) WHERE edits <> synced;

INSERT INTO sync_records (id, kind) SELECT id, 'file' FROM files;

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
