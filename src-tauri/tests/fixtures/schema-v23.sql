-- How schema-v23.sqlite was made (v1.1.0): schema-v19.sqlite, then migrations 0020-0023 as
-- released, each with its user_version, then this: a synced device with records of every kind,
-- a purged attachment's tombstone, an attachment passed on with its clock and an agent write.
BEGIN;
UPDATE files SET note_hlc = '0000001790000000040-0000-fixture'
  WHERE id = '0192a6f0-0000-7000-8000-00000000f001';
INSERT INTO agent_writes (note_id, write_id, kind, name, at, created, seen)
  VALUES ('0192a6f0-0000-7000-8000-000000000002', 'w1', 'mcp', 'Fixture agent', 1790000000041, 0, 0);
INSERT INTO sync_records (id, kind, version, fingerprint, edits, synced)
  VALUES ('0192a6f0-0000-7000-8000-00000000f002', 'file', 9, 'purged', 1, 1);
UPDATE sync_records SET version = 5, fingerprint = 'launch', body_hlc = '0000001790000000010-0000-fixture',
  body_fp = 'launch-body', synced = edits WHERE id = '0192a6f0-0000-7000-8000-000000000001';
UPDATE sync_records SET version = 6, fingerprint = 'work', synced = edits
  WHERE id = '0192a6f0-0000-7000-8000-00000000b001';
UPDATE sync_records SET version = 7, fingerprint = 'q4', synced = edits
  WHERE id = '0192a6f0-0000-7000-8000-00000000c001';
UPDATE sync_records SET version = 8, fingerprint = 'board', synced = edits
  WHERE id = '0192a6f0-0000-7000-8000-00000000f001';
INSERT INTO sync_state (key, value) VALUES ('since', '42'), ('epoch', 'fixture-epoch'), ('lastSync', '1790000000050')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
COMMIT;
