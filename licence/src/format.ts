/**
 * Licence keys and the revocation list (docs/licensing.md, Formats): `<prefix>.<payload>.<signature>`,
 * the payload base64url JSON, the signature Ed25519 over the ASCII bytes of `<prefix>.<payload>`.
 */

export const LICENCE_PREFIX = 'devot1'
export const REVOCATIONS_PREFIX = 'devot1rev'
export const PLAN = 'pro'

export interface LicencePayload {
  id: string
  kid: string
  plan: typeof PLAN
  licensee: string
  issuedAt: string
}

export interface RevocationsPayload {
  kid: string
  issuedAt: string
  ids: string[]
}

export type VerifyCode = 'E_LICENCE_MALFORMED' | 'E_LICENCE_UNKNOWN_KID' | 'E_LICENCE_SIGNATURE'

export type Verified<T> = { ok: true; payload: T } | { ok: false; code: VerifyCode }

export interface Signer {
  readonly kid: string
  sign(message: Uint8Array): Promise<Uint8Array>
}

export const LICENCE_ID = /^[A-Za-z0-9_-]{22}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const MAX_LENGTH = 1024
const MAX_REVOCATIONS_LENGTH = 16 * 1024 * 1024
const ED25519 = { name: 'Ed25519' }
// PKCS #8 wrapping of a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return toBase64Url(bytes) === text ? bytes : null
}

export function newLicenceId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
}

/** RFC 3339 in UTC to the second, as `issuedAt` carries it. */
export function instant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function signerFromSeed(kid: string, seed: Uint8Array): Promise<Signer> {
  const key = await importSeed(seed, false)
  return {
    kid,
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign(ED25519, key, message as BufferSource)),
  }
}

export async function publicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  const jwk = (await crypto.subtle.exportKey('jwk', await importSeed(seed, true))) as JsonWebKey
  const raw = fromBase64Url(jwk.x ?? '')
  if (!raw) throw new Error('E_LICENCE_CONFIG')
  return raw
}

async function importSeed(seed: Uint8Array, extractable: boolean): Promise<CryptoKey> {
  if (seed.length !== 32) throw new Error('E_LICENCE_CONFIG')
  const pkcs8 = new Uint8Array([...PKCS8_PREFIX, ...seed])
  return crypto.subtle.importKey('pkcs8', pkcs8, ED25519, extractable, ['sign'])
}

export function signLicence(
  signer: Signer,
  fields: Omit<LicencePayload, 'kid' | 'plan'>,
): Promise<string> {
  const payload: LicencePayload = {
    id: fields.id,
    kid: signer.kid,
    plan: PLAN,
    licensee: fields.licensee,
    issuedAt: fields.issuedAt,
  }
  return signEnvelope(LICENCE_PREFIX, signer, payload)
}

export function signRevocations(
  signer: Signer,
  fields: Omit<RevocationsPayload, 'kid'>,
): Promise<string> {
  const payload: RevocationsPayload = {
    kid: signer.kid,
    issuedAt: fields.issuedAt,
    ids: [...fields.ids].sort(),
  }
  return signEnvelope(REVOCATIONS_PREFIX, signer, payload)
}

async function signEnvelope(prefix: string, signer: Signer, payload: object): Promise<string> {
  const signed = `${prefix}.${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`
  const signature = await signer.sign(new TextEncoder().encode(signed))
  return `${signed}.${toBase64Url(signature)}`
}

/**
 * Checks a key against the public keys by `kid`; the reference for the app's own check. Fields it
 * does not know are kept in the payload and otherwise ignored.
 */
export function verifyLicence(
  key: string,
  publicKeys: Readonly<Record<string, Uint8Array>>,
): Promise<Verified<LicencePayload>> {
  return verifyEnvelope(key, LICENCE_PREFIX, MAX_LENGTH, publicKeys, isLicencePayload)
}

export function verifyRevocations(
  list: string,
  publicKeys: Readonly<Record<string, Uint8Array>>,
): Promise<Verified<RevocationsPayload>> {
  return verifyEnvelope(list, REVOCATIONS_PREFIX, MAX_REVOCATIONS_LENGTH, publicKeys, isRevocations)
}

async function verifyEnvelope<T extends { kid: string }>(
  text: string,
  prefix: string,
  maxLength: number,
  publicKeys: Readonly<Record<string, Uint8Array>>,
  isPayload: (value: unknown) => value is T,
): Promise<Verified<T>> {
  const malformed = { ok: false, code: 'E_LICENCE_MALFORMED' } as const
  if (text.length > maxLength) return malformed
  const parts = text.split('.')
  if (parts.length !== 3 || parts[0] !== prefix) return malformed
  const bytes = fromBase64Url(parts[1] ?? '')
  const signature = fromBase64Url(parts[2] ?? '')
  if (!bytes || signature?.length !== 64) return malformed
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return malformed
  }
  if (!isPayload(payload)) return malformed
  const raw = Object.hasOwn(publicKeys, payload.kid) ? publicKeys[payload.kid] : undefined
  if (!raw) return { ok: false, code: 'E_LICENCE_UNKNOWN_KID' }
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, ED25519, false, ['verify'])
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const valid = await crypto.subtle.verify(ED25519, key, signature as BufferSource, signed)
  return valid ? { ok: true, payload } : { ok: false, code: 'E_LICENCE_SIGNATURE' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLicencePayload(value: unknown): value is LicencePayload {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    LICENCE_ID.test(value['id']) &&
    typeof value['kid'] === 'string' &&
    value['plan'] === PLAN &&
    typeof value['licensee'] === 'string' &&
    value['licensee'].length > 0 &&
    typeof value['issuedAt'] === 'string' &&
    INSTANT.test(value['issuedAt'])
  )
}

function isRevocations(value: unknown): value is RevocationsPayload {
  return (
    isRecord(value) &&
    typeof value['kid'] === 'string' &&
    typeof value['issuedAt'] === 'string' &&
    INSTANT.test(value['issuedAt']) &&
    Array.isArray(value['ids']) &&
    value['ids'].every((id) => typeof id === 'string' && LICENCE_ID.test(id))
  )
}
