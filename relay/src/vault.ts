import {
  CLOSE,
  type DeviceInfo,
  decodeFrame,
  encodeFrame,
  enrollmentVerifier,
  fromBase64Url,
  isCount,
  isLabel,
  isRecordId,
  LIMITS,
  ProtocolError,
  type QuotaCaps,
  quotaResetAt,
  type RecordHead,
  type RecordKind,
  splitChunks,
} from '../../src/core/sync/protocol.ts'
import { RateLimiter } from './limiter.ts'
import { FREE_CAPS, trippedLimit } from './quota.ts'
import { issueToken, randomId, sameBytes, sha256 } from './tokens.ts'

// One vault's relay logic (docs/adr/0002-sync-latest-state-per-record.md,
// Relay), over the SQL of the host's SQLite: a Durable Object's storage or a
// file per vault under Node. Both run the same statements.

export type SqlValue = string | number | null | Uint8Array

/** The storage interface: a host's SQLite. Blobs come back as Uint8Array. */
export interface Sql {
  all(query: string, ...params: SqlValue[]): Record<string, SqlValue>[]
  /** Runs a statement and returns the rows it wrote, as the host counts them. */
  run(query: string, ...params: SqlValue[]): number
  transaction<T>(fn: () => T): T
}

export interface Reply {
  status: number
  body: Record<string, unknown>
}

export type Outgoing = string | Uint8Array

export interface Outcome {
  reply?: Outgoing
  /** For the vault's other connections. */
  changed?: Outgoing
  /** After the reply, send `notice` to every connection of this device and close it. */
  close?: { device: string; code: number; reason: string; notice: Outgoing }
}

export interface VaultOptions {
  secret: string
  now?: () => number
  limiter?: RateLimiter
  log?: (line: string) => void
  /** The cap on pushes; null runs without one. Defaults to 80% of the Workers Free limits. */
  quota?: QuotaCaps | null
}

const SCHEMA = [
  `CREATE TABLE vault (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    vault_id TEXT NOT NULL,
    schema INTEGER NOT NULL,
    epoch TEXT NOT NULL,
    verifier BLOB NOT NULL,
    created INTEGER NOT NULL
  )`,
  `CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    token_hash BLOB NOT NULL,
    label TEXT NOT NULL,
    created INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE records (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    seq INTEGER NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE chunks (
    id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (id, idx)
  ) WITHOUT ROWID`,
  // Daily counters reset at 00:00 UTC, like the Workers Free limits; stored bytes are totals.
  `CREATE TABLE counters (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    day TEXT NOT NULL,
    rows_written INTEGER NOT NULL,
    messages INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    stored_bytes INTEGER NOT NULL,
    file_bytes INTEGER NOT NULL
  )`,
]
const SCHEMA_VERSION = 1
const MAX_DEVICES = 100

const encoder = new TextEncoder()
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const num = (value: SqlValue | undefined) => Number(value ?? 0)

function errorReply(status: number, code: string): Reply {
  return { status, body: { v: 1, type: 'error', code } }
}

function messageBytes(data: Outgoing): number {
  if (typeof data !== 'string') return data.byteLength
  // A string's UTF-8 length is between its length and three times it.
  return data.length * 3 <= LIMITS.maxMessageBytes ? data.length : encoder.encode(data).length
}

function peekRid(data: Outgoing): number | undefined {
  if (messageBytes(data) > LIMITS.maxMessageBytes) return undefined
  try {
    const rid = decodeFrame(data).message['rid']
    return isCount(rid) ? rid : undefined
  } catch {
    return undefined
  }
}

function revokedClose(device: string): NonNullable<Outcome['close']> {
  return {
    device,
    code: CLOSE.revoked,
    reason: 'E_SYNC_REVOKED',
    notice: encodeFrame({ type: 'error', code: 'E_SYNC_REVOKED' }),
  }
}

interface Delta {
  rows?: number
  messages?: number
  requests?: number
  stored?: number
  files?: number
}

export class VaultRelay {
  readonly vault: string
  private readonly sql: Sql
  private readonly secret: string
  private readonly now: () => number
  private readonly limiter: RateLimiter
  private readonly log: (line: string) => void
  private readonly quota: QuotaCaps | null
  // Counted without a write of their own (refused messages and enrollments), added to the next one.
  private pending = { messages: 0, requests: 0 }

  constructor(sql: Sql, vault: string, options: VaultOptions) {
    this.sql = sql
    this.vault = vault
    this.secret = options.secret
    this.now = options.now ?? Date.now
    this.limiter = options.limiter ?? new RateLimiter()
    this.log = options.log ?? ((line) => console.error(line))
    this.quota = options.quota === undefined ? FREE_CAPS : options.quota
  }

