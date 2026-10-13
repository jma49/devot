-- Schema v6: attachments. A file belongs to the note it was added to and
-- stays while that note is in the trash; purging the note deletes it. The
-- bytes live here, so backups of the database include them.

CREATE TABLE files (
  id         TEXT    PRIMARY KEY NOT NULL, -- UUIDv7
  note_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  mime       TEXT    NOT NULL,             -- detected from the bytes, not trusted from the UI
  size       INTEGER NOT NULL,
  data       BLOB    NOT NULL,
  created_at INTEGER NOT NULL              -- Unix ms
) STRICT;

CREATE INDEX files_by_note ON files (note_id);
