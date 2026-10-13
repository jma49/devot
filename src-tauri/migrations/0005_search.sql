-- Schema v5: full-text search over titles and Markdown snapshots.
-- The trigram tokenizer matches substrings in any script (Chinese has no
-- spaces between words). Triggers keep the index in step with `notes`, so
-- every write path (edit, trash, restore, purge, sync) updates it.

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  body_md,
  content = 'notes',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
END;

CREATE TRIGGER notes_fts_update AFTER UPDATE OF title, body_md ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
  INSERT INTO notes_fts (rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;

-- Index the notes written before this version.
INSERT INTO notes_fts (notes_fts) VALUES ('rebuild');
