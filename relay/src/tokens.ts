import { fromBase64Url, toBase64Url } from '../../src/core/sync/protocol.ts'

// Device tokens are `<device>.<random>.<mac>`. The MAC, keyed from the relay's
// secret and bound to the vault, lets the front (the Worker) refuse a forged
// token before anything reaches the vault's storage; the vault keeps only the
// token's SHA-256, so a token it no longer knows (revoked) fails there.

const encoder = new TextEncoder()
const MAC_LABEL = encoder.encode('devot-relay token mac v1')
/** RELAY_SECRET must be at least this long; the docs make one with `openssl rand -base64 32`. */
export const MIN_SECRET_LENGTH = 32

const keys = new Map<string, Promise<CryptoKey>>()

function macKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const derived = await crypto.subtle.sign('HMAC', base, MAC_LABEL)
      return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
        'verify',
      ])
    })()
    keys.set(secret, key)
  }
  return key
}

export const validSecret = (secret: unknown): secret is string =>
  typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH

export const randomId = (bytes = 16) => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))

export async function sha256(input: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array> {
  const data = typeof input === 'string' ? encoder.encode(input) : input
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/** Whether `presented` is the relay secret, compared through their hashes in constant time. */
export async function isRelaySecret(secret: string, presented: string): Promise<boolean> {
  return sameBytes(await sha256(secret), await sha256(presented))
}

export async function issueToken(
  secret: string,
  vault: string,
  device: string,
): Promise<{ token: string; hash: Uint8Array }> {
  const body = `${device}.${randomId(32)}`
  const mac = await crypto.subtle.sign(
    'HMAC',
    await macKey(secret),
    encoder.encode(`${vault}.${body}`),
  )
  const token = `${body}.${toBase64Url(new Uint8Array(mac))}`
  return { token, hash: await sha256(token) }
}

/** The device a token names, when its MAC holds for this vault; else null. */
export async function tokenDevice(
  secret: string,
  vault: string,
  token: string,
): Promise<string | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [device = '', random = '', macText = ''] = parts
  const mac = fromBase64Url(macText)
  if (!device || !random || !mac || mac.length !== 32) return null
  const ok = await crypto.subtle.verify(
    'HMAC',
    await macKey(secret),
    mac,
    encoder.encode(`${vault}.${device}.${random}`),
  )
  return ok ? device : null
}
