-- A sender claims the purchase's mail before calling Resend; mailed_at is set only after Resend
-- accepts it, and a claim older than the lease can be taken again. A claim is not a send.
ALTER TABLE purchases ADD COLUMN claimed_at TEXT;

-- A keyed hash of the buyer's lower-cased address, so /resend finds a purchase whatever capitals
-- Stripe stored or the buyer types. No address is stored.
ALTER TABLE purchases ADD COLUMN email_hash TEXT;

CREATE INDEX purchases_email_hash ON purchases (email_hash);
