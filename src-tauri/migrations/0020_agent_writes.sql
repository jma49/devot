-- Schema v20: the agent writes each note holds (docs/adr/0007-authorship-by-yjs-item-ids.md), for
-- the list's mark and the sidebar's Agents section. The core derives a note's rows from the
-- authorship records in its Yjs document and storage writes them with the note, as it does
-- `body_md`. Never synced and never the source of truth: a missing row is derived again on the
-- note's next write. `seen` is this device's alone; a row starts unseen, an `aiEdit` one seen.
CREATE TABLE agent_writes (
  note_id  TEXT NOT NULL,
  write_id TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('mcp', 'http', 'aiEdit')),
  name     TEXT NOT NULL,
  at       INTEGER NOT NULL,
  created  INTEGER NOT NULL CHECK (created IN (0, 1)),
  seen     INTEGER NOT NULL CHECK (seen IN (0, 1)),
  PRIMARY KEY (note_id, write_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX agent_writes_newest ON agent_writes (at DESC, note_id, write_id);
