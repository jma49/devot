import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { sqliteSql } from '../../relay/src/node/sqlite'
import { PairingRelay } from '../../relay/src/pairing'
import { PAIRING, toBase64Url } from '../../src/core/sync/protocol'

// The pairing logic with a clock the test moves: expiry, which the wire suite cannot wait for.

const open: Database.Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

function pairingsAt(start: number) {
  const db = new Database(':memory:')
  open.push(db)
  const clock = { now: start }
  const relay = new PairingRelay(sqliteSql(db), () => clock.now)
  return { relay, clock, db }
}

const VAULT = 'vault-0123456789ab'
const ID = 'AAAAAAAAAAAAAAAAAAAAAA'
const offer = toBase64Url(new Uint8Array(86).fill(3))
const proof = toBase64Url(new Uint8Array(40).fill(4))

it('refuses a take once the code expired, and forgets the pairing after its grace', () => {
  const { relay, clock, db } = pairingsAt(1_000)
  expect(relay.handle('pair', ID, { vault: VAULT, offer }, 'dev').status).toBe(200)
  expect(relay.deleteAt()).toBe(1_000 + PAIRING.ttlMs + PAIRING.graceMs)
  clock.now += PAIRING.ttlMs
  expect(relay.handle('take', ID, {})).toMatchObject({
    status: 404,
    body: { code: 'E_SYNC_PAIRING_GONE' },
  })
  expect(relay.handle('status', ID, { vault: VAULT })).toMatchObject({
    status: 200,
    body: { state: 'open' },
  })
  clock.now += PAIRING.graceMs
  expect(relay.handle('status', ID, { vault: VAULT })).toMatchObject({ status: 404 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM pairings').get()).toEqual({ n: 0 })
  expect(relay.deleteAt()).toBeNull()
})

it('keeps a confirmation made in time until the grace ends, and never the taken offer', () => {
  const { relay, clock, db } = pairingsAt(5_000)
  relay.handle('pair', ID, { vault: VAULT, offer }, 'dev')
  clock.now += PAIRING.ttlMs - 1
  expect(relay.handle('take', ID, {}).status).toBe(200)
  expect(db.prepare('SELECT offer FROM pairings').get()).toEqual({ offer: null })
  clock.now += 1
  expect(relay.handle('confirm', ID, { proof }).status).toBe(200)
  clock.now += PAIRING.graceMs - 1
  expect(relay.handle('status', ID, { vault: VAULT })).toMatchObject({
    status: 200,
    body: { state: 'confirmed', proof },
  })
})

it('sweeps expired pairings on any request, so a Node relay keeps none for long', () => {
  const { relay, clock, db } = pairingsAt(0)
  relay.handle('pair', ID, { vault: VAULT, offer }, 'dev')
  relay.handle('pair', 'BBBBBBBBBBBBBBBBBBBBBB', { vault: VAULT, offer }, 'dev')
  clock.now += PAIRING.ttlMs + PAIRING.graceMs
  relay.handle('take', 'CCCCCCCCCCCCCCCCCCCCCC', {})
  expect(db.prepare('SELECT COUNT(*) AS n FROM pairings').get()).toEqual({ n: 0 })
})
