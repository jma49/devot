-- Schema v31: the plugin drawings each note keeps (docs/adr/0030-plugin-drawings-sync-with-the-note.md).
-- `drawings` is the list as JSON and `hlc` the clock of its last change; an emptied list keeps its row, so the
-- clock still orders it against another device's. The list syncs in the note's record, so a write here marks
-- the note pending as a write of its tags does. A purge deletes the row.
CREATE TABLE note_drawings (
  note_id  TEXT PRIMARY KEY REFERENCES notes (id),
  drawings TEXT NOT NULL,
  hlc      TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TRIGGER sync_note_drawings_insert AFTER INSERT ON note_drawings BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.note_id, 'note')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
CREATE TRIGGER sync_note_drawings_update AFTER UPDATE ON note_drawings BEGIN
  INSERT INTO sync_records (id, kind) VALUES (NEW.note_id, 'note')
    ON CONFLICT (id) DO UPDATE SET edits = edits + 1;
END;
