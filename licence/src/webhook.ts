/** Stripe's webhook signature scheme: https://docs.stripe.com/webhooks#verify-manually */

export const WEBHOOK_TOLERANCE_SECONDS = 300

export async function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!header) return false
  let timestamp: string | undefined
  const signatures: Uint8Array[] = []
  for (const part of header.split(',')) {
    const at = part.indexOf('=')
    const name = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (name === 't') timestamp = value
    if (name === 'v1') {
      const bytes = fromHex(value)
      if (bytes) signatures.push(bytes)
    }
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const signed = new TextEncoder().encode(`${timestamp}.${body}`)
  // HMAC verify compares in constant time.
  for (const signature of signatures) {
    if (await crypto.subtle.verify('HMAC', key, signature as BufferSource, signed)) return true
  }
  return false
}

/** Builds a `Stripe-Signature` header, as Stripe would, for tests and local tools. */
export async function signStripePayload(
  body: string,
  secret: string,
  timestamp: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)),
  )
  return `t=${timestamp},v1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

function fromHex(text: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(text)) return null
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}
