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
  updatesUntil: string
  revokedAt: string | null
}

export interface PurchaseRecord {
  sessionId: string
  licenceId: string
  kind: 'licence' | 'renewal'
  paymentIntent: string | null
  customerId: string
  createdAt: string
  mailedAt: string | null
}

export interface Fulfilment {
  sessionId: string
  licenceId: string
  customerId: string
  paymentIntent: string | null
  /** RFC 3339, when the purchase is recorded. */
  at: string
  /** The UTC date `updatesUntil` counts a year from. */
  today: string
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
   * Extends a licence by a year from the later of `today` and its `updatesUntil`, once per session;
   * a revoked licence is recorded but not extended. Null for an unknown licence.
   */
  renew(fulfilment: Fulfilment): Promise<Fulfilled | null>
  markMailed(sessionId: string, at: string): Promise<void>
  /** Revokes the licence a first purchase paid for; null when none or already revoked. */
  revokeByPayment(paymentIntent: string, at: string): Promise<string | null>
  licencesOfCustomers(customerIds: string[]): Promise<Licence[]>
  revokedIds(): Promise<string[]>
  /** Counts a hit on `key` in `window` and returns the window's count so far. */
  hit(key: string, window: number): Promise<number>
}

interface LicenceRow {
  id: string
  session_id: string
  customer_id: string
  issued_at: string
  updates_until: string
  revoked_at: string | null
}

interface PurchaseRow {
  session_id: string
  licence_id: string
  kind: 'licence' | 'renewal'
  payment_intent: string | null
  customer_id: string
  created_at: string
  mailed_at: string | null
}

const toLicence = (row: LicenceRow): Licence => ({
  id: row.id,
  sessionId: row.session_id,
  customerId: row.customer_id,
  issuedAt: row.issued_at,
  updatesUntil: row.updates_until,
  revokedAt: row.revoked_at,
})

const toPurchase = (row: PurchaseRow): PurchaseRecord => ({
  sessionId: row.session_id,
  licenceId: row.licence_id,
  kind: row.kind,
  paymentIntent: row.payment_intent,
  customerId: row.customer_id,
  createdAt: row.created_at,
  mailedAt: row.mailed_at,
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
            `INSERT INTO licences (id, session_id, customer_id, issued_at, updates_until)
             SELECT ?1, ?2, ?3, ?4, date(?5, '+1 year')
             WHERE NOT EXISTS (SELECT 1 FROM purchases WHERE session_id = ?2)`,
          )
          .bind(f.licenceId, f.sessionId, f.customerId, f.at, f.today),
        db
          .prepare(
            `INSERT INTO purchases (session_id, licence_id, kind, payment_intent, customer_id, created_at)
             VALUES (?1, ?2, 'licence', ?3, ?4, ?5) ON CONFLICT (session_id) DO NOTHING`,
          )
          .bind(f.sessionId, f.licenceId, f.paymentIntent, f.customerId, f.at),
      ])
      return fulfilled(f.sessionId, results[1])
    },

    async renew(f) {
      if (!(await store.licence(f.licenceId))) return null
      const results = await db.batch([
        db
          .prepare(
            `UPDATE licences SET updates_until = date(max(?1, updates_until), '+1 year')
             WHERE id = ?2 AND revoked_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM purchases WHERE session_id = ?3)`,
          )
          .bind(f.today, f.licenceId, f.sessionId),
        db
          .prepare(
            `INSERT INTO purchases (session_id, licence_id, kind, payment_intent, customer_id, created_at)
             VALUES (?1, ?2, 'renewal', ?3, ?4, ?5) ON CONFLICT (session_id) DO NOTHING`,
          )
          .bind(f.sessionId, f.licenceId, f.paymentIntent, f.customerId, f.at),
      ])
      return fulfilled(f.sessionId, results[1])
    },

    async markMailed(sessionId, at) {
      await db
        .prepare('UPDATE purchases SET mailed_at = ? WHERE session_id = ? AND mailed_at IS NULL')
        .bind(at, sessionId)
        .run()
    },

    async revokeByPayment(paymentIntent, at) {
      const row = await db
        .prepare(
          `UPDATE licences SET revoked_at = ?1
           WHERE revoked_at IS NULL AND id IN (
             SELECT licence_id FROM purchases WHERE payment_intent = ?2 AND kind = 'licence')
           RETURNING id`,
        )
        .bind(at, paymentIntent)
        .first<{ id: string }>()
      return row?.id ?? null
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

    async revokedIds() {
      const { results } = await db
        .prepare('SELECT id FROM licences WHERE revoked_at IS NOT NULL ORDER BY id')
        .all<{ id: string }>()
      return results.map((row) => row.id)
    },

    async hit(key, window) {
      const [, counted] = await db.batch([
        db.prepare('DELETE FROM rate_limits WHERE window < ?').bind(window - 1),
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

  async function fulfilled(sessionId: string, purchaseInsert: unknown): Promise<Fulfilled> {
    const purchase = await store.purchase(sessionId)
    const licence = purchase && (await store.licence(purchase.licenceId))
    if (!purchase || !licence) throw new LicenceError('E_LICENCE_INTERNAL', 'fulfil')
    return { purchase, licence, created: changes(purchaseInsert) > 0 }
  }

  return store
}

function changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta
  return meta?.changes ?? 0
}
