-- Rowid deletion avoids tokenizing the old text during catch-up.
DROP TRIGGER notes_fts_insert;
DROP TRIGGER notes_fts_update;
DROP TRIGGER notes_fts_delete;
DROP TABLE notes_fts;
DROP TABLE search_stale;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body_md, content='', contentless_delete=1, tokenize='trigram'
);
INSERT INTO notes_fts (rowid, title, body_md) SELECT rowid, title, body_md FROM notes;

CREATE TABLE search_stale (rowid INTEGER PRIMARY KEY) STRICT;

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO search_stale (rowid) SELECT new.rowid
   WHERE NOT EXISTS (SELECT 1 FROM search_stale WHERE rowid = new.rowid);
END;

CREATE TRIGGER notes_fts_update AFTER UPDATE OF title, body_md ON notes
WHEN old.title IS NOT new.title OR old.body_md IS NOT new.body_md BEGIN
  INSERT INTO search_stale (rowid) SELECT new.rowid
   WHERE NOT EXISTS (SELECT 1 FROM search_stale WHERE rowid = new.rowid);
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE rowid = old.rowid;
  DELETE FROM search_stale WHERE rowid = old.rowid;
END;
