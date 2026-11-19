CREATE TABLE search_postings_pending (rowid INTEGER PRIMARY KEY) STRICT;

-- Existing v32 rows may already have deleted postings.
INSERT INTO search_postings_pending (rowid) SELECT rowid FROM notes;

CREATE TRIGGER search_postings_pending_insert AFTER INSERT ON search_stale BEGIN
  INSERT INTO search_postings_pending (rowid)
    SELECT new.rowid FROM notes_fts_docsize
     WHERE id = new.rowid AND sz IS NOT x'0000'
       AND NOT EXISTS (SELECT 1 FROM search_postings_pending WHERE rowid = new.rowid);
END;
