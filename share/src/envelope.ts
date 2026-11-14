// The sealed page (docs/specs/share-on-web.md, The sealed page). `openEnvelope` is shipped to the
// browser as written (viewer.ts), so it uses only Web Crypto and refers to nothing outside itself.

export const MAGIC = 'DVS1'
export const NONCE_BYTES = 12
export const KEY_BYTES = 32

export interface SharedPage {
  title: string
  html: string
}

/** Opens an envelope with a base64url key; null for any key, bytes or plaintext that do not fit. */
export async function openEnvelope(bytes: Uint8Array, key: string): Promise<SharedPage | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || bytes.length < 4 + 12 + 16) return null
  const magic = new Uint8Array([0x44, 0x56, 0x53, 0x31])
  for (let i = 0; i < 4; i++) if (bytes[i] !== magic[i]) return null
  const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) =>
    c.charCodeAt(0),
  )
  if (raw.length !== 32) return null
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(4, 16), additionalData: magic },
      cryptoKey,
      bytes.slice(16),
    )
    const page: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plain),
    )
    if (typeof page !== 'object' || page === null) return null
    const { v, title, html } = page as Record<string, unknown>
    if (v !== 1 || typeof title !== 'string' || typeof html !== 'string') return null
    return { title, html }
  } catch {
    return null
  }
}
