-- One row per device a licence is activated on: its seats. No hardware identifier is stored: the
-- app makes a random device ID, keeps it in the keychain and sends it, with a label the buyer can
-- recognise and the time it was last seen. A licence has as many seats as MAX_DEVICES.
CREATE TABLE activations (
  licence_id TEXT NOT NULL,
  device TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (licence_id, device)
);

CREATE INDEX activations_licence ON activations (licence_id);
