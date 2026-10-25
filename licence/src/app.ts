import { assetResponse } from './assets.ts'
import { type CheckoutConfig, checkoutParams, LICENCE_KIND } from './checkout.ts'
import { type LicenceCode, LicenceError } from './errors.ts'
import { instant, newLicenceId, type Signer, signLicence, signRevocations } from './format.ts'
import { licenceMail, type Mailer } from './mail.ts'
import { donePage, errorPage, pendingPage, resendPage, resentPage } from './pages.ts'
import type { Fulfilled, Licence, Store } from './store.ts'
import { type CheckoutSession, type StripeClient, toSession } from './stripe.ts'
import { verifyStripeSignature } from './webhook.ts'

export interface AppConfig extends CheckoutConfig {
  webhookSecret: string
}

export interface AppDeps {
  store: Store
  stripe: StripeClient
  mailer: Mailer
  signer: Signer
  config: AppConfig
  /** Keys the hashes `/resend` counts addresses and IPs under, so no address is stored. */
  rateSecret: Uint8Array
  /** Runs work after the answer has gone (the Worker's `waitUntil`). */
  defer: (work: Promise<unknown>) => void
  now?: () => Date
  /** One line per event: a code and IDs, never an address or a key. */
  log?: (line: string) => void
}

export const LIMITS = {
  resendPerAddress: 3,
  resendPerIp: 10,
  resendWindowSeconds: 3600,
  webhookBytes: 512 * 1024,
  formBytes: 4 * 1024,
}

const SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]+\.[^\s@<>"]+$/

const STATUS: Partial<Record<LicenceCode, number>> = {
  E_LICENCE_BAD_REQUEST: 400,
  E_LICENCE_CONFIG: 503,
  E_LICENCE_MAIL: 502,
  E_LICENCE_METHOD: 405,
  E_LICENCE_NO_CUSTOMER: 409,
  E_LICENCE_NOT_FOUND: 404,
  E_LICENCE_REVOKED: 410,
  E_LICENCE_SESSION_UNKNOWN: 404,
  E_LICENCE_STRIPE: 502,
  E_LICENCE_TOO_LARGE: 413,
  E_LICENCE_WEBHOOK_SIGNATURE: 400,
}

export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  const { store, stripe, mailer, signer, config } = deps
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((line: string) => console.log(line))

  const fail = (error: unknown, id?: string): LicenceCode => {
    const code = error instanceof LicenceError ? error.code : 'E_LICENCE_INTERNAL'
    const detail = error instanceof LicenceError ? error.detail : undefined
    log([code, id, detail].filter(Boolean).join(' '))
    return code
  }

  async function checkout(origin: string): Promise<Response> {
    const session = await stripe.createCheckoutSession(checkoutParams(config, origin))
    return new Response(null, { status: 303, headers: { Location: session.url } })
  }

  /** Records a paid session's licence, once. */
  async function fulfil(session: CheckoutSession): Promise<Fulfilled> {
    if (!session.customer) throw new LicenceError('E_LICENCE_NO_CUSTOMER', session.id)
    const issued = await store.issue({
      sessionId: session.id,
      licenceId: newLicenceId(),
      customerId: session.customer,
      paymentIntent: session.paymentIntent,
      at: instant(now()),
    })
    if (issued.created && issued.licence.revokedAt) {
      log(`E_LICENCE_REVOKED ${issued.licence.id} ${session.id}`)
    } else if (issued.created) {
      log(`I_LICENCE_ISSUED ${issued.licence.id} ${session.id}`)
    }
    return issued
  }

  /**
   * The licensee is the email of the Stripe customer who bought the licence; once that
   * customer is deleted or has no address, the one `fallback` gives (the paying session's).
   */
  async function licensee(
    licence: Licence,
    session?: CheckoutSession,
    fallback: () => Promise<string | null> = async () => session?.email ?? null,
  ): Promise<string> {
    if (session?.email && session.customer === licence.customerId) return session.email
    const email = (await stripe.retrieveCustomer(licence.customerId))?.email ?? (await fallback())
    if (!email) throw new LicenceError('E_LICENCE_NO_CUSTOMER', licence.id)
    return email
  }

  function keyFor(licence: Licence, email: string): Promise<string> {
    return signLicence(signer, { id: licence.id, licensee: email, issuedAt: licence.issuedAt })
  }

  async function mailOnce(fulfilled: Fulfilled, session: CheckoutSession): Promise<void> {
    const { purchase, licence } = fulfilled
    if (purchase.mailedAt || licence.revokedAt) return
    const owner = await licensee(licence, session)
    const key = await keyFor(licence, owner)
    const mail = licenceMail(
      session.email ?? owner,
      'issued',
      [key],
      `issued/${purchase.sessionId}`,
    )
    // /done and the webhook, or two deliveries of one event, can get here together: one sends.
    if (!(await store.claimMail(purchase.sessionId, instant(now())))) return
    try {
      await mailer.send(mail)
    } catch (error) {
      await store.releaseMail(purchase.sessionId)
      throw error
    }
    log(`I_LICENCE_MAILED ${licence.id} ${purchase.sessionId}`)
  }

  async function webhook(request: Request): Promise<Response> {
    const body = await readBody(request, LIMITS.webhookBytes)
    const signature = request.headers.get('Stripe-Signature')
    const seconds = Math.floor(now().getTime() / 1000)
    if (!(await verifyStripeSignature(body, signature, config.webhookSecret, seconds))) {
      log('E_LICENCE_WEBHOOK_SIGNATURE')
      return json({ code: 'E_LICENCE_WEBHOOK_SIGNATURE' }, 400)
    }
    let event: { id?: unknown; type?: unknown; data?: { object?: unknown } }
    try {
      event = JSON.parse(body)
    } catch {
      return json({ code: 'E_LICENCE_BAD_REQUEST' }, 400)
    }
    const object = event.data?.object as Record<string, unknown> | undefined
    try {
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          const session = toSession(object)
          if (session?.mode !== 'payment' || session.paymentStatus !== 'paid') break
          // The account may sell other things: only this Worker's sessions issue a licence.
          if (!ours(session)) break
          await mailOnce(await fulfil(session), session)
          break
        }
        case 'charge.refunded':
          if (object?.['refunded'] === true) await revoke(object['payment_intent'], 'refund')
          break
        case 'charge.dispute.closed':
          if (object?.['status'] === 'lost') await revoke(object['payment_intent'], 'dispute')
          break
      }
    } catch (error) {
      const code = fail(error, typeof event.id === 'string' ? event.id : undefined)
      return json({ code }, 500)
    }
    return json({ received: true }, 200)
  }

  async function revoke(paymentIntent: unknown, reason: string): Promise<void> {
    const id = typeof paymentIntent === 'string' ? paymentIntent : expandedId(paymentIntent)
    if (!id) return
    const revokedId = await store.revokeByPayment(id, instant(now()))
    log(
      revokedId
        ? `I_LICENCE_REVOKED ${revokedId} ${reason}`
        : `I_LICENCE_PAYMENT_REVOKED ${id} ${reason}`,
    )
  }

  async function done(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get('session_id') ?? ''
    if (!SESSION_ID.test(sessionId)) return errorPage('E_LICENCE_BAD_REQUEST', 400)
    let purchase = await store.purchase(sessionId)
    let session: CheckoutSession | undefined
    if (!purchase) {
      // The buyer can arrive before the webhook: fulfil from the session itself.
      const fetched = await stripe.retrieveCheckoutSession(sessionId)
      if (!fetched || fetched.mode !== 'payment' || !ours(fetched)) {
        return errorPage('E_LICENCE_SESSION_UNKNOWN', 404)
      }
      if (fetched.paymentStatus !== 'paid') return pendingPage()
      session = fetched
      const fulfilled = await fulfil(fetched)
      deps.defer(mailOnce(fulfilled, fetched).catch((error: unknown) => fail(error, sessionId)))
      purchase = fulfilled.purchase
    }
    const licence = await store.licence(purchase.licenceId)
    if (!licence) throw new LicenceError('E_LICENCE_INTERNAL', sessionId)
    if (licence.revokedAt) return errorPage('E_LICENCE_REVOKED', 410)
    const paid = async () =>
      (session ?? (await stripe.retrieveCheckoutSession(sessionId)))?.email ?? null
    const key = await keyFor(licence, await licensee(licence, session, paid))
    return donePage(key)
  }

  async function rateKey(kind: string, value: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      deps.rateSecret as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${kind}:${value}`)),
    )
    return `${kind}:${[...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  }

  async function resend(request: Request): Promise<Response> {
    const form = new URLSearchParams(await readBody(request, LIMITS.formBytes))
    const email = (form.get('email') ?? '').trim()
    if (email.length > 254 || !EMAIL.test(email)) return errorPage('E_LICENCE_BAD_REQUEST', 400)
    const window = Math.floor(now().getTime() / 1000 / LIMITS.resendWindowSeconds)
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const [byAddress, byIp] = await Promise.all([
      store.hit(await rateKey('address', email.toLowerCase()), window),
      store.hit(await rateKey('ip', ip), window),
    ])
    if (byAddress <= LIMITS.resendPerAddress && byIp <= LIMITS.resendPerIp) {
      deps.defer(
        mailAll(
          email,
          `${await rateKey('address', email.toLowerCase())}/${byAddress}/${window}`,
        ).catch((error: unknown) => fail(error)),
      )
    } else {
      log('I_LICENCE_RESEND_LIMITED')
    }
    // The same answer, at once, whatever the address bought: the lookup runs after it.
    return resentPage()
  }

  async function mailAll(email: string, attempt: string): Promise<void> {
    const lower = email.toLowerCase()
    const found = await Promise.all(
      [...new Set([email, lower])].map((e) => stripe.customersByEmail(e)),
    )
    const customers = found.flat().filter((c) => c.email?.toLowerCase() === lower)
    if (customers.length === 0) return
    const emails = new Map(customers.map((c) => [c.id, c.email ?? '']))
    const licences = (await store.licencesOfCustomers([...emails.keys()])).filter(
      (l) => !l.revokedAt,
    )
    if (licences.length === 0) return
    const keys = []
    for (const licence of licences) {
      const owner =
        emails.get(licence.customerId) ||
        (await licensee(licence, undefined, async () => customers[0]?.email ?? null))
      keys.push(await keyFor(licence, owner))
    }
    await mailer.send(licenceMail(email, 'resend', keys, `resend/${attempt}`))
    log(`I_LICENCE_RESENT ${licences.map((l) => l.id).join(' ')}`)
  }

  async function revoked(): Promise<Response> {
    const list = await signRevocations(signer, {
      issuedAt: instant(now()),
      ids: await store.revokedIds(),
    })
    return new Response(list, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    })
  }

  return async (request) => {
    const url = new URL(request.url)
    const asset = assetResponse(url.pathname, request.method)
    if (asset) return asset
    const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined
    if (!route) return errorPage('E_LICENCE_NOT_FOUND', 404)
    if (!route.includes(request.method)) return errorPage('E_LICENCE_METHOD', 405)
    try {
      switch (url.pathname) {
        case '/buy':
          return await checkout(url.origin)
        case '/stripe/webhook':
          return await webhook(request)
        case '/done':
          return await done(url)
        case '/resend':
          return request.method === 'GET' ? resendPage() : await resend(request)
        default:
          return await revoked()
      }
    } catch (error) {
      const code = fail(error)
      const status = STATUS[code] ?? 500
      return url.pathname === '/stripe/webhook' ? json({ code }, status) : errorPage(code, status)
    }
  }
}

const ROUTES: Record<string, string[]> = {
  '/buy': ['GET'],
  '/stripe/webhook': ['POST'],
  '/done': ['GET'],
  '/resend': ['GET', 'POST'],
  '/revoked': ['GET'],
}

function ours(session: CheckoutSession): boolean {
  return session.metadata['kind'] === LICENCE_KIND
}

function expandedId(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : undefined
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function readBody(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('Content-Length') ?? 0)
  if (declared > limit) throw new LicenceError('E_LICENCE_TOO_LARGE')
  const body = await request.text()
  if (new TextEncoder().encode(body).length > limit) throw new LicenceError('E_LICENCE_TOO_LARGE')
  return body
}
