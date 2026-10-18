-- Schema v18: an optional notebook icon and icon colour. `icon` holds an SF
-- Symbol name from the notebook icon catalog (design/icons/notebook-symbols.json),
-- never artwork; `icon_color` a palette ID from TAG_COLORS (see
-- src/core/storage.ts and storage/mod.rs), so each theme decides how it looks.
-- NULL means the default notebook icon and no colour. Both are picked and
-- reverted together, so they share one HLC; synced like every other field:
-- the newer HLC wins. No CHECK on either, so a later catalog or palette can
-- grow without rebuilding the table; readers treat a value they do not know
-- as unset.

ALTER TABLE books ADD COLUMN icon TEXT;
ALTER TABLE books ADD COLUMN icon_color TEXT;
ALTER TABLE books ADD COLUMN icon_hlc TEXT NOT NULL DEFAULT '';
