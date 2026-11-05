-- One row per App Store purchase of Devot Pro, per environment: its one licence. Apple's
-- transaction IDs stay here; no email, name or key is stored. A refund that arrives before any
-- exchange makes a revoked row with no issued_at, so a later exchange is refused.
CREATE TABLE app_store_licences (
  environment TEXT NOT NULL CHECK (environment IN ('Production', 'Sandbox')),
  original_transaction_id TEXT NOT NULL,
  licence_id TEXT NOT NULL UNIQUE,
  transaction_id TEXT,
  purchased_at TEXT,
  issued_at TEXT,
  checked_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (environment, original_transaction_id)
);

-- App Store Server Notifications already acted on, so a replay of one changes nothing after the
-- owner restores a licence by hand.
CREATE TABLE app_store_notifications (
  notification_uuid TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
