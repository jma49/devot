-- Schema v15: writing a note rewrites its text in the search index only when
-- its title or its Markdown changed. Every write of a note sets both columns
-- (storage writes whole records), so the trigger of schema v5 took the
-- note's whole text out of the index and put it back for a notebook,
-- status, pin or Trash change too.

DROP TRIGGER notes_fts_update;
CREATE TRIGGER notes_fts_update AFTER UPDATE OF title, body_md ON notes
WHEN old.title IS NOT new.title OR old.body_md IS NOT new.body_md BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
  INSERT INTO notes_fts (rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
