-- Schema v3: note status, pinning and tags. Each field and each tag
-- membership carries the HLC of its last write; storage keeps the newer one.

ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'none'
  CHECK (status IN ('none', 'active', 'on_hold', 'completed', 'dropped'));
ALTER TABLE notes ADD COLUMN status_hlc TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
ALTER TABLE notes ADD COLUMN pinned_hlc TEXT NOT NULL DEFAULT '';

CREATE TABLE tags (
  id          TEXT    PRIMARY KEY NOT NULL, -- UUIDv7
  name        TEXT    NOT NULL,
  name_hlc    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,             -- Unix ms
  updated_at  INTEGER NOT NULL,             -- Unix ms
  deleted_at  INTEGER,                      -- Unix ms; NULL unless deleted
  deleted_hlc TEXT
) STRICT;

-- One row per note and tag ever paired. `present` says whether the tag is on
-- the note now; adding and removing are writes to the same row, so the
-- newer one wins. No foreign keys: sync may deliver rows in any order.
CREATE TABLE note_tags (
  note_id TEXT    NOT NULL,
  tag_id  TEXT    NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  hlc     TEXT    NOT NULL,
  PRIMARY KEY (note_id, tag_id)
) STRICT;

CREATE INDEX note_tags_by_tag ON note_tags (tag_id) WHERE present = 1;
