-- Schema v4: permanent deletion. Emptying the trash cannot drop rows, or
-- sync would bring the notes back from other devices. A purged note keeps
-- only its ID and clocks: its content is wiped and `purged_at` is set. A
-- purge is final; no later write restores the note.

ALTER TABLE notes ADD COLUMN purged_at INTEGER;

CREATE INDEX notes_trash ON notes (deleted_at DESC) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
