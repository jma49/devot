-- Schema v17: a note's created and updated dates can be set by hand. They
-- share one HLC: a write whose dates HLC is newer than the stored one sets
-- both dates as written; any other write keeps the creation date and moves
-- the update date only forward, as before. Notes from before have none ('').

ALTER TABLE notes ADD COLUMN dates_hlc TEXT NOT NULL DEFAULT '';
