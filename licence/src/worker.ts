import { createApp } from './app.ts'
import { assetResponse } from './assets.ts'
import { LicenceError } from './errors.ts'
import { fromBase64Url, publicKeyFromSeed, signerFromSeed } from './format.ts'
import { resendMailer } from './mail.ts'
import { errorPage } from './pages.ts'
import { d1Store, type SqlDatabase } from './store.ts'
import { stripeClient } from './stripe.ts'

export interface Env {
  DB: D1Database
  LICENCE_KID?: string
  LICENCE_SIGNING_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_PRICE_LICENCE?: string
  MANAGED_PAYMENTS?: string
  MAIL_FROM?: string
  REPLY_TO?: string
  RESEND_API_KEY?: string
  CANCEL_URL?: string
  MAX_DEVICES?: string
  /** Older public keys, by kid, as a JSON object, so their licences can still activate. */
  LICENCE_KEYS?: string
}

const REQUIRED = [
  'LICENCE_KID',
  'LICENCE_SIGNING_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_LICENCE',
  'MAIL_FROM',
  'RESEND_API_KEY',
] as const
/** A licence's seats; 3 unless the Worker's variables say otherwise. */
function maxDevices(value: string | undefined): number {
  const parsed = Number(value ?? 3)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 3
}

/** The keys of earlier releases, so a licence signed by one can still take a seat. */
function olderKeys(value: string | undefined): Record<string, Uint8Array> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([kid, raw]) => {
        const key = typeof raw === 'string' ? fromBase64Url(raw) : null
        return key?.length === 32 ? [[kid, key]] : []
      }),
    )
  } catch {
    console.log('E_LICENCE_CONFIG LICENCE_KEYS')
    return {}
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The error pages' stylesheet loads even before the secrets are set.
    const asset = assetResponse(new URL(request.url).pathname, request.method)
    if (asset) return asset
    const missing = REQUIRED.filter((name) => !env[name])
    const seed = fromBase64Url(env.LICENCE_SIGNING_KEY ?? '')
    if (missing.length > 0 || seed?.length !== 32) {
      console.log(`E_LICENCE_CONFIG ${missing.join(' ') || 'LICENCE_SIGNING_KEY'}`)
      return errorPage('E_LICENCE_CONFIG', 503)
    }
    const label = new TextEncoder().encode('devot-licence rate limits')
    const app = createApp({
      store: d1Store(env.DB as unknown as SqlDatabase),
      stripe: stripeClient(env.STRIPE_SECRET_KEY ?? ''),
      mailer: resendMailer(env.RESEND_API_KEY ?? '', env.MAIL_FROM ?? '', undefined, env.REPLY_TO),
      signer: await signerFromSeed(env.LICENCE_KID ?? '', seed),
      publicKeys: {
        ...olderKeys(env.LICENCE_KEYS),
        [env.LICENCE_KID ?? '']: await publicKeyFromSeed(seed),
      },
      config: {
        managedPayments: env.MANAGED_PAYMENTS === 'true',
        priceLicence: env.STRIPE_PRICE_LICENCE ?? '',
        cancelUrl: env.CANCEL_URL || undefined,
        maxDevices: maxDevices(env.MAX_DEVICES),
        webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
      },
      rateSecret: new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array([...label, ...seed])),
      ),
      defer: (work) => ctx.waitUntil(work),
    })
    try {
      return await app(request)
    } catch (error) {
      console.log(error instanceof LicenceError ? error.code : 'E_LICENCE_INTERNAL')
      return errorPage('E_LICENCE_INTERNAL', 500)
    }
  },
} satisfies ExportedHandler<Env>
