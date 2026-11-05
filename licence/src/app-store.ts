/**
 * The App Store side of the licence Worker (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md):
 * what a verified transaction must say to get a licence, and Apple's App Store Server API.
 */
import type { LicenceCode } from './errors.ts'
import { toBase64Url } from './format.ts'

export type AppStoreEnvironment = 'Production' | 'Sandbox'

export interface AppStoreConfig {
  bundleId: string
  /** Devot Pro's product ID: the one product that gets a licence. */
  productPro: string
}

/**
 * Sandbox purchases cost nothing, so their keys are signed with the public test seed
 * (licence/test-vectors.json) under the kid no release and no production ring trusts.
 */
export const SANDBOX_KID = 'test'
export const SANDBOX_SEED = 'f3dmyFPtCJPedpLOz8vMoXZ3GWgVOGcNytUglOoUR4w'

/**
 * The keys a licence key is checked against. `licenceFor` trusts every kid here, so the test kid
 * that signs sandbox purchases stays out unless this Worker itself signs under it, whatever
 * LICENCE_KEYS lists.
 */
export function publicKeyRing(
  kid: string,
  own: Uint8Array,
  older: Record<string, Uint8Array>,
): Record<string, Uint8Array> {
  const ring: Record<string, Uint8Array> = {}
  for (const [name, key] of Object.entries(older)) {
    if (name !== SANDBOX_KID || kid === SANDBOX_KID) ring[name] = key
  }
  ring[kid] = own
  return ring
}

/** The free Trial's product ID: never a licence, whatever the Worker's variables say. */
export const TRIAL_PRODUCT = 'io.github.jma49.devot.trial'

/** The fields of a JWSTransactionDecodedPayload the Worker decides on. */
export interface Transaction {
  transactionId: string
  originalTransactionId: string
  bundleId: string
  productId: string
  type: string
  ownership: string
  environment: string
  originalPurchaseDate: number | null
  revoked: boolean
}

const TRANSACTION_ID = /^\d{1,20}$/
/** The furthest instant a JavaScript Date holds. */
const MAX_DATE_MS = 8.64e15

export function readTransaction(payload: Record<string, unknown> | null): Transaction | null {
  if (!payload) return null
  const text = (key: string) => (typeof payload[key] === 'string' ? payload[key] : null)
  const transactionId = text('transactionId')
  const originalTransactionId = text('originalTransactionId')
  const originalPurchaseDate = payload['originalPurchaseDate']
  if (
    !transactionId ||
    !originalTransactionId ||
    !TRANSACTION_ID.test(transactionId) ||
    !TRANSACTION_ID.test(originalTransactionId)
  ) {
    return null
  }
  return {
    transactionId,
    originalTransactionId,
    bundleId: text('bundleId') ?? '',
    productId: text('productId') ?? '',
    type: text('type') ?? '',
    ownership: text('inAppOwnershipType') ?? '',
    environment: text('environment') ?? '',
    originalPurchaseDate:
      typeof originalPurchaseDate === 'number' &&
      Number.isSafeInteger(originalPurchaseDate) &&
      Math.abs(originalPurchaseDate) <= MAX_DATE_MS
        ? originalPurchaseDate
        : null,
    revoked: payload['revocationDate'] !== undefined && payload['revocationDate'] !== null,
  }
}

export const isEnvironment = (value: unknown): value is AppStoreEnvironment =>
  value === 'Production' || value === 'Sandbox'

/**
 * Why a transaction cannot get a licence, or null: this app's Devot Pro, never the Trial, a
 * non-consumable bought by this Apple account in Apple's store or its sandbox. Revocation is
 * decided apart, on Apple's own answer.
 */
