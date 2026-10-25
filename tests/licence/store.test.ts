import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { d1Store, type Fulfilment, type SqlDatabase, type Store } from '../../licence/src/store'
import { d1Database } from './support'

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
  today: '2026-10-24',
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

it('issues a licence once per session, with updates for a year', async () => {
  const first = purchase()
  const issued = await store.issue(first)
  expect(issued.created).toBe(true)
  expect(issued.licence).toEqual({
    id: first.licenceId,
    sessionId: first.sessionId,
    customerId: 'cus_1',
    issuedAt: '2026-10-24T09:30:00Z',
    updatesUntil: '2027-10-24',
    revokedAt: null,
  })
  expect(issued.purchase).toMatchObject({ kind: 'licence', paymentIntent: first.paymentIntent })
  const again = await store.issue({ ...first, licenceId: id(), at: '2026-10-24T10:00:00Z' })
  expect(again.created).toBe(false)
  expect(again.licence).toEqual(issued.licence)
  const { results } = await db.prepare('SELECT id FROM licences').all()
  expect(results).toHaveLength(1)
})

it('counts a year from 29 February as 1 March', async () => {
  const issued = await store.issue(purchase({ today: '2028-02-29' }))
  expect(issued.licence.updatesUntil).toBe('2029-03-01')
})

it('renews from the later of today and the old date, keeping the ID, once per session', async () => {
  const { licence } = await store.issue(purchase())
  const early = purchase({ licenceId: licence.id, customerId: 'cus_2', today: '2027-03-01' })
  const renewed = await store.renew(early)
  expect(renewed?.created).toBe(true)
  expect(renewed?.licence).toMatchObject({ id: licence.id, updatesUntil: '2028-10-24' })
  expect(renewed?.purchase).toMatchObject({ kind: 'renewal', customerId: 'cus_2' })
  expect((await store.renew(early))?.created).toBe(false)
  expect((await store.licence(licence.id))?.updatesUntil).toBe('2028-10-24')
  const late = await store.renew(purchase({ licenceId: licence.id, today: '2030-01-15' }))
  expect(late?.licence.updatesUntil).toBe('2031-01-15')
  expect(late?.licence.issuedAt).toBe(licence.issuedAt)
})

it('records but does not extend a renewal of a revoked licence, and refuses an unknown one', async () => {
  const bought = purchase()
  const { licence } = await store.issue(bought)
  await store.revokeByPayment(bought.paymentIntent ?? '', '2026-11-01T00:00:00Z')
  const renewed = await store.renew(purchase({ licenceId: licence.id }))
  expect(renewed?.created).toBe(true)
  expect(renewed?.licence).toMatchObject({
    updatesUntil: '2027-10-24',
    revokedAt: '2026-11-01T00:00:00Z',
  })
  expect(await store.renew(purchase({ licenceId: id() }))).toBeNull()
})

it('revokes through the first purchase, not through a renewal', async () => {
  const bought = purchase()
  const { licence } = await store.issue(bought)
  const renewal = purchase({ licenceId: licence.id })
  await store.renew(renewal)
  expect(
    await store.revokeByPayment(renewal.paymentIntent ?? '', '2026-11-01T00:00:00Z'),
  ).toBeNull()
  expect(await store.revokeByPayment('pi_unknown', '2026-11-01T00:00:00Z')).toBeNull()
  expect(await store.revokedIds()).toEqual([])
  expect(await store.revokeByPayment(bought.paymentIntent ?? '', '2026-11-01T00:00:00Z')).toBe(
    licence.id,
  )
  expect(await store.revokeByPayment(bought.paymentIntent ?? '', '2026-11-02T00:00:00Z')).toBeNull()
  expect(await store.revokedIds()).toEqual([licence.id])
  expect((await store.licence(licence.id))?.revokedAt).toBe('2026-11-01T00:00:00Z')
})

it('finds licences through any of their purchases customers', async () => {
  const a = (await store.issue(purchase({ customerId: 'cus_a', at: '2026-01-01T00:00:00Z' })))
    .licence
  const b = (await store.issue(purchase({ customerId: 'cus_b', at: '2026-02-01T00:00:00Z' })))
    .licence
  await store.renew(purchase({ licenceId: a.id, customerId: 'cus_b' }))
  await store.issue(purchase({ customerId: 'cus_c' }))
  const found = await store.licencesOfCustomers(['cus_b'])
  expect(found.map((l) => l.id)).toEqual([a.id, b.id])
  expect(await store.licencesOfCustomers([])).toEqual([])
})

it('marks a purchase mailed once', async () => {
  const bought = purchase()
  await store.issue(bought)
  expect((await store.purchase(bought.sessionId))?.mailedAt).toBeNull()
  await store.markMailed(bought.sessionId, '2026-10-24T09:31:00Z')
  await store.markMailed(bought.sessionId, '2026-10-24T09:32:00Z')
  expect((await store.purchase(bought.sessionId))?.mailedAt).toBe('2026-10-24T09:31:00Z')
  expect(await store.purchase('cs_none')).toBeNull()
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
