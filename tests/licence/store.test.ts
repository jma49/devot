import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { d1Store, type Fulfilment, type SqlDatabase, type Store } from '../../licence/src/store'
import { d1Database, migrate } from './support'

// The store on a real D1 database (SQLite in workerd through Miniflare).

let db: SqlDatabase
let close: () => Promise<void>
let store: Store
let n = 0

beforeAll(async () => {
  ;({ db, close } = await d1Database())
})
afterAll(() => close())
beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM purchases'),
    db.prepare('DELETE FROM licences'),
    db.prepare('DELETE FROM rate_limits'),
    db.prepare('DELETE FROM revoked_payments'),
  ])
  store = d1Store(db)
})

const id = () => `L${String(++n).padStart(21, '0')}`
const purchase = (over: Partial<Fulfilment> = {}): Fulfilment => ({
  sessionId: `cs_${++n}`,
  licenceId: id(),
  customerId: 'cus_1',
  paymentIntent: `pi_${++n}`,
  at: '2026-10-24T09:30:00Z',
  ...over,
})

it('keeps no email address or key', async () => {
  const { results } = await db
    .prepare(
      "SELECT name FROM pragma_table_info('licences') UNION ALL SELECT name FROM pragma_table_info('purchases')",
    )
    .all<{ name: string }>()
  expect(
    results.map((r) => r.name).filter((name) => /mail(?!ed_at)|key|licensee/.test(name)),
  ).toEqual([])
})

it('issues a licence once per session', async () => {
  const first = purchase()
  const issued = await store.issue(first)
  expect(issued.created).toBe(true)
  expect(issued.licence).toEqual({
    id: first.licenceId,
    sessionId: first.sessionId,
    customerId: 'cus_1',
    issuedAt: '2026-10-24T09:30:00Z',
    revokedAt: null,
  })
  expect(issued.purchase).toEqual({
    sessionId: first.sessionId,
    licenceId: first.licenceId,
    paymentIntent: first.paymentIntent,
    customerId: 'cus_1',
    createdAt: '2026-10-24T09:30:00Z',
    mailedAt: null,
  })
  const again = await store.issue({ ...first, licenceId: id(), at: '2026-10-24T10:00:00Z' })
  expect(again.created).toBe(false)
  expect(again.licence).toEqual(issued.licence)
  const { results } = await db.prepare('SELECT id FROM licences').all()
  expect(results).toHaveLength(1)
})

it('revokes the licence its purchase paid for, once', async () => {
  const bought = purchase()
  const { licence } = await store.issue(bought)
  await store.issue(purchase())
  expect(await store.revokeByPayment('pi_unknown', '2026-11-01T00:00:00Z')).toBeNull()
  expect(await store.revokedIds()).toEqual([])
  expect(await store.revokeByPayment(bought.paymentIntent ?? '', '2026-11-01T00:00:00Z')).toBe(
    licence.id,
  )
  expect(await store.revokeByPayment(bought.paymentIntent ?? '', '2026-11-02T00:00:00Z')).toBeNull()
  expect(await store.revokedIds()).toEqual([licence.id])
  expect((await store.licence(licence.id))?.revokedAt).toBe('2026-11-01T00:00:00Z')
})

it('finds the licences of the customers asked for, oldest first', async () => {
  const b = (await store.issue(purchase({ customerId: 'cus_b', at: '2026-02-01T00:00:00Z' })))
    .licence
  const a = (await store.issue(purchase({ customerId: 'cus_a', at: '2026-01-01T00:00:00Z' })))
    .licence
  await store.issue(purchase({ customerId: 'cus_c' }))
  const found = await store.licencesOfCustomers(['cus_b', 'cus_a'])
  expect(found.map((l) => l.id)).toEqual([a.id, b.id])
  expect(await store.licencesOfCustomers([])).toEqual([])
})

