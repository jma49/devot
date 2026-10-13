-- Schema v12: indexes for the activity heatmap (src/core/activity.ts). They
-- cover everything it reads, so counting reads only the last year and never
-- a note's or a version's Yjs state (stored before the columns it needs,
-- often in overflow pages).

-- Notes by creation time.
CREATE INDEX notes_created ON notes (created_at, purged_at, id);
-- Revisions by time: the year's versions and title changes (a body
-- version's value marks a baseline, which is not counted).
CREATE INDEX revisions_by_time ON revisions (at, kind, note_id, length, value);
-- A note's versions in order: the one before each version.
CREATE INDEX revisions_activity ON revisions (note_id, kind, at, length);
