import {
  fromBase64Url,
  PAIRING,
  type PairingState,
  toBase64Url,
} from '../../src/core/sync/protocol.ts'
import type { Reply, Sql } from './vault.ts'

// Pairings (docs/adr/0008-sync-device-pairing.md): an opening device leaves an offer sealed under
// a key the relay never sees; the joining device takes it once and leaves a sealed confirmation.
// On Cloudflare one Durable Object holds one pairing; on Node one database holds them all.

const SCHEMA = `CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  vault TEXT NOT NULL,
  device TEXT NOT NULL,
  state TEXT NOT NULL,
  offer BLOB,
  proof BLOB,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
) WITHOUT ROWID`

export type PairingOp = 'pair' | 'take' | 'confirm' | 'status' | 'close'
export const HOST_OPS: ReadonlySet<PairingOp> = new Set(['pair', 'status', 'close'])

const errorReply = (status: number, code: string): Reply => ({
  status,
  body: { v: 1, type: 'error', code },
})
const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { v: 1, ...body } })
// Unknown, expired, taken and closed look the same, so nobody learns which pairings exist.
const gone = () => errorReply(404, 'E_SYNC_PAIRING_GONE')

function sealed(text: unknown, max: number): Uint8Array<ArrayBuffer> | null {
  const bytes = fromBase64Url(text)
  return bytes && bytes.length > 0 && bytes.length <= max ? bytes : null
}

export class PairingRelay {
  private readonly sql: Sql
  private readonly now: () => number

  constructor(sql: Sql, now: () => number = Date.now) {
    this.sql = sql
    this.now = now
    this.sql.run(SCHEMA)
  }

  /** Runs one request; `device` is the opening device, checked by the front for host ops. */
  handle(op: PairingOp, id: string, body: Record<string, unknown>, device = ''): Reply {
    this.sweep()
    switch (op) {
      case 'pair':
        return this.open(id, body, device)
      case 'take':
        return this.take(id)
      case 'confirm':
        return this.confirm(id, body)
      case 'status':
        return this.status(id, body)
      case 'close':
        return this.close(id, body)
    }
  }

  /** When the last pairing here may be deleted, or null when there is none. */
  deleteAt(): number | null {
    const row = this.sql.all('SELECT MAX(expires) AS at FROM pairings')[0]
    return typeof row?.['at'] === 'number' ? row['at'] + PAIRING.graceMs : null
  }

  /** Deletes pairings past their grace; returns how many. */
  sweep(): number {
    return this.sql.run('DELETE FROM pairings WHERE expires + ? <= ?', PAIRING.graceMs, this.now())
  }

  private row(id: string, vault?: unknown) {
    const row = this.sql.all('SELECT * FROM pairings WHERE id = ?', id)[0]
    if (!row || (vault !== undefined && row['vault'] !== vault)) return undefined
    return row
  }

  private open(id: string, body: Record<string, unknown>, device: string): Reply {
    const offer = sealed(body['offer'], PAIRING.maxOfferBytes)
    if (!offer || typeof body['vault'] !== 'string') return errorReply(400, 'E_SYNC_BAD_MESSAGE')
    const now = this.now()
    const expires = now + PAIRING.ttlMs
    return this.sql.transaction(() => {
      if (this.row(id)) return errorReply(409, 'E_SYNC_PAIRING_EXISTS')
      this.sql.run(
        'INSERT INTO pairings (id, vault, device, state, offer, proof, created, expires) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        id,
        body['vault'] as string,
        device,
        'open' satisfies PairingState,
        offer,
        now,
        expires,
      )
      return ok({ type: 'pairing', state: 'open', expires, time: now })
    })
  }

  private take(id: string): Reply {
    return this.sql.transaction(() => {
      const row = this.row(id)
      if (!row || row['state'] !== 'open' || this.now() >= Number(row['expires'])) return gone()
      this.sql.run("UPDATE pairings SET state = 'taken', offer = NULL WHERE id = ?", id)
      return ok({ type: 'offer', offer: toBase64Url(row['offer'] as Uint8Array) })
    })
  }

  private confirm(id: string, body: Record<string, unknown>): Reply {
    const proof = sealed(body['proof'], PAIRING.maxProofBytes)
    if (!proof) return errorReply(400, 'E_SYNC_BAD_MESSAGE')
    return this.sql.transaction(() => {
      const row = this.row(id)
      if (!row || row['state'] !== 'taken') return gone()
      this.sql.run("UPDATE pairings SET state = 'confirmed', proof = ? WHERE id = ?", proof, id)
      return ok({ type: 'confirmed' })
    })
  }

  private status(id: string, body: Record<string, unknown>): Reply {
    const row = this.row(id, body['vault'])
    if (!row) return gone()
    const state = row['state'] as PairingState
    const proof = row['proof'] instanceof Uint8Array ? toBase64Url(row['proof']) : undefined
    return ok({
      type: 'pairing',
      state,
      expires: Number(row['expires']),
      time: this.now(),
      ...(proof ? { proof } : {}),
    })
  }

  private close(id: string, body: Record<string, unknown>): Reply {
    if (!this.row(id, body['vault'])) return gone()
    this.sql.run('DELETE FROM pairings WHERE id = ?', id)
    return ok({ type: 'closed' })
  }
}
