-- Schema v26: the sync seam for a second transport (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md).
-- Each record keeps the transport's change tag beside its version, opaque and
-- '' on a relay. The pull cursor becomes opaque, so "this library has synced"
-- (ADR 0013, the restore choice) is a key of its own: a library whose stored
-- relay cursor is past the start has synced.
ALTER TABLE sync_records ADD COLUMN tag TEXT NOT NULL DEFAULT '';
INSERT INTO sync_state (key, value)
  SELECT 'hasSynced', '1' FROM sync_state
  WHERE key = 'since' AND value GLOB '[1-9]*' AND value NOT GLOB '*[^0-9]*'
  ON CONFLICT (key) DO NOTHING;
