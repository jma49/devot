// The moved marker (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md): an ordinary
// sealed record of kind `record` under a reserved ID, left on the transport a vault leaves, whose
// body names the transport it went to. It is not a new kind, since a relay refuses any kind but
// `record` and `file`, and a relay that was not updated is where the marker matters most. Builds
// from before it cannot decode its body (E_SYNC_RECORD_INVALID) and skip it as a record a newer
// Devot may read.

import { RECORD_FORMAT } from './records'
import type { SyncTransport, TransportName } from './transport'

/** A valid UUIDv7 whose time is 0, so no device ever makes it for a note. */
export const MOVED_ID = '00000000-0000-7000-8000-000000000000'

const KIND = 'moved'
const NAMES: readonly TransportName[] = ['relay', 'icloud']
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Framed as every record is: `format || header length (u32, big-endian) || JSON header`. */
export function encodeMoved(to: TransportName): Uint8Array {
  const head = encoder.encode(JSON.stringify({ id: MOVED_ID, kind: KIND, to }))
  const out = new Uint8Array(5 + head.length)
  out[0] = RECORD_FORMAT
  new DataView(out.buffer).setUint32(1, head.length)
  out.set(head, 5)
  return out
}

/** The transport a marker names; throws E_SYNC_MOVED_INVALID for a body this build cannot read. */
export function readMoved(bytes: Uint8Array): TransportName {
  const invalid = () => new Error('E_SYNC_MOVED_INVALID')
  if (bytes.length < 5 || bytes[0] !== RECORD_FORMAT) throw invalid()
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1)
  if (length !== bytes.length - 5) throw invalid()
  let header: unknown
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(5)))
  } catch {
    throw invalid()
  }
  const h = (typeof header === 'object' && header !== null ? header : {}) as Record<string, unknown>
  const to = NAMES.find((name) => name === h['to'])
  if (h['id'] !== MOVED_ID || h['kind'] !== KIND || !to) throw invalid()
  return to
}

const MARK_TRIES = 5

/**
 * Leaves the marker on `transport`, the one the vault leaves, naming `to`. A marker already there
 * (a vault that moved before) is written over: its body needs no merge.
 */
export async function leaveMovedMarker(transport: SyncTransport, to: TransportName): Promise<void> {
  let base = 0
  let tag = ''
  for (let tries = 0; tries < MARK_TRIES; tries += 1) {
    const result = await transport.push(MOVED_ID, base, encodeMoved(to), 'record', tag)
    if (result.type === 'pushed') return
    if (result.type !== 'rejected') {
      throw new Error(result.type === 'failed' ? result.code : 'E_SYNC_MOVED_REFUSED')
    }
    base = result.version
    tag = result.tag
  }
  throw new Error('E_SYNC_MOVED_REFUSED')
}