  exists(): boolean {
    return (
      this.sql.all("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'vault'")
        .length > 0
    )
  }

  async create(body: Record<string, unknown>): Promise<Reply> {
    const verifier = fromBase64Url(body['verifier'])
    const label = body['label']
    if (!verifier || verifier.length !== 32 || !isLabel(label)) {
      return errorReply(400, 'E_SYNC_BAD_MESSAGE')
    }
    const device = randomId()
    const epoch = randomId()
    const { token, hash } = await issueToken(this.secret, this.vault, device)
    const now = this.now()
    return this.sql.transaction(() => {
      if (this.exists()) return errorReply(409, 'E_SYNC_VAULT_EXISTS')
      for (const statement of SCHEMA) this.sql.run(statement)
      let rows = this.sql.run(
        'INSERT INTO vault (id, vault_id, schema, epoch, verifier, created) VALUES (1, ?, ?, ?, ?, ?)',
        this.vault,
        SCHEMA_VERSION,
        epoch,
        verifier,
        now,
      )
      rows += this.sql.run(
        'INSERT INTO counters (id, day, rows_written, messages, requests, stored_bytes, file_bytes) VALUES (1, ?, 0, 0, 0, 0, 0)',
        day(now),
      )
      rows += this.insertDevice(device, hash, label, now)
      this.count({ rows, requests: 1 })
      return { status: 200, body: { v: 1, type: 'enrolled', epoch, device, token, time: now } }
    })
  }

  async enroll(body: Record<string, unknown>): Promise<Reply> {
    const secret = fromBase64Url(body['secret'])
    const label = body['label']
    if (!secret || secret.length !== 32 || !isLabel(label)) {
      return errorReply(400, 'E_SYNC_BAD_MESSAGE')
    }
    if (!this.exists()) return errorReply(404, 'E_SYNC_NO_VAULT')
    const verifier = await enrollmentVerifier(secret)
    const stored = this.sql.all('SELECT verifier, epoch FROM vault WHERE id = 1')[0]
    if (!stored || !sameBytes(verifier, stored['verifier'] as Uint8Array)) {
      this.pending.requests++
      return errorReply(403, 'E_SYNC_ENROLL_DENIED')
    }
    const device = randomId()
    const { token, hash } = await issueToken(this.secret, this.vault, device)
    const now = this.now()
    return this.sql.transaction(() => {
      if (num(this.sql.all('SELECT COUNT(*) AS n FROM devices')[0]?.['n']) >= MAX_DEVICES) {
        this.pending.requests++
        return errorReply(409, 'E_SYNC_TOO_MANY_DEVICES')
      }
      const rows = this.insertDevice(device, hash, label, now)
      this.count({ rows, requests: 1 })
      const epoch = String(stored['epoch'])
      return { status: 200, body: { v: 1, type: 'enrolled', epoch, device, token, time: now } }
    })
  }

  /** Whether `token` is the current token of `device` in this vault. */
  async authenticate(device: string, token: string): Promise<'ok' | 'no-vault' | 'unknown'> {
    if (!this.exists()) return 'no-vault'
    const hash = await sha256(token)
    const row = this.sql.all('SELECT token_hash FROM devices WHERE id = ?', device)[0]
    return row && sameBytes(hash, row['token_hash'] as Uint8Array) ? 'ok' : 'unknown'
  }

  /** Counts a new connection and returns its welcome. */
  connected(device: string): Outgoing {
    this.count({ requests: 1 })
    const epoch = String(this.sql.all('SELECT epoch FROM vault WHERE id = 1')[0]?.['epoch'])
    const quota = this.quota ? 'on' : 'off'
    return encodeFrame({
      type: 'welcome',
      time: this.now(),
      epoch,
      seq: this.head(),
      device,
      quota,
    })
  }

  /** Messages refused before dispatch (rate, revoked device, malformed) cost no write of their own. */
  receive(device: string, data: Outgoing): Outcome {
    const wait = this.limiter.take(device, this.now())
    let rid: number | undefined
    try {
      if (wait > 0) {
        this.pending.messages++
        return {
          reply: encodeFrame({
            type: 'error',
            rid: peekRid(data),
            code: 'E_SYNC_RATE',
            retryAfter: wait,
          }),
        }
      }
      // The host's close of a revoked device's sockets is not immediate: refuse what still arrives.
      if (this.sql.all('SELECT 1 AS x FROM devices WHERE id = ?', device).length === 0) {
        this.pending.messages++
        return { close: revokedClose(device) }
      }
      if (messageBytes(data) > LIMITS.maxMessageBytes) throw new ProtocolError('E_SYNC_TOO_LARGE')
      const { message, payload } = decodeFrame(data)
      if (isCount(message['rid'])) rid = message['rid']
      return this.dispatch(device, rid, message, payload)
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : 'E_SYNC_INTERNAL'
      if (code === 'E_SYNC_INTERNAL') this.log(`E_SYNC_INTERNAL vault=${this.vault}`)
      this.pending.messages++
      return { reply: encodeFrame({ type: 'error', rid, code }) }
    }
  }

