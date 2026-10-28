-- Schema v21: the unseen agent writes, which the list reads whole on every save. The newest-`limit`
-- half is served by agent_writes_newest; without this index the unseen half scans every row.
CREATE INDEX agent_writes_unseen ON agent_writes (at DESC, note_id, write_id) WHERE seen = 0;
