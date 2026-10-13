-- Schema v16: a note's body has a version, which storage moves on by one
-- with each write of the note. A write carries the version of the body its
-- writer last saw and is taken only while the stored body is still at it,
-- so a body another process wrote since is never written over: the write
-- is refused, and its writer takes that body in and writes again. Bodies
-- from before are at version 0.

ALTER TABLE notes ADD COLUMN body_version INTEGER NOT NULL DEFAULT 0;
