import Database from 'better-sqlite3'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RateLimiter } from '../../relay/src/limiter'
import { sqliteSql } from '../../relay/src/node/sqlite'
import { VaultRelay } from '../../relay/src/vault'
import {
  CLOSE,
  decodeFrame,
  encodeFrame,
  enrollmentVerifier,
  LIMITS,
  toBase64Url,
} from '../../src/core/sync/protocol'
import { tempDir } from '../support/temp-dirs'

// The vault logic on its own, with a clock the test moves: what the wire suite cannot reach.

const secret = 'test-relay-secret-0123456789abcdef'
const open: Database.Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

async function vaultAt(start: number) {
  const db = new Database(join(tempDir('devot-relay-vault-'), 'v.sqlite'))
  open.push(db)
  const clock = { now: start }
  const relay = new VaultRelay(sqliteSql(db), 'vault-0123456789ab', {
    secret,
    now: () => clock.now,
    limiter: new RateLimiter(3, 1),
    log: () => {},
  })
  const enrollment = new Uint8Array(32).fill(1)
  const verifier = toBase64Url(await enrollmentVerifier(enrollment))
  const created = await relay.create({ verifier, label: 'mac' })
  const device = String(created.body['device'])
  const send = (message: object, chunks: Uint8Array[] = []) => {
    const reply = relay.receive(device, encodeFrame(message, chunks)).reply
    return decodeFrame(reply ?? '').message
  }
  const enroll = async (label: string) => {
    const enrolled = await relay.enroll({ secret: toBase64Url(enrollment), label })
    return String(enrolled.body['device'])
  }
  return { relay, clock, device, send, enroll, db }
}

const countersRow = (db: Database.Database) => db.prepare('SELECT * FROM counters').get()

describe('counters', () => {
  it('reset the daily counts at 00:00 UTC and keep the stored bytes', async () => {
    const { clock, send } = await vaultAt(Date.UTC(2026, 9, 23, 23, 59, 0))
    send({ type: 'push', id: 'r', base: 0, kind: 'file', chunks: [8] }, [new Uint8Array(8)])
    const before = send({ type: 'usage' })
    expect(before).toMatchObject({ day: '2026-10-23', storedBytes: 8, fileBytes: 8 })
    expect(Number(before['messages'])).toBe(2)
    clock.now = Date.UTC(2026, 9, 24, 0, 0, 30)
    const after = send({ type: 'usage' })
    expect(after).toMatchObject({ day: '2026-10-24', messages: 1, requests: 0, rowsWritten: 1 })
    expect(after).toMatchObject({ storedBytes: 8, fileBytes: 8 })
  })

  it('count messages refused by the rate limit with the next write, not with a write of their own', async () => {
    const { send, db } = await vaultAt(Date.UTC(2026, 9, 23, 12))
    for (let i = 0; i < 3; i++) expect(send({ type: 'time' })['type']).toBe('time')
    const limited = send({ type: 'time', rid: 1 })
    expect(limited).toMatchObject({ type: 'error', rid: 1, code: 'E_SYNC_RATE' })
    expect(Number(limited['retryAfter'])).toBeGreaterThan(0)
    const counted = db.prepare('SELECT messages FROM counters').get() as { messages: number }
    expect(counted.messages).toBe(3)
  })

  it('refuse a flood of malformed or oversized messages by rate, without a write of their own', async () => {
    const { relay, clock, device, send, db } = await vaultAt(Date.UTC(2026, 9, 23, 12))
    const before = countersRow(db)
    const replies = [
      relay.receive(device, 'garbage'),
      relay.receive(device, '{"v":9,"type":"pull","since":0}'),
      relay.receive(device, new Uint8Array(LIMITS.maxMessageBytes + 1)),
      relay.receive(device, 'garbage'),
      relay.receive(device, new Uint8Array(LIMITS.maxMessageBytes + 1)),
    ].map((outcome) => decodeFrame(outcome.reply ?? '').message['code'])
    expect(replies).toEqual([
      'E_SYNC_BAD_MESSAGE',
      'E_SYNC_PROTOCOL',
      'E_SYNC_TOO_LARGE',
      'E_SYNC_RATE',
      'E_SYNC_RATE',
    ])
    expect(countersRow(db)).toEqual(before)
    expect(Number(send({ type: 'time' })['retryAfter'])).toBeGreaterThan(0)
    clock.now += 10_000
    expect(send({ type: 'usage' })).toMatchObject({ messages: 7 })
  })

  it('moving a record between kinds moves its bytes between the totals', async () => {
    const { send } = await vaultAt(Date.UTC(2026, 9, 23, 12))
    send({ type: 'push', id: 'r', base: 0, kind: 'file', chunks: [10] }, [new Uint8Array(10)])
    send({ type: 'push', id: 'r', base: 1, kind: 'record', chunks: [4] }, [new Uint8Array(4)])
    expect(send({ type: 'usage' })).toMatchObject({ storedBytes: 4, fileBytes: 0 })
  })
})

