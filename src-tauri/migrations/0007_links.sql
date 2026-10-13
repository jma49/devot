-- Schema v7: the link index. For every note, the notes its Markdown links
-- to: each `devot://note/<UUIDv7>` in the body (src/core/links.ts, noteLinks).
-- Writers replace a note's rows whenever they store its body, and purging a
-- note removes them. Targets may be missing, trashed or purged.

CREATE TABLE links (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id)
) WITHOUT ROWID;

CREATE INDEX links_target ON links (target_id);

-- Index the notes written before this version, with the same rule.
WITH RECURSIVE hits (source_id, rest) AS (
  SELECT id, substr(body_md, instr(body_md, 'devot://note/') + 13)
    FROM notes
   WHERE purged_at IS NULL AND instr(body_md, 'devot://note/') > 0
  UNION ALL
  SELECT source_id, substr(rest, instr(rest, 'devot://note/') + 13)
    FROM hits
   WHERE instr(rest, 'devot://note/') > 0
)
INSERT OR IGNORE INTO links (source_id, target_id)
SELECT source_id, substr(rest, 1, 36)
  FROM hits
 WHERE substr(rest, 1, 36) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
   AND substr(rest, 37, 1) NOT GLOB '[0-9a-f-]';