export function refusal(t: Transaction, config: AppStoreConfig): LicenceCode | null {
  if (t.bundleId !== config.bundleId) return 'E_APP_STORE_PRODUCT'
  if (t.productId !== config.productPro || t.productId === TRIAL_PRODUCT) {
    return 'E_APP_STORE_PRODUCT'
  }
  if (t.type !== 'Non-Consumable') return 'E_APP_STORE_PRODUCT'
  if (t.ownership === 'FAMILY_SHARED') return 'E_APP_STORE_FAMILY_SHARED'
  if (t.ownership !== 'PURCHASED') return 'E_APP_STORE_PRODUCT'
  if (!isEnvironment(t.environment)) return 'E_APP_STORE_PRODUCT'
  return null
}

/**
 * Apple's answer to Get Transaction Info. `unreachable` is a network failure, a 5xx or a 429
 * alone; `config` is Apple refusing the Worker's own token, which no caller can cause.
 */
export type AppleAnswer =
  | { status: 'found'; signedTransactionInfo: string }
  | { status: 'not-found' }
  | { status: 'unreachable'; detail: string }
  | { status: 'config'; detail: string }

export interface AppleApi {
  transaction(environment: AppStoreEnvironment, transactionId: string): Promise<AppleAnswer>
}

export const APPLE_HOSTS: Record<AppStoreEnvironment, string> = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
}

export interface AppleApiOptions {
  /** The In-App Purchase key's `.p8`: PKCS #8 PEM. */
  key: string
  keyId: string
  issuerId: string
  bundleId: string
  fetch?: (request: Request) => Promise<Response>
  now?: () => Date
  timeoutMs?: number
}

const TOKEN_SECONDS = 300

export function pemToPkcs8(pem: string): Uint8Array | null {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  try {
    const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

/** The ES256 JWT App Store Server API calls are authorised with. */
export async function appleToken(
  key: CryptoKey,
  options: Pick<AppleApiOptions, 'keyId' | 'issuerId' | 'bundleId'>,
  now: Date,
): Promise<string> {
  const encode = (value: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)))
  const iat = Math.floor(now.getTime() / 1000)
  const signed = `${encode({ alg: 'ES256', kid: options.keyId, typ: 'JWT' })}.${encode({
    iss: options.issuerId,
    iat,
    exp: iat + TOKEN_SECONDS,
    aud: 'appstoreconnect-v1',
    bid: options.bundleId,
  })}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signed) as BufferSource,
  )
  return `${signed}.${toBase64Url(new Uint8Array(signature))}`
}

export function appleApi(options: AppleApiOptions): AppleApi {
  const send = options.fetch ?? ((request: Request) => fetch(request))
  const now = options.now ?? (() => new Date())
  let key: Promise<CryptoKey | null> | undefined
  const signingKey = () =>
    (key ??= (async () => {
      const pkcs8 = pemToPkcs8(options.key)
      if (!pkcs8) return null
      try {
        return await crypto.subtle.importKey(
          'pkcs8',
          pkcs8 as BufferSource,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['sign'],
        )
      } catch {
        return null
      }
    })())

  return {
    async transaction(environment, transactionId) {
      if (!TRANSACTION_ID.test(transactionId)) return { status: 'not-found' }
      const signer = await signingKey()
      if (!signer) return { status: 'config', detail: 'APP_STORE_KEY' }
      const token = await appleToken(signer, options, now())
      let response: Response
      try {
        response = await send(
          new Request(`${APPLE_HOSTS[environment]}/inApps/v1/transactions/${transactionId}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          }),
        )
      } catch {
        return { status: 'unreachable', detail: 'network' }
      }
      if (response.status === 200) {
        const body: unknown = await response.json().catch(() => null)
        const info = (body as { signedTransactionInfo?: unknown } | null)?.signedTransactionInfo
        return { status: 'found', signedTransactionInfo: typeof info === 'string' ? info : '' }
      }
      await response.body?.cancel()
      if (response.status === 429 || response.status >= 500) {
        return { status: 'unreachable', detail: String(response.status) }
      }
      if (response.status === 401 || response.status === 403) {
        return { status: 'config', detail: String(response.status) }
      }
      return { status: 'not-found' }
    },
  }
}
