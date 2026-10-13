-- Schema v8: the per-notebook "Allow AI Access" switch, off by default.
-- devot-mcp (and every later AI feature) sees only the live notes of
-- notebooks with the switch on; a sub-notebook needs its own switch.
-- Synced like every other field: the newer HLC wins.

ALTER TABLE books ADD COLUMN ai_access INTEGER NOT NULL DEFAULT 0 CHECK (ai_access IN (0, 1));
ALTER TABLE books ADD COLUMN ai_access_hlc TEXT NOT NULL DEFAULT '';
