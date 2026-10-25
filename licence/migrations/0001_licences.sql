-- One row per licence. No email address and no key: Stripe holds the address, and a key is
-- signed again from this row whenever it is shown or mailed.
CREATE TABLE licences (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  updates_until TEXT NOT NULL,
  revoked_at TEXT
);

-- One row per paid Checkout Session, the first purchase and each renewal: a session fulfils once.
CREATE TABLE purchases (
  session_id TEXT PRIMARY KEY,
  licence_id TEXT NOT NULL REFERENCES licences (id),
  kind TEXT NOT NULL CHECK (kind IN ('licence', 'renewal')),
  payment_intent TEXT,
  customer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mailed_at TEXT
);

CREATE INDEX purchases_payment_intent ON purchases (payment_intent);
CREATE INDEX purchases_customer ON purchases (customer_id);

-- /resend's fixed-window counters, keyed by a keyed hash of the address or the IP.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
