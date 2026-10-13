-- Schema v11: an optional tag colour. `color` holds a palette ID (see
-- TAG_COLORS in src/core/storage.ts and storage/mod.rs), never a colour
-- value, so each theme decides how it looks; NULL means no colour. Synced
-- like every other field: the newer HLC wins. There is no CHECK on the ID,
-- so a later palette can grow without rebuilding the table; readers treat
-- an ID they do not know as no colour.

ALTER TABLE tags ADD COLUMN color TEXT;
ALTER TABLE tags ADD COLUMN color_hlc TEXT NOT NULL DEFAULT '';