  private dispatch(
    device: string,
    rid: number | undefined,
    message: Record<string, unknown>,
    payload: Uint8Array,
  ): Outcome {
    switch (message['type']) {
      case 'push':
        return this.push(rid, message, payload)
      case 'pull':
        return this.pull(rid, message)
      case 'devices':
        this.count({ messages: 1 })
        return { reply: encodeFrame({ type: 'devices', rid, devices: this.devices(device) }) }
      case 'revoke':
        return this.revoke(rid, message)
      case 'time':
        this.count({ messages: 1 })
        return { reply: encodeFrame({ type: 'time', rid, time: this.now() }) }
      case 'usage':
        this.count({ messages: 1 })
        return { reply: encodeFrame({ type: 'usage', rid, ...this.usage() }) }
      default:
        throw new ProtocolError('E_SYNC_BAD_MESSAGE')
    }
  }

  private push(
    rid: number | undefined,
    message: Record<string, unknown>,
    payload: Uint8Array,
  ): Outcome {
    const { id, base, kind, chunks: lengths } = message
    if (!isRecordId(id) || !isCount(base) || (kind !== 'record' && kind !== 'file')) {
      throw new ProtocolError('E_SYNC_BAD_MESSAGE')
    }
    if (!Array.isArray(lengths) || lengths.length === 0)
      throw new ProtocolError('E_SYNC_BAD_MESSAGE')
    if (lengths.length > LIMITS.maxChunks) throw new ProtocolError('E_SYNC_TOO_LARGE')
    for (const length of lengths) {
      if (!isCount(length) || length === 0) throw new ProtocolError('E_SYNC_BAD_MESSAGE')
      if (length > LIMITS.maxChunkBytes) throw new ProtocolError('E_SYNC_TOO_LARGE')
    }
    const chunks = splitChunks(payload, lengths as number[])
    const at = this.now()
    const result = this.sql.transaction(() => {
      const row = this.sql.all('SELECT version, kind, bytes FROM records WHERE id = ?', id)[0]
      const limit = this.quotaLimit(payload.length - num(row?.['bytes']), at)
      if (limit) {
        this.pending.messages++
        return { quota: limit }
      }
      const current = num(row?.['version'])
      if (base !== current) {
        this.count({ messages: 1 })
        return { rejected: current }
      }
      const seq = this.head() + 1
      const version = current + 1
      const total = payload.length
      let rows = this.sql.run(
        `INSERT INTO records (id, version, seq, kind, chunk_count, bytes) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, seq = excluded.seq,
           kind = excluded.kind, chunk_count = excluded.chunk_count, bytes = excluded.bytes`,
        id,
        version,
        seq,
        kind,
        chunks.length,
        total,
      )
      chunks.forEach((chunk, idx) => {
        rows += this.sql.run(
          'INSERT INTO chunks (id, idx, bytes) VALUES (?, ?, ?) ON CONFLICT (id, idx) DO UPDATE SET bytes = excluded.bytes',
          id,
          idx,
          chunk,
        )
      })
      rows += this.sql.run('DELETE FROM chunks WHERE id = ? AND idx >= ?', id, chunks.length)
      const old = num(row?.['bytes'])
      const oldFile = row?.['kind'] === 'file' ? old : 0
      this.count({
        rows,
        messages: 1,
        stored: total - old,
        files: (kind === 'file' ? total : 0) - oldFile,
      })
      return { version, seq }
    })
    if ('quota' in result) {
      const until = quotaResetAt(at)
      return {
        reply: encodeFrame({
          type: 'error',
          rid,
          code: 'E_SYNC_QUOTA',
          limit: result.quota,
          until,
        }),
      }
    }
    if ('rejected' in result) {
      return { reply: encodeFrame({ type: 'rejected', rid, id, version: result.rejected }) }
    }
    return {
      reply: encodeFrame({ type: 'pushed', rid, id, version: result.version, seq: result.seq }),
      changed: encodeFrame({ type: 'changed', seq: result.seq }),
    }
  }

