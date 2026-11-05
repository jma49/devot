-- Schema v27: a library that pushed a record but never pulled past the start has synced too
-- (the restore choice, ADR 0013); v26 counted only a stored relay cursor past the start.
INSERT INTO sync_state (key, value)
  SELECT 'hasSynced', '1'
  WHERE EXISTS (SELECT 1 FROM sync_records WHERE version > 0)
  ON CONFLICT (key) DO NOTHING;
