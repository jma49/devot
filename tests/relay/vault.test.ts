import Database from 'better-sqlite3'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleHttp, type Vaults } from '../../relay/src/front'
import { RateLimiter } from '../../relay/src/limiter'
import { sqliteSql } from '../../relay/src/node/sqlite'
import { FREE_CAPS } from '../../relay/src/quota'
import { ORPHAN_AGE_MS, VaultRelay, WIPE_SHARE, WIPE_SLICE_ROWS } from '../../relay/src/vault'
import {
  CLOSE,
  decodeFrame,
  encodeFrame,
  enrollmentVerifier,
  LIMITS,
  type QuotaCaps,
  toBase64Url,
  VAULT_ROTATED,
} from '../../src/core/sync/protocol'
import { tempDir } from '../support/temp-dirs'

// The vault logic on its own, with a clock the test moves: what the wire suite cannot reach.

const secret = 'test-relay-secret-0123456789abcdef'
const open: Database.Database[] = []
afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

interface VaultAtOptions {
  quota?: QuotaCaps | null
  limiter?: RateLimiter
  id?: string
}

async function vaultAt(start: number, options: VaultAtOptions = {}) {
  const db = new Database(join(tempDir('devot-relay-vault-'), 'v.sqlite'))
  open.push(db)
  /** `step` moves the clock on at every read, so a check made from two reads shows. */
  const clock = { now: start, step: 0 }
  const relay = new VaultRelay(sqliteSql(db), options.id ?? 'vault-0123456789ab', {
    secret,
    now: () => {
      const at = clock.now
      clock.now += clock.step
      return at
    },
    limiter: options.limiter ?? new RateLimiter(3, 1),
    log: () => {},
    ...(options.quota === undefined ? {} : { quota: options.quota }),
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

// A commit per record waits on the disk, which takes seconds on a CI runner.
const inOneCommit = (db: Database.Database, seed: () => void) => db.transaction(seed)()

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
    // The first usage was not written before midnight, so it is counted into the new day.
    expect(after).toMatchObject({ day: '2026-10-24', messages: 2, requests: 0, rowsWritten: 0 })
    expect(after).toMatchObject({ storedBytes: 8, fileBytes: 8 })
  })

  it('count messages refused by the rate limit with the next write, not with a write of their own', async () => {
    const { clock, send, db } = await vaultAt(Date.UTC(2026, 9, 23, 12))
    for (let i = 0; i < 3; i++) expect(send({ type: 'time' })['type']).toBe('time')
    const limited = send({ type: 'time', rid: 1 })
    expect(limited).toMatchObject({ type: 'error', rid: 1, code: 'E_SYNC_RATE' })
    expect(Number(limited['retryAfter'])).toBeGreaterThan(0)
    clock.now += 10_000
    expect(send({ type: 'usage' })).toMatchObject({ messages: 5 })
    expect(db.prepare('SELECT messages FROM counters').get()).toEqual({ messages: 0 })
  })

  it('count reads and connections with the next write, not with a write of their own', async () => {
    const { relay, device, send, db } = await vaultAt(Date.UTC(2026, 9, 23, 12), {
      limiter: new RateLimiter(1000, 1000),
    })
    const before = countersRow(db)
    relay.connected(device)
    for (const type of ['time', 'usage', 'devices']) send({ type })
    send({ type: 'pull', since: 0 })
    send({ type: 'revoke', device: 'nobody0123456789' })
    expect(countersRow(db)).toEqual(before)
    expect(send({ type: 'usage' })).toMatchObject({ messages: 6, requests: 2 })
    send({ type: 'push', id: 'r', base: 0, kind: 'record', chunks: [1] }, [new Uint8Array(1)])
    expect(db.prepare('SELECT messages, requests FROM counters').get()).toEqual({
      messages: 7,
      requests: 2,
    })
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

const NO_CAP = { rowsWritten: 1e12, requests: 1e12, storedBytes: 1e15 }
const roomy = () => new RateLimiter(1e9, 1e9)
const record = (id: string, base: number, size = 4): [object, Uint8Array[]] => [
  { type: 'push', id, base, kind: 'record', chunks: [size] },
  [new Uint8Array(size)],
]

describe('quota cap', () => {
  const noon = Date.UTC(2026, 9, 23, 12)
  const midnight = Date.UTC(2026, 9, 24)

  it('is 80% of the Workers Free limits by default', () => {
    expect(FREE_CAPS).toEqual({
      rowsWritten: 80_000,
      requests: 80_000,
      storedBytes: 4e9,
      fileBytes: 3e9,
    })
  })

  it('refuses pushes once the rows written reach the cap, until 00:00 UTC, and lets pulls through', async () => {
    const { clock, send } = await vaultAt(noon, {
      quota: { ...NO_CAP, rowsWritten: 12 },
      limiter: roomy(),
    })
    let refused: Record<string, unknown> | undefined
    for (let i = 0; i < 10 && !refused; i++) {
      const reply = send(...record(`r${i}`, 0))
      if (reply['type'] === 'error') refused = reply
    }
    expect(refused).toMatchObject({ code: 'E_SYNC_QUOTA', limit: 'rowsWritten', until: midnight })
    expect(send({ type: 'pull', since: 0 })).toMatchObject({ type: 'records' })
    expect(send({ type: 'usage' })).toMatchObject({ caps: { rowsWritten: 12 } })
    clock.now = midnight - 1
    expect(send(...record('late', 0))).toMatchObject({ code: 'E_SYNC_QUOTA', until: midnight })
    clock.now = midnight
    expect(send(...record('late', 0))).toMatchObject({ type: 'pushed' })
  })

  it('dates a refusal from the moment it checked the counters, even as the clock turns 00:00 UTC', async () => {
    const { clock, send } = await vaultAt(noon, {
      quota: { ...NO_CAP, rowsWritten: 12 },
      limiter: roomy(),
    })
    for (let i = 0; i < 10; i++) if (send(...record(`r${i}`, 0))['type'] === 'error') break
    clock.now = midnight - 2
    clock.step = 1
    expect(send(...record('late', 0))).toMatchObject({ code: 'E_SYNC_QUOTA', until: midnight })
  })

  it('counts connections against the requests cap on their own', async () => {
    const { relay, device, send } = await vaultAt(noon, { quota: { ...NO_CAP, requests: 4 } })
    expect(send(...record('a', 0))).toMatchObject({ type: 'pushed' })
    for (let i = 0; i < 3; i++) relay.connected(device)
    expect(send(...record('b', 0))).toMatchObject({ code: 'E_SYNC_QUOTA', limit: 'requests' })
  })

  it('counts twenty incoming messages as one request', async () => {
    const { send } = await vaultAt(noon, { quota: { ...NO_CAP, requests: 3 }, limiter: roomy() })
    // The creation was one request; with the push below, forty messages make two more.
    for (let i = 0; i < 39; i++) send({ type: 'time' })
    expect(send(...record('a', 0))).toMatchObject({ type: 'pushed' })
    expect(send(...record('b', 0))).toMatchObject({ code: 'E_SYNC_QUOTA', limit: 'requests' })
  })

  it('refuses a push that would take the stored bytes past the cap, and takes one that frees space', async () => {
    const { clock, send } = await vaultAt(noon, {
      quota: { ...NO_CAP, storedBytes: 100 },
      limiter: roomy(),
    })
    expect(send(...record('a', 0, 60))).toMatchObject({ type: 'pushed' })
    expect(send(...record('b', 0, 50))).toMatchObject({
      code: 'E_SYNC_QUOTA',
      limit: 'storedBytes',
      until: midnight,
    })
    expect(send(...record('a', 1, 70))).toMatchObject({ type: 'pushed' })
    expect(send(...record('a', 2, 10))).toMatchObject({ type: 'pushed' })
    clock.now += 1000
    expect(send(...record('b', 0, 50))).toMatchObject({ type: 'pushed' })
  })

  it('writes nothing for a refused push and counts it with the next write', async () => {
    const { send, db } = await vaultAt(noon, { quota: { ...NO_CAP, rowsWritten: 1 } })
    const before = countersRow(db)
    expect(send(...record('a', 0))).toMatchObject({ code: 'E_SYNC_QUOTA' })
    expect(countersRow(db)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
    expect(Number(send({ type: 'usage' })['messages'])).toBe(2)
  })

  describe('attachment share', () => {
    const KB = 1000
    const file = (id: string, base: number, size: number): [object, Uint8Array[]] => [
      { type: 'push', id, base, kind: 'file', chunks: [size] },
      [new Uint8Array(size)],
    ]

    it('refuses a file past its share with E_SYNC_ATTACHMENTS_FULL while records keep going in', async () => {
      const { send, db } = await vaultAt(noon, {
        quota: { ...NO_CAP, storedBytes: 1000 * KB, fileBytes: 100 * KB },
        limiter: roomy(),
      })
      expect(send(...file('a', 0, 60 * KB))).toMatchObject({ type: 'pushed' })
      const before = countersRow(db)
      const full = send(...file('b', 0, 50 * KB))
      expect(full).toMatchObject({ type: 'error', code: 'E_SYNC_ATTACHMENTS_FULL' })
      expect(full).not.toHaveProperty('until')
      expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
      expect(countersRow(db)).toEqual(before)
      expect(send(...record('n', 0, 500 * KB))).toMatchObject({ type: 'pushed' })
      expect(send(...file('b', 0, 40 * KB))).toMatchObject({ type: 'pushed' })
      expect(send({ type: 'usage' })).toMatchObject({
        storedBytes: 600 * KB,
        fileBytes: 100 * KB,
      })
    })

    it('frees the share when a purge replaces the file with a tombstone', async () => {
      const { send, db } = await vaultAt(noon, {
        quota: { ...NO_CAP, fileBytes: 100 * KB },
        limiter: roomy(),
      })
      expect(send(...file('a', 0, 90 * KB))).toMatchObject({ type: 'pushed' })
      expect(send(...file('b', 0, 20 * KB))).toMatchObject({ code: 'E_SYNC_ATTACHMENTS_FULL' })
      expect(send(...file('a', 1, 300))).toMatchObject({ type: 'pushed', version: 2 })
      expect(db.prepare('SELECT SUM(LENGTH(bytes)) AS n FROM chunks').get()).toEqual({ n: 300 })
      expect(send({ type: 'usage' })).toMatchObject({ fileBytes: 300, storedBytes: 300 })
      expect(send(...file('b', 0, 20 * KB))).toMatchObject({ type: 'pushed' })
    })

    it('lets a file be pushed again at its size, and refuses one that grows past the share', async () => {
      const { send } = await vaultAt(noon, {
        quota: { ...NO_CAP, fileBytes: 100 * KB },
        limiter: roomy(),
      })
      expect(send(...file('a', 0, 100 * KB))).toMatchObject({ type: 'pushed' })
      expect(send(...file('a', 1, 100 * KB))).toMatchObject({ type: 'pushed' })
      expect(send(...file('a', 2, 101 * KB))).toMatchObject({ code: 'E_SYNC_ATTACHMENTS_FULL' })
    })

    it('lets the daily limits and the total storage speak first', async () => {
      const rows = await vaultAt(noon, {
        quota: { ...NO_CAP, rowsWritten: 1, fileBytes: 1 },
        limiter: roomy(),
      })
      expect(rows.send(...file('a', 0, 5 * KB))).toMatchObject({
        code: 'E_SYNC_QUOTA',
        limit: 'rowsWritten',
      })
      const total = await vaultAt(noon, {
        quota: { ...NO_CAP, storedBytes: 10 * KB, fileBytes: 100 * KB },
        limiter: roomy(),
      })
      expect(total.send(...file('a', 0, 20 * KB))).toMatchObject({
        code: 'E_SYNC_QUOTA',
        limit: 'storedBytes',
      })
    })

    it('always takes a tombstone-sized file record, so a purge can free a full share', async () => {
      const { send } = await vaultAt(noon, {
        quota: { ...NO_CAP, fileBytes: 100 * KB },
        limiter: roomy(),
      })
      expect(send(...file('a', 0, 100 * KB))).toMatchObject({ type: 'pushed' })
      expect(send(...file('b', 0, 3 * KB))).toMatchObject({ code: 'E_SYNC_ATTACHMENTS_FULL' })
      expect(send(...file('gone', 0, 300))).toMatchObject({ type: 'pushed' })
      expect(send(...file('a', 1, 300))).toMatchObject({ type: 'pushed' })
    })

    it('has no share when the host runs without the cap', async () => {
      const { send } = await vaultAt(noon, { quota: null, limiter: roomy() })
      expect(send(...file('a', 0, 5000))).toMatchObject({ type: 'pushed' })
    })

    it('refuses a file record larger than an image and its envelope can be', async () => {
      const { send, db } = await vaultAt(noon, { quota: null, limiter: roomy() })
      const chunk = LIMITS.maxChunkBytes
      const sizes = Array(Math.ceil(LIMITS.maxFileRecordBytes / chunk) + 1).fill(chunk) as number[]
      const reply = send(
        { type: 'push', id: 'big', base: 0, kind: 'file', chunks: sizes },
        sizes.map((n) => new Uint8Array(n)),
      )
      expect(reply).toMatchObject({ code: 'E_SYNC_TOO_LARGE' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
    })
  })

  it('is off when the host turns it off, and the welcome says which', async () => {
    const off = await vaultAt(noon, { quota: null, limiter: roomy() })
    for (let i = 0; i < 3; i++)
      expect(off.send(...record(`r${i}`, 0))).toMatchObject({ type: 'pushed' })
    expect(off.send({ type: 'usage' })).toMatchObject({ caps: null })
    expect(decodeFrame(off.relay.connected(off.device)).message).toMatchObject({ quota: 'off' })
    const on = await vaultAt(noon)
    expect(decodeFrame(on.relay.connected(on.device)).message).toMatchObject({ quota: 'on' })
  })

  it('says the caps it enforces, whatever the host, so a client never assumes a host’s', async () => {
    const larger = { rowsWritten: 1e9, requests: 1e9, storedBytes: 50e9, fileBytes: 40e9 }
    const big = await vaultAt(noon, { quota: larger, limiter: roomy() })
    expect(big.send({ type: 'usage' })).toMatchObject({
      storedBytes: 0,
      fileBytes: 0,
      caps: larger,
    })

    // A relay from before the share for images: caps for the total, none for images.
    const beforeShare = { rowsWritten: 1e9, requests: 1e9, storedBytes: 9e9 }
    const old = await vaultAt(noon, { quota: beforeShare, limiter: roomy() })
    const usage = old.send({ type: 'usage' })
    expect(usage['caps']).toEqual(beforeShare)
    expect(decodeFrame(old.relay.connected(old.device)).message).toMatchObject({
      quota: 'on',
      attachments: 'off',
    })
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

describe('retirement', () => {
  const successor = 'successor-0123456789ab'
  const at = Date.UTC(2026, 10, 5, 12)
  const pushFrame = (rid: number) =>
    encodeFrame({ type: 'push', rid, id: 'r', base: 0, kind: 'record', chunks: [1] }, [
      new Uint8Array(1),
    ])
  const rightSecret = () => toBase64Url(new Uint8Array(32).fill(1))

  it('says in the welcome that the relay can retire, and names no successor before it does', async () => {
    const { relay, device } = await vaultAt(at)
    const welcome = decodeFrame(relay.connected(device)).message
    expect(welcome).toMatchObject({ rotation: 'on' })
    expect(welcome).not.toHaveProperty('retired')
    expect(relay.live()).toBe(true)
  })

  it('takes no retire over a socket: an enrolled device cannot retire the vault', async () => {
    const { send } = await vaultAt(at, { limiter: roomy() })
    expect(send({ type: 'retire', rid: 1, successor })).toMatchObject({
      type: 'error',
      rid: 1,
      code: 'E_SYNC_BAD_MESSAGE',
    })
    expect(send(...record('r', 0))).toMatchObject({ type: 'pushed' })
  })

  it('refuses pushes, pulls and enrollments once retired, naming the successor', async () => {
    const { relay, device, send, enroll, db } = await vaultAt(at, { limiter: roomy() })
    const phone = await enroll('phone')
    expect(send(...record('r', 0))).toMatchObject({ type: 'pushed' })
    const retired = relay.retire({ successor })
    expect(retired.reply).toEqual({ status: 200, body: { v: 1, type: 'retired', successor } })
    expect(decodeFrame(retired.changed ?? '').message).toMatchObject({ type: 'changed' })
    expect(relay.live()).toBe(false)

    for (const from of [device, phone]) {
      const push = decodeFrame(relay.receive(from, pushFrame(2)).reply ?? '').message
      expect(push).toMatchObject({ type: 'error', rid: 2, code: VAULT_ROTATED, successor })
      const pull = relay.receive(from, encodeFrame({ type: 'pull', rid: 3, since: 0 })).reply
      expect(decodeFrame(pull ?? '').message).toMatchObject({ code: VAULT_ROTATED, successor })
    }
    const again = await relay.enroll({ secret: rightSecret(), label: 'again' })
    expect(again).toMatchObject({ status: 409, body: { code: VAULT_ROTATED, successor } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 2 })
    expect(decodeFrame(relay.connected(phone)).message).toMatchObject({ retired: successor })
    expect(send({ type: 'devices' })).toMatchObject({ type: 'devices' })
  })

  it('checks the enrollment secret before it names the successor', async () => {
    const { relay } = await vaultAt(at)
    relay.retire({ successor })
    const wrong = await relay.enroll({
      secret: toBase64Url(new Uint8Array(32).fill(9)),
      label: 'thief',
    })
    expect(wrong).toEqual({
      status: 403,
      body: { v: 1, type: 'error', code: 'E_SYNC_ENROLL_DENIED' },
    })
    const right = await relay.enroll({ secret: rightSecret(), label: 'phone' })
    expect(right).toMatchObject({ status: 409, body: { code: VAULT_ROTATED, successor } })
  })

  it('keeps the retirement for a relay opened again on the same storage', async () => {
    const { relay, db, enroll } = await vaultAt(at, { limiter: roomy() })
    const device = await enroll('phone')
    relay.retire({ successor })
    const again = new VaultRelay(sqliteSql(db), relay.vault, { secret, log: () => {} })
    expect(again.live()).toBe(false)
    const push = decodeFrame(again.receive(device, pushFrame(4)).reply ?? '').message
    expect(push).toMatchObject({ code: VAULT_ROTATED, successor })
  })

  it('keeps the first successor: the same one is retired again, another is refused', async () => {
    const { relay } = await vaultAt(at)
    expect(relay.retire({ successor }).reply.body).toMatchObject({ type: 'retired', successor })
    const same = relay.retire({ successor })
    expect(same.reply.body).toMatchObject({ type: 'retired', successor })
    expect(same.changed).toBeUndefined()
    expect(relay.retire({ successor: 'another-0123456789abcd' }).reply).toMatchObject({
      status: 409,
      body: { type: 'error', code: VAULT_ROTATED, successor },
    })
  })

  it('refuses a successor that is not a vault ID or is the vault itself', async () => {
    const { relay, send } = await vaultAt(at, { limiter: roomy() })
    for (const name of ['short', relay.vault, 7, undefined]) {
      expect(relay.retire({ successor: name }).reply).toMatchObject({
        status: 400,
        body: { code: 'E_SYNC_BAD_MESSAGE' },
      })
    }
    expect(send(...record('r', 0))).toMatchObject({ type: 'pushed' })
  })
})

describe('wiping a retired vault', () => {
  const successor = 'successor-0123456789ab'
  const at = Date.UTC(2026, 10, 5, 12)
  const count = (db: Database.Database, table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  it('wipes the records once retired and counts it, keeping the vault, its devices and the retirement', async () => {
    const { relay, device, send, enroll, db } = await vaultAt(at, { limiter: roomy() })
    const phone = await enroll('phone')
    expect(send(...record('a', 0, 10))).toMatchObject({ type: 'pushed' })
    send({ type: 'push', id: 'b', base: 0, kind: 'record', chunks: [3, 4] }, [
      new Uint8Array(3),
      new Uint8Array(4),
    ])
    send({ type: 'push', id: 'img', base: 0, kind: 'file', chunks: [20] }, [new Uint8Array(20)])
    expect(relay.nextSweep()).toBeNull()
    expect(relay.sweep()).toEqual({ drop: false, next: null })
    expect(count(db, 'records')).toBe(3)

    relay.retire({ successor })
    expect(relay.nextSweep()).toBe(at)
    const before = send({ type: 'usage' })
    expect(relay.sweep()).toEqual({ drop: false, next: null })
    expect(count(db, 'records')).toBe(0)
    expect(count(db, 'chunks')).toBe(0)
    expect(count(db, 'devices')).toBe(2)
    const after = send({ type: 'usage' })
    expect(after).toMatchObject({ storedBytes: 0, fileBytes: 0 })
    // Three record rows, four chunk rows and the counters row.
    expect(Number(after['rowsWritten']) - Number(before['rowsWritten'])).toBeGreaterThanOrEqual(8)
    expect(Number(after['requests'])).toBeGreaterThan(Number(before['requests']))
    expect(relay.nextSweep()).toBeNull()
    expect(relay.sweep()).toEqual({ drop: false, next: null })

    expect(decodeFrame(relay.connected(phone)).message).toMatchObject({ retired: successor })
    const pull = relay.receive(device, encodeFrame({ type: 'pull', rid: 1, since: 0 })).reply
    expect(decodeFrame(pull ?? '').message).toMatchObject({ code: VAULT_ROTATED, successor })
    expect(relay.retire({ successor }).reply.status).toBe(200)
    expect(relay.retire({ successor: 'another-0123456789abcd' }).reply).toMatchObject({
      status: 409,
      body: { code: VAULT_ROTATED, successor },
    })
    const again = await relay.enroll({
      secret: toBase64Url(new Uint8Array(32).fill(1)),
      label: 'x',
    })
    expect(again).toMatchObject({ status: 409, body: { code: VAULT_ROTATED, successor } })
  })

  it('wipes a large vault in slices, with a share of the daily rows cap a day', async () => {
    const { relay, send, db, clock } = await vaultAt(at, { quota: null, limiter: roomy() })
    inOneCommit(db, () => {
      for (let i = 0; i < 300; i++) send(...record(`r${i}`, 0, 2))
    })
    relay.retire({ successor })
    clock.now = Date.UTC(2026, 10, 6, 12)
    const caps = { rowsWritten: 400, requests: 1e12, storedBytes: 1e15 }
    const capped = new VaultRelay(sqliteSql(db), relay.vault, {
      secret,
      now: () => clock.now,
      log: () => {},
      quota: caps,
    })
    const days: { rows: number; next: number }[] = []
    const steps = []
    for (let guard = 0; guard < 1000; guard++) {
      const step = capped.sweep()
      steps.push(step)
      if (step.drop || step.next === null) break
      if (step.next > clock.now) {
        const counters = countersRow(db) as { rows_written: number }
        days.push({ rows: counters.rows_written, next: step.next })
        clock.now = step.next + 1000
      }
    }
    expect(steps.every((step) => !step.drop)).toBe(true)
    expect(count(db, 'records')).toBe(0)
    expect(days.length).toBeGreaterThanOrEqual(5)
    expect(days.map((day) => day.next)).toEqual(days.map((_, i) => Date.UTC(2026, 10, 7 + i)))
    for (const { rows } of days) expect(rows).toBeLessThanOrEqual(caps.rowsWritten * WIPE_SHARE)
  })

  it('wipes without a cap in slices that follow each other at once', async () => {
    const { relay, send, db } = await vaultAt(at, { quota: null, limiter: roomy() })
    // A one-chunk record costs two rows: this many take three slices, one after the first sweep and one more.
    inOneCommit(db, () => {
      for (let i = 0; i <= WIPE_SLICE_ROWS; i++) send(...record(`r${i}`, 0, 1))
    })
    relay.retire({ successor })
    expect(relay.sweep()).toEqual({ drop: false, next: at })
    expect(count(db, 'records')).toBeGreaterThan(0)
    let steps = 1
    while (relay.sweep().drop === false && relay.nextSweep() !== null) steps++
    expect(count(db, 'records')).toBe(0)
    expect(steps).toBeGreaterThan(1)
  })
})

describe('dropping an empty vault', () => {
  const at = Date.UTC(2026, 10, 5, 12)
  const days = (n: number) => at + n * 24 * 3600 * 1000

  it('drops a vault with no record and one device once nobody connected for 90 days', async () => {
    const { relay, clock, device } = await vaultAt(at)
    expect(ORPHAN_AGE_MS).toBe(90 * 24 * 3600 * 1000)
    expect(relay.nextSweep()).toBe(days(90))
    clock.now = days(89)
    expect(relay.sweep()).toEqual({ drop: false, next: days(90) })
    clock.now = days(60)
    relay.connected(device)
    clock.now = days(91)
    expect(relay.sweep()).toEqual({ drop: false, next: days(150) })
    clock.now = days(150)
    expect(relay.sweep()).toEqual({ drop: true })
  })

  it('reads when it was last connected from storage, for a relay opened again', async () => {
    const { relay, clock, device, db } = await vaultAt(at)
    clock.now = days(30)
    relay.connected(device)
    const again = new VaultRelay(sqliteSql(db), relay.vault, {
      secret,
      now: () => clock.now,
      log: () => {},
    })
    expect(again.nextSweep()).toBe(days(120))
  })

  it('writes when it was connected at most once a day', async () => {
    const { relay, clock, device, db } = await vaultAt(at)
    const before = countersRow(db)
    clock.now = at + 3600_000
    relay.connected(device)
    expect(countersRow(db)).toEqual(before)
    clock.now = days(1)
    relay.connected(device)
    const once = countersRow(db)
    expect(once).not.toEqual(before)
    clock.now = days(1) + 3600_000
    relay.connected(device)
    expect(countersRow(db)).toEqual(once)
    expect(relay.nextSweep()).toBe(days(91))
  })

  it('never drops a vault with a record, a retirement or a predecessor', async () => {
    const withRecord = await vaultAt(at)
    withRecord.send(...record('r', 0))
    const retired = await vaultAt(at)
    retired.relay.retire({ successor: 'successor-0123456789ab' })
    const successor = await vaultAt(at)
    successor.relay.adopt('predecessor-0123456789')
    for (const { relay, clock } of [withRecord, retired, successor]) {
      expect(relay.nextSweep()).toBeNull()
      clock.now = days(400)
      expect(relay.sweep()).toEqual({ drop: false, next: null })
    }
  })

  it('keeps a vault while a device stays connected, and drops it once none is', async () => {
    const { relay, clock } = await vaultAt(at)
    clock.now = days(400)
    expect(relay.sweep(true)).toEqual({ drop: false, next: days(490) })
    clock.now = days(490)
    expect(relay.sweep()).toEqual({ drop: true })
  })

  it('keeps a successor that a retire checked, though a sweep runs before the retire', async () => {
    const successor = await vaultAt(at, { id: 'successor-0123456789ab' })
    const old = await vaultAt(at, { id: 'old-vault-0123456789ab' })
    for (const clock of [successor.clock, old.clock]) clock.now = days(91)
    const relays = new Map([successor.relay, old.relay].map((relay) => [relay.vault, relay]))
    const sweeps: boolean[] = []
    const vaults = {
      live: async (vault: string) => relays.get(vault)?.live() ?? false,
      retire: async (vault: string, body: Record<string, unknown>) => {
        sweeps.push(successor.relay.sweep().drop)
        return relays.get(vault)!.retire(body).reply
      },
      adopt: async (vault: string, predecessor: string) => relays.get(vault)?.adopt(predecessor),
    } as unknown as Vaults
    const response = await handleHttp(
      new Request(`http://relay/v1/vaults/${old.relay.vault}/retire`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({ v: 1, type: 'retire', successor: successor.relay.vault }),
      }),
      secret,
      vaults,
    )
    expect(response.status).toBe(200)
    expect(sweeps).toEqual([false])
    successor.clock.now = days(400)
    expect(successor.relay.sweep()).toEqual({ drop: false, next: null })
  })

  it('keeps a vault with a second device, and looks again later', async () => {
    const { relay, clock, enroll } = await vaultAt(at)
    await enroll('phone')
    clock.now = days(91)
    expect(relay.sweep()).toEqual({ drop: false, next: days(181) })
  })

  it('keeps the first predecessor and answers for a vault that does not exist', async () => {
    const { relay, db } = await vaultAt(at)
    relay.adopt('predecessor-0123456789')
    relay.adopt('another-0123456789abcd')
    expect(db.prepare('SELECT predecessor FROM standing').get()).toEqual({
      predecessor: 'predecessor-0123456789',
    })
    const empty = new Database(join(tempDir('devot-relay-none-'), 'v.sqlite'))
    open.push(empty)
    const none = new VaultRelay(sqliteSql(empty), 'vault-0123456789ab', { secret, log: () => {} })
    none.adopt('predecessor-0123456789')
    expect(none.exists()).toBe(false)
    expect(none.nextSweep()).toBeNull()
    expect(none.sweep()).toEqual({ drop: false, next: null })
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
