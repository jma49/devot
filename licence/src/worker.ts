import { createApp } from './app.ts'
import { LicenceError } from './errors.ts'
import { fromBase64Url, signerFromSeed } from './format.ts'
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
  STRIPE_PRICE_RENEWAL?: string
  MANAGED_PAYMENTS?: string
  MAIL_FROM?: string
  RESEND_API_KEY?: string
  CANCEL_URL?: string
}

const REQUIRED = [
  'LICENCE_KID',
  'LICENCE_SIGNING_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_LICENCE',
  'STRIPE_PRICE_RENEWAL',
  'MAIL_FROM',
  'RESEND_API_KEY',
] as const

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      mailer: resendMailer(env.RESEND_API_KEY ?? '', env.MAIL_FROM ?? ''),
      signer: await signerFromSeed(env.LICENCE_KID ?? '', seed),
      config: {
        managedPayments: env.MANAGED_PAYMENTS === 'true',
        priceLicence: env.STRIPE_PRICE_LICENCE ?? '',
        priceRenewal: env.STRIPE_PRICE_RENEWAL ?? '',
        cancelUrl: env.CANCEL_URL || undefined,
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
