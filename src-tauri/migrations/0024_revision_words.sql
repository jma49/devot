-- Schema v24: a body version's word count (countWords in src/core/words.ts),
-- for the phone's Activity screen. NULL for a version taken before this
-- schema and for an event: its count is unknown, not zero. The indexes that
-- keep activity reads away from Yjs states (see v12, v13) now cover it.
ALTER TABLE revisions ADD COLUMN words INTEGER;
DROP INDEX revisions_by_time;
CREATE INDEX revisions_by_time ON revisions (at, kind, note_id, length, value, words);
DROP INDEX revisions_activity;
CREATE INDEX revisions_activity ON revisions (note_id, kind, at, length, words);
DROP INDEX revisions_history;
CREATE INDEX revisions_history ON revisions (note_id, at, id, kind, length, value, words);
