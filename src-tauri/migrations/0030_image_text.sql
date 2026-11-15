-- Schema v30: the text in the images notes hold, read on this device (docs/specs/search.md,
-- Text in images). Nothing here syncs: it is derived, and each device reads its own images.

-- What an image says, by the SHA-256 of its bytes, so the same image is read once.
-- '' when it holds no text or could not be read, so it is not read again.
CREATE TABLE image_text (
  hash BLOB PRIMARY KEY,
  text TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Each image file's hash, once read.
CREATE TABLE file_hashes (
  file_id TEXT PRIMARY KEY,
  hash    BLOB NOT NULL
) STRICT, WITHOUT ROWID;

-- One row for each note whose images hold text, keyed by the note's rowid as notes_fts is.
-- `version` moves each time the row's text changes, so semantic indexing reads the note again.
CREATE VIRTUAL TABLE note_image_text USING fts5(
  text,
  version UNINDEXED,
  tokenize = 'trigram'
);

-- The last version given: versions never repeat, even for a note whose row went and came back.
CREATE TABLE image_text_version (
  last INTEGER NOT NULL
) STRICT;
INSERT INTO image_text_version (last) VALUES (0);

-- Notes whose images changed since their row was written, by rowid.
CREATE TABLE image_text_stale (
  rowid INTEGER PRIMARY KEY
) STRICT;

-- NOT EXISTS, not OR IGNORE: an outer statement's conflict clause overrides a trigger's.
CREATE TRIGGER image_text_file_insert AFTER INSERT ON files
WHEN new.mime LIKE 'image/%' BEGIN
  INSERT INTO image_text_stale (rowid) SELECT n.rowid FROM notes n
   WHERE n.id = new.note_id
     AND NOT EXISTS (SELECT 1 FROM image_text_stale s WHERE s.rowid = n.rowid);
END;

CREATE TRIGGER image_text_file_update AFTER UPDATE OF note_id, mime, data ON files BEGIN
  DELETE FROM file_hashes WHERE file_id = old.id;
  INSERT INTO image_text_stale (rowid) SELECT n.rowid FROM notes n
   WHERE n.id IN (old.note_id, new.note_id)
     AND NOT EXISTS (SELECT 1 FROM image_text_stale s WHERE s.rowid = n.rowid);
END;

CREATE TRIGGER image_text_file_delete AFTER DELETE ON files BEGIN
  DELETE FROM file_hashes WHERE file_id = old.id;
  INSERT INTO image_text_stale (rowid) SELECT n.rowid FROM notes n
   WHERE n.id = old.note_id
     AND NOT EXISTS (SELECT 1 FROM image_text_stale s WHERE s.rowid = n.rowid);
END;

-- The images stored before this version are read once writes are quiet.
INSERT INTO image_text_stale (rowid)
  SELECT DISTINCT n.rowid FROM files f JOIN notes n ON n.id = f.note_id
   WHERE f.mime LIKE 'image/%';
