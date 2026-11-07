-- Schema v28: pending records page by `upload_key` instead of their ID (docs/adr/0016-store-names-hide-record-ids.md, #639).
-- UUIDv7 IDs sort by creation, so a backlog sent in ID order gave the store each record's creation rank.
-- The key is 16 random hex digits followed by the ID: random, so the order says nothing of when a record was made, and unique, so it is the paging cursor itself.
-- A new epoch draws every key again (SYNC_RESET_SQL), so two backlog uploads do not share an order either.
ALTER TABLE sync_records ADD COLUMN upload_key TEXT NOT NULL DEFAULT '';
UPDATE sync_records SET upload_key = lower(hex(randomblob(8))) || id;

CREATE TRIGGER sync_record_upload_key AFTER INSERT ON sync_records WHEN NEW.upload_key = '' BEGIN
  UPDATE sync_records SET upload_key = lower(hex(randomblob(8))) || NEW.id WHERE id = NEW.id;
END;

DROP INDEX sync_pending;
CREATE INDEX sync_pending ON sync_records (upload_key) WHERE edits <> synced;
