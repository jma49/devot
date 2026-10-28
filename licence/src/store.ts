import { LicenceError } from './errors.ts'

/** The D1 calls the store makes, so tests and the Worker hand it the same database type. */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  batch(statements: SqlStatement[]): Promise<unknown[]>
}

export interface Licence {
  id: string
  sessionId: string
  customerId: string
  issuedAt: string
  revokedAt: string | null
}

export interface PurchaseRecord {
  sessionId: string
  licenceId: string
  paymentIntent: string | null
  customerId: string
  createdAt: string
  /** When Resend accepted the purchase's mail. A claim in flight leaves this null. */
  mailedAt: string | null
  /** When a sender took the mail claim; cleared by releaseMail and sentMail. */
  claimedAt: string | null
  /** A keyed hash of the buyer's lower-cased address, so /resend finds it whatever its capitals. */
  emailHash: string | null
}

export interface Fulfilment {
  sessionId: string
  licenceId: string
  customerId: string
  paymentIntent: string | null
  /** RFC 3339, when the purchase is recorded. */
  at: string
  /** A keyed hash of the buyer's lower-cased address; none when the session has no address. */
  emailHash?: string | null
}

export interface Fulfilled {
  purchase: PurchaseRecord
  licence: Licence
  /** False when the session had already been fulfilled. */
  created: boolean
}

export interface Store {
  licence(id: string): Promise<Licence | null>
  purchase(sessionId: string): Promise<PurchaseRecord | null>
  /** Issues a new licence for a session, once; a second call returns the first. */
  issue(fulfilment: Fulfilment): Promise<Fulfilled>
  /**
   * Takes the purchase's mail claim unless it is mailed or another sender holds a claim newer
   * than `staleBefore`: true when this call holds it. The claim is not a send.
   */
  claimMail(sessionId: string, at: string, staleBefore: string): Promise<boolean>
  /** Marks the mail sent, after Resend accepted it, and drops the claim. */
  sentMail(sessionId: string, at: string): Promise<void>
  /** Drops a claim whose send failed, so a retry can send it. */
  releaseMail(sessionId: string): Promise<void>
  /**
   * Revokes the licence a purchase paid for; null when none or already revoked. Remembers the
   * PaymentIntent either way, so a licence its purchase issues later is issued revoked.
   */
  revokeByPayment(paymentIntent: string, at: string): Promise<string | null>
  licencesOfCustomers(customerIds: string[]): Promise<Licence[]>
  /** Every licence a purchase row with this address hash bought, oldest first. */
  licencesOfEmail(emailHash: string): Promise<Licence[]>
  revokedIds(): Promise<string[]>
  /** Counts a hit on `key` in `window` and returns the window's count so far. */
  hit(key: string, window: number): Promise<number>
}

interface LicenceRow {
  id: string
  session_id: string
  customer_id: string
  issued_at: string
  revoked_at: string | null
}

interface PurchaseRow {
  session_id: string
  licence_id: string
  payment_intent: string | null
  customer_id: string
  created_at: string
  mailed_at: string | null
  claimed_at: string | null
  email_hash: string | null
}

const toLicence = (row: LicenceRow): Licence => ({
  id: row.id,
  sessionId: row.session_id,
  customerId: row.customer_id,
  issuedAt: row.issued_at,
  revokedAt: row.revoked_at,
})

const toPurchase = (row: PurchaseRow): PurchaseRecord => ({
  sessionId: row.session_id,
  licenceId: row.licence_id,
  paymentIntent: row.payment_intent,
  customerId: row.customer_id,
  createdAt: row.created_at,
  mailedAt: row.mailed_at,
  claimedAt: row.claimed_at,
  emailHash: row.email_hash,
})