it("claims a purchase's mail once, until the claim is released", async () => {
  const bought = purchase()
  await store.issue(bought)
  expect((await store.purchase(bought.sessionId))?.mailedAt).toBeNull()
  expect(await store.claimMail(bought.sessionId, '2026-10-24T09:31:00Z')).toBe(true)
  expect(await store.claimMail(bought.sessionId, '2026-10-24T09:32:00Z')).toBe(false)
  expect((await store.purchase(bought.sessionId))?.mailedAt).toBe('2026-10-24T09:31:00Z')
  await store.releaseMail(bought.sessionId)
  expect((await store.purchase(bought.sessionId))?.mailedAt).toBeNull()
  expect(await store.claimMail(bought.sessionId, '2026-10-24T09:33:00Z')).toBe(true)
  expect(await store.claimMail('cs_none', '2026-10-24T09:33:00Z')).toBe(false)
  expect(await store.purchase('cs_none')).toBeNull()
})

it('issues a licence revoked when its payment was refunded before the purchase was recorded', async () => {
  const early = purchase()
  expect(await store.revokeByPayment(early.paymentIntent ?? '', '2026-10-24T09:29:00Z')).toBeNull()
  const { licence } = await store.issue(early)
  expect(licence.revokedAt).toBe('2026-10-24T09:29:00Z')
  expect(await store.revokedIds()).toEqual([licence.id])
  const other = await store.issue(purchase())
  expect(other.licence.revokedAt).toBeNull()
  const unpaid = await store.issue(purchase({ paymentIntent: null }))
  expect(unpaid.licence.revokedAt).toBeNull()
})

const columns = async (database: SqlDatabase, table: string) =>
  (
    await database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()
  ).results.map((r) => r.name)

it('has the columns the store reads and writes, and none for an update window', async () => {
  expect(await columns(db, 'licences')).toEqual([
    'id',
    'session_id',
    'customer_id',
    'issued_at',
    'revoked_at',
  ])
  expect(await columns(db, 'purchases')).toEqual([
    'session_id',
    'licence_id',
    'payment_intent',
    'customer_id',
    'created_at',
    'mailed_at',
  ])
})

it('migrates a database made by the first migration, keeping its rows', async () => {
  const first = await d1Database('0001_licences.sql')
  try {
    await first.db.batch([
      first.db.prepare(
        `INSERT INTO licences (id, session_id, customer_id, issued_at, updates_until, revoked_at)
         VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'cs_old', 'cus_old', '2026-10-24T09:30:00Z', '2027-10-24', NULL)`,
      ),
      first.db.prepare(
        `INSERT INTO purchases (session_id, licence_id, kind, payment_intent, customer_id, created_at)
         VALUES ('cs_old', 'AAAAAAAAAAAAAAAAAAAAAA', 'licence', 'pi_old', 'cus_old', '2026-10-24T09:30:00Z')`,
      ),
    ])
    await migrate(first.db, (file) => file > '0001_licences.sql')
    const migrated = d1Store(first.db)
    expect(await migrated.licence('AAAAAAAAAAAAAAAAAAAAAA')).toMatchObject({
      customerId: 'cus_old',
    })
    expect(await migrated.revokeByPayment('pi_old', '2026-11-01T00:00:00Z')).toBe(
      'AAAAAAAAAAAAAAAAAAAAAA',
    )
    expect(await columns(first.db, 'licences')).toEqual(await columns(db, 'licences'))
    expect(await columns(first.db, 'purchases')).toEqual(await columns(db, 'purchases'))
  } finally {
    await first.close()
  }
})

it('counts hits per key and window and forgets old windows', async () => {
  expect(await store.hit('ip:a', 10)).toBe(1)
  expect(await store.hit('ip:a', 10)).toBe(2)
  expect(await store.hit('ip:b', 10)).toBe(1)
  expect(await store.hit('ip:a', 11)).toBe(1)
  await store.hit('ip:c', 13)
  const { results } = await db.prepare('SELECT key FROM rate_limits ORDER BY key').all()
  expect(results).toEqual([{ key: 'ip:c' }])
})