describe('revoked devices', () => {
  it('get nothing more on a socket still open after the revoke, and their sockets are closed again', async () => {
    const { relay, clock, device, send, enroll, db } = await vaultAt(Date.UTC(2026, 9, 23, 12))
    const phone = await enroll('phone')
    expect(send({ type: 'revoke', device: phone })).toMatchObject({ type: 'revoked' })
    const attempts = [
      encodeFrame({ type: 'push', rid: 1, id: 'r', base: 0, kind: 'record', chunks: [1] }, [
        new Uint8Array(1),
      ]),
      encodeFrame({ type: 'pull', rid: 2, since: 0 }),
      encodeFrame({ type: 'devices', rid: 3 }),
      encodeFrame({ type: 'revoke', rid: 4, device }),
    ]
    for (const frame of attempts) {
      clock.now += 1000
      const outcome = relay.receive(phone, frame)
      expect(outcome.reply).toBeUndefined()
      expect(outcome.changed).toBeUndefined()
      expect(outcome.close).toMatchObject({ device: phone, code: CLOSE.revoked })
      expect(decodeFrame(outcome.close?.notice ?? '').message['code']).toBe('E_SYNC_REVOKED')
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT id FROM devices').all()).toEqual([{ id: device }])
  })
})

describe('rate limiter', () => {
  it('refills at its rate up to its capacity', () => {
    const limiter = new RateLimiter(2, 4)
    expect([limiter.take('a', 0), limiter.take('a', 0)]).toEqual([0, 0])
    expect(limiter.take('a', 0)).toBe(250)
    expect(limiter.take('b', 0)).toBe(0)
    expect(limiter.take('a', 250)).toBe(0)
    expect([
      limiter.take('a', 10_000),
      limiter.take('a', 10_000),
      limiter.take('a', 10_000),
    ]).toEqual([0, 0, 250])
  })
})

it('a push that fails inside its transaction leaves nothing behind', async () => {
  const { relay, device, send, db } = await vaultAt(Date.UTC(2026, 9, 23, 12))
  db.exec(
    "CREATE TRIGGER no_big BEFORE INSERT ON chunks WHEN NEW.idx = 1 BEGIN SELECT RAISE(ABORT, 'x'); END",
  )
  const reply = relay.receive(
    device,
    encodeFrame({ type: 'push', id: 'r', base: 0, kind: 'record', chunks: [1, 1] }, [
      new Uint8Array(1),
      new Uint8Array(1),
    ]),
  ).reply
  expect(decodeFrame(reply ?? '').message).toMatchObject({ code: 'E_SYNC_INTERNAL' })
  expect(db.prepare('SELECT COUNT(*) AS n FROM chunks').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
  expect(send({ type: 'usage' })).toMatchObject({ storedBytes: 0 })
})

it('the enrollment secret is never stored, only its verifier', async () => {
  const { db } = await vaultAt(Date.UTC(2026, 9, 23, 12))
  const row = db.prepare('SELECT verifier FROM vault').get() as { verifier: Buffer }
  expect(new Uint8Array(row.verifier)).toEqual(await enrollmentVerifier(new Uint8Array(32).fill(1)))
  const tables = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table'").all()
  expect(JSON.stringify(tables)).not.toMatch(/secret|token\b/)
})