export function d1Store(db: SqlDatabase): Store {
  const store: Store = {
    async licence(id) {
      const row = await db
        .prepare('SELECT * FROM licences WHERE id = ?')
        .bind(id)
        .first<LicenceRow>()
      return row ? toLicence(row) : null
    },

    async purchase(sessionId) {
      const row = await db
        .prepare('SELECT * FROM purchases WHERE session_id = ?')
        .bind(sessionId)
        .first<PurchaseRow>()
      return row ? toPurchase(row) : null
    },

    async issue(f) {
      // One transaction: the licence row only goes in with the session's purchase row.
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO licences (id, session_id, customer_id, issued_at, revoked_at)
             SELECT ?1, ?2, ?3, ?4,
               (SELECT revoked_at FROM revoked_payments WHERE payment_intent = ?5)
             WHERE NOT EXISTS (SELECT 1 FROM purchases WHERE session_id = ?2)`,
          )
          .bind(f.licenceId, f.sessionId, f.customerId, f.at, f.paymentIntent),
        db
          .prepare(
            `INSERT INTO purchases (session_id, licence_id, payment_intent, customer_id, created_at, email_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (session_id) DO NOTHING`,
          )
          .bind(f.sessionId, f.licenceId, f.paymentIntent, f.customerId, f.at, f.emailHash ?? null),
      ])
      const purchase = await store.purchase(f.sessionId)
      const licence = purchase && (await store.licence(purchase.licenceId))
      if (!purchase || !licence) throw new LicenceError('E_LICENCE_INTERNAL', 'fulfil')
      return { purchase, licence, created: changes(results[1]) > 0 }
    },

    async claimMail(sessionId, at, staleBefore) {
      const result = await db
        .prepare(
          `UPDATE purchases SET claimed_at = ?1
           WHERE session_id = ?2 AND mailed_at IS NULL
             AND (claimed_at IS NULL OR claimed_at < ?3)`,
        )
        .bind(at, sessionId, staleBefore)
        .run()
      return changes(result) > 0
    },

    async sentMail(sessionId, at) {
      await db
        .prepare(
          `UPDATE purchases SET mailed_at = ?1, claimed_at = NULL
           WHERE session_id = ?2 AND mailed_at IS NULL`,
        )
        .bind(at, sessionId)
        .run()
    },

    async releaseMail(sessionId) {
      await db
        .prepare(
          'UPDATE purchases SET claimed_at = NULL WHERE session_id = ?1 AND mailed_at IS NULL',
        )
        .bind(sessionId)
        .run()
    },

    async revokeByPayment(paymentIntent, at) {
      const [, revoked] = await db.batch([
        db
          .prepare(
            `INSERT INTO revoked_payments (payment_intent, revoked_at) VALUES (?1, ?2)
             ON CONFLICT (payment_intent) DO NOTHING`,
          )
          .bind(paymentIntent, at),
        db
          .prepare(
            `UPDATE licences SET revoked_at = ?1
             WHERE revoked_at IS NULL AND id IN (
               SELECT licence_id FROM purchases WHERE payment_intent = ?2)
             RETURNING id`,
          )
          .bind(at, paymentIntent),
      ])
      const rows = (revoked as { results?: { id: string }[] } | undefined)?.results
      return rows?.[0]?.id ?? null
    },

    async licencesOfCustomers(customerIds) {
      if (customerIds.length === 0) return []
      const { results } = await db
        .prepare(
          `SELECT * FROM licences WHERE id IN (
             SELECT licence_id FROM purchases
             WHERE customer_id IN (SELECT value FROM json_each(?)))
           ORDER BY issued_at, id`,
        )
        .bind(JSON.stringify(customerIds))
        .all<LicenceRow>()
      return results.map(toLicence)
    },

    async licencesOfEmail(emailHash) {
      const { results } = await db
        .prepare(
          `SELECT * FROM licences WHERE id IN (
             SELECT licence_id FROM purchases WHERE email_hash = ?)
           ORDER BY issued_at, id`,
        )
        .bind(emailHash)
        .all<LicenceRow>()
      return results.map(toLicence)
    },

    async revokedIds() {
      const { results } = await db
        .prepare('SELECT id FROM licences WHERE revoked_at IS NOT NULL ORDER BY id')
        .all<{ id: string }>()
      return results.map((row) => row.id)
    },

    async hit(key, window) {
      const [, counted] = await db.batch([
        // Only this key's earlier window: hourly and daily counters share the table, and one
        // scale's number is meaningless to the other.
        db.prepare('DELETE FROM rate_limits WHERE key = ?1 AND window < ?2').bind(key, window),
        db
          .prepare(
            `INSERT INTO rate_limits (key, window, count) VALUES (?1, ?2, 1)
             ON CONFLICT (key) DO UPDATE SET
               count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END,
               window = excluded.window
             RETURNING count`,
          )
          .bind(key, window),
      ])
      const rows = (counted as { results?: { count: number }[] } | undefined)?.results
      return rows?.[0]?.count ?? 1
    },
  }

  return store
}

function changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta
  return meta?.changes ?? 0
}
