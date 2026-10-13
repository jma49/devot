-- Schema v10: the user's order of notebooks. Each notebook has a sort key, a
-- fractional index (src/core/order.ts): siblings show in key order (plain
-- string comparison), equal keys in ID order, and moving a notebook rewrites
-- only its own key. Synced like every other field: the newer HLC wins.
--
-- Existing notebooks start without a key. Until they get one they show as
-- before, by name in the locale's collation (which SQL does not have); the
-- core keys them in that order when it starts (BookService.settleOrder),
-- with no key clock, so any later move wins.

ALTER TABLE books ADD COLUMN sort_key TEXT NOT NULL DEFAULT '';
ALTER TABLE books ADD COLUMN sort_key_hlc TEXT NOT NULL DEFAULT '';