  private pull(rid: number | undefined, message: Record<string, unknown>): Outcome {
    const since = message['since']
    if (!isCount(since)) throw new ProtocolError('E_SYNC_BAD_MESSAGE')
    this.count({ messages: 1 })
    const rows = this.sql.all(
      'SELECT id, version, seq, kind, bytes FROM records WHERE seq > ? ORDER BY seq LIMIT ?',
      since,
      LIMITS.pullPageRecords + 1,
    )
    const records: RecordHead[] = []
    const chunks: Uint8Array[] = []
    let size = 0
    let more = rows.length > LIMITS.pullPageRecords
    for (const row of rows.slice(0, LIMITS.pullPageRecords)) {
      const bytes = num(row['bytes'])
      if (records.length > 0 && size + bytes > LIMITS.pullPageBytes) {
        more = true
        break
      }
      const id = String(row['id'])
      const own = this.sql
        .all('SELECT bytes FROM chunks WHERE id = ? ORDER BY idx', id)
        .map((c) => c['bytes'] as Uint8Array)
      records.push({
        id,
        version: num(row['version']),
        seq: num(row['seq']),
        kind: row['kind'] as RecordKind,
        chunks: own.map((c) => c.length),
      })
      chunks.push(...own)
      size += bytes
    }
    const next = records.at(-1)?.seq ?? since
    return { reply: encodeFrame({ type: 'records', rid, records, next, more }, chunks) }
  }

  private revoke(rid: number | undefined, message: Record<string, unknown>): Outcome {
    const target = message['device']
    if (!isRecordId(target)) throw new ProtocolError('E_SYNC_BAD_MESSAGE')
    const rows = this.sql.transaction(() => {
      const deleted = this.sql.run('DELETE FROM devices WHERE id = ?', target)
      this.count({ rows: deleted, messages: 1 })
      return deleted
    })
    if (rows === 0) return { reply: encodeFrame({ type: 'error', rid, code: 'E_SYNC_NO_DEVICE' }) }
    return {
      reply: encodeFrame({ type: 'revoked', rid, device: target }),
      close: revokedClose(target),
    }
  }

  private devices(current: string): DeviceInfo[] {
    return this.sql
      .all('SELECT id, label, created FROM devices ORDER BY created, id')
      .map((row) => ({
        id: String(row['id']),
        label: String(row['label']),
        created: num(row['created']),
        current: row['id'] === current,
      }))
  }

  private usage() {
    const row = this.sql.all('SELECT * FROM counters WHERE id = 1')[0] ?? {}
    return {
      day: String(row['day']),
      rowsWritten: num(row['rows_written']),
      messages: num(row['messages']),
      requests: num(row['requests']),
      storedBytes: num(row['stored_bytes']),
      fileBytes: num(row['file_bytes']),
      caps: this.quota,
    }
  }

  /** The limit a push adding `growth` stored bytes would trip; today's counts are 0 until the row's first write today. */
  private quotaLimit(growth: number, at: number) {
    if (!this.quota) return null
    const usage = this.usage()
    const today = usage.day === day(at)
    return trippedLimit(
      {
        rowsWritten: today ? usage.rowsWritten : 0,
        messages: (today ? usage.messages : 0) + this.pending.messages,
        requests: (today ? usage.requests : 0) + this.pending.requests,
        storedBytes: usage.storedBytes,
      },
      this.quota,
      growth,
    )
  }

  private head(): number {
    return num(this.sql.all('SELECT COALESCE(MAX(seq), 0) AS seq FROM records')[0]?.['seq'])
  }

  private insertDevice(device: string, hash: Uint8Array, label: string, now: number): number {
    return this.sql.run(
      'INSERT INTO devices (id, token_hash, label, created) VALUES (?, ?, ?, ?)',
      device,
      hash,
      label,
      now,
    )
  }

  /** Adds to the counters row; the row's own write counts as one more row written. */
  private count(delta: Delta): void {
    const today = day(this.now())
    const messages = (delta.messages ?? 0) + this.pending.messages
    const requests = (delta.requests ?? 0) + this.pending.requests
    this.sql.run(
      `UPDATE counters SET
        rows_written = (CASE WHEN day = ? THEN rows_written ELSE 0 END) + ?,
        messages = (CASE WHEN day = ? THEN messages ELSE 0 END) + ?,
        requests = (CASE WHEN day = ? THEN requests ELSE 0 END) + ?,
        stored_bytes = stored_bytes + ?,
        file_bytes = file_bytes + ?,
        day = ?
      WHERE id = 1`,
      today,
      (delta.rows ?? 0) + 1,
      today,
      messages,
      today,
      requests,
      delta.stored ?? 0,
      delta.files ?? 0,
      today,
    )
    this.pending = { messages: 0, requests: 0 }
  }
}
