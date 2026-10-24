// The sync relay's wire format (docs/sync-relay.md), shared by the relay
// (relay/) and the client. Self-contained with explicit-extension imports
// only: the Node relay runs this file through Node's type stripping.

export const PROTOCOL_VERSION = 1
/** The WebSocket subprotocol a client offers and the relay selects. */
export const SUBPROTOCOL = `devot-relay.${PROTOCOL_VERSION}`
/** A second offered subprotocol, `devot-token.<device token>`, carries the token: a web view's WebSocket cannot set headers. */
export const TOKEN_SUBPROTOCOL_PREFIX = 'devot-token.'

export const LIMITS = {
  /** A record's ciphertext is cut into chunks of at most this size, so each fits one Durable Object row. */
  maxChunkBytes: 1_900_000,
  /** 16 chunks keep one push under the Workers 32 MiB WebSocket message limit. */
  maxChunks: 16,
  maxMessageBytes: 31 * 1024 * 1024,
  pullPageRecords: 100,
  pullPageBytes: 16 * 1024 * 1024,
  maxLabelLength: 256,
  maxHttpBodyBytes: 4096,
} as const

export const CLOSE = {
  /** The device's token is unknown to the vault (revoked, or from before a relay reset with the vault still there). */
  unauthorized: 4001,
  /** The device was revoked while connected. */
  revoked: 4003,
  /** The vault does not exist (never created, or the relay lost its data). */
  noVault: 4004,
} as const

export type RecordKind = 'record' | 'file'

export interface RecordHead {
  id: string
  version: number
  seq: number
  kind: RecordKind
  /** Byte length of each chunk, in order; the frame's payload holds the chunks back to back. */
  chunks: number[]
}

export interface DeviceInfo {
  id: string
  label: string
  created: number
  current: boolean
}

export interface Usage {
  /** UTC day (YYYY-MM-DD) the daily counters belong to. */
  day: string
  rowsWritten: number
  messages: number
  requests: number
  storedBytes: number
  fileBytes: number
}

export type ClientMessage =
  | { type: 'pull'; rid?: number; since: number }
  | { type: 'push'; rid?: number; id: string; base: number; kind: RecordKind; chunks: number[] }
  | { type: 'devices'; rid?: number }
  | { type: 'revoke'; rid?: number; device: string }
  | { type: 'time'; rid?: number }
  | { type: 'usage'; rid?: number }

export type RelayMessage =
  | { type: 'welcome'; time: number; epoch: string; seq: number; device: string }
  | { type: 'records'; rid?: number; records: RecordHead[]; next: number; more: boolean }
  | { type: 'pushed'; rid?: number; id: string; version: number; seq: number }
  | { type: 'rejected'; rid?: number; id: string; version: number }
  | { type: 'changed'; seq: number }
  | { type: 'devices'; rid?: number; devices: DeviceInfo[] }
  | { type: 'revoked'; rid?: number; device: string }
  | { type: 'time'; rid?: number; time: number }
  | ({ type: 'usage'; rid?: number } & Usage)
  | { type: 'error'; rid?: number; code: string; retryAfter?: number }

/** HTTP bodies: vault creation and device enrollment, and the relay's answers. */
export interface CreateRequest {
  type: 'create'
  /** base64url of the 32-byte verifier of the enrollment secret (enrollmentVerifier). */
  verifier: string
  label: string
}
export interface EnrollRequest {
  type: 'enroll'
  /** base64url of the 32-byte enrollment secret the client derives from the vault key. */
  secret: string
  label: string
}
export interface EnrolledReply {
  type: 'enrolled'
  epoch: string
  device: string
  token: string
  time: number
}

export interface Frame<T> {
  message: T
  payload: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/** A message with chunks travels as one binary frame: a 4-byte big-endian header length, the JSON header, then the chunks. */
export function encodeFrame(
  message: object,
  chunks: readonly Uint8Array[] = [],
): string | Uint8Array<ArrayBuffer> {
  const header = JSON.stringify({ v: PROTOCOL_VERSION, ...message })
  if (chunks.length === 0) return header
  const head = encoder.encode(header)
  const total = 4 + head.length + chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  let at = 4 + head.length
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export class ProtocolError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** Reads a frame's header and payload; throws ProtocolError with E_SYNC_BAD_MESSAGE or E_SYNC_PROTOCOL. */
export function decodeFrame(
  data: string | ArrayBuffer | Uint8Array,
): Frame<Record<string, unknown>> {
  let header: string
  let payload: Uint8Array = new Uint8Array(0)
  if (typeof data === 'string') {
    header = data
  } else {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    if (bytes.length < 4) throw new ProtocolError('E_SYNC_BAD_MESSAGE')
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    if (length > bytes.length - 4) throw new ProtocolError('E_SYNC_BAD_MESSAGE')
    try {
      header = decoder.decode(bytes.subarray(4, 4 + length))
    } catch {
      throw new ProtocolError('E_SYNC_BAD_MESSAGE')
    }
    payload = bytes.subarray(4 + length)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(header)
  } catch {
    throw new ProtocolError('E_SYNC_BAD_MESSAGE')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('E_SYNC_BAD_MESSAGE')
  }
  const message = parsed as Record<string, unknown>
  if (message['v'] !== PROTOCOL_VERSION) throw new ProtocolError('E_SYNC_PROTOCOL')
  if (typeof message['type'] !== 'string') throw new ProtocolError('E_SYNC_BAD_MESSAGE')
  return { message, payload }
}

/** Splits a frame's payload into the chunks its header lists; throws when the lengths do not add up. */
export function splitChunks(payload: Uint8Array, lengths: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = []
  let at = 0
  for (const length of lengths) {
    chunks.push(payload.subarray(at, at + length))
    at += length
  }
  if (at !== payload.length) throw new ProtocolError('E_SYNC_BAD_MESSAGE')
  return chunks
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const VAULT_ID = /^[A-Za-z0-9_-]{16,64}$/

export const isRecordId = (value: unknown): value is string =>
  typeof value === 'string' && ID.test(value)
export const isVaultId = (value: unknown): value is string =>
  typeof value === 'string' && VAULT_ID.test(value)
export const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const isLabel = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= LIMITS.maxLabelLength

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decodes base64url without padding; null for anything else. */
export function fromBase64Url(text: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    return null
  }
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return toBase64Url(bytes) === text ? bytes : null
}

const VERIFIER_LABEL = encoder.encode('devot-relay enrollment verifier v1')

/** What the relay stores in place of the enrollment secret: SHA-256 over a label and the secret. */
export async function enrollmentVerifier(secret: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(VERIFIER_LABEL.length + secret.length)
  input.set(VERIFIER_LABEL)
  input.set(secret, VERIFIER_LABEL.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}
