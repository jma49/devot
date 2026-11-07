-- Schema v29: a save no longer re-indexes the note for search, which tokenized
-- its whole old and new text inside the save (seconds for a note of a few MB).
-- The triggers only mark the note stale, keeping the text the index holds for
-- it (NULL when it holds none): FTS5 takes a row of external content out of
-- the index only given the text it was indexed with. The store re-indexes
-- stale notes later (storage/search.rs, CATCH_UP_SQL): once writes are quiet,
-- and before a search or a purge reads the index. The index itself is kept as
-- it is, so an upgrade re-indexes nothing.

CREATE TABLE IF NOT EXISTS search_stale (
  rowid   INTEGER PRIMARY KEY, -- the note's rowid, as the index keys it
  title   TEXT,
  body_md TEXT
) STRICT;

DROP TRIGGER IF EXISTS notes_fts_insert;
CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO search_stale (rowid) SELECT new.rowid
   WHERE NOT EXISTS (SELECT 1 FROM search_stale WHERE rowid = new.rowid);
END;

-- Only the first change since the note was indexed records its text: later
-- ones leave the text the index still holds. NOT EXISTS, not OR IGNORE: an
-- upsert's own conflict clause overrides a trigger's.
DROP TRIGGER IF EXISTS notes_fts_update;
CREATE TRIGGER notes_fts_update AFTER UPDATE OF title, body_md ON notes
WHEN old.title IS NOT new.title OR old.body_md IS NOT new.body_md BEGIN
  INSERT INTO search_stale (rowid, title, body_md)
    SELECT old.rowid, old.title, old.body_md
     WHERE NOT EXISTS (SELECT 1 FROM search_stale WHERE rowid = old.rowid);
END;

DROP TRIGGER IF EXISTS notes_fts_delete;
CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body_md)
    SELECT 'delete', old.rowid, old.title, old.body_md
     WHERE NOT EXISTS (SELECT 1 FROM search_stale WHERE rowid = old.rowid)
    UNION ALL
    SELECT 'delete', rowid, title, body_md FROM search_stale
     WHERE rowid = old.rowid AND title IS NOT NULL;
  DELETE FROM search_stale WHERE rowid = old.rowid;
END;
