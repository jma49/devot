import { assetResponse } from './assets.ts'
import { type CheckoutConfig, checkoutParams, LICENCE_KIND } from './checkout.ts'
import { type LicenceCode, LicenceError } from './errors.ts'
import {
  ACTIVATION_DAYS,
  DEVICE_ID,
  instant,
  newLicenceId,
  type Signer,
  signActivation,
  signLicence,
  signRevocations,
  verifyLicence,
} from './format.ts'
import { licenceMail, type Mailer } from './mail.ts'
import { MESSAGES } from './messages.ts'
import { devicesPage, donePage, errorPage, pendingPage, resendPage, resentPage } from './pages.ts'
import type { Fulfilled, Licence, Store } from './store.ts'
import { type CheckoutSession, type StripeClient, toSession } from './stripe.ts'
import { verifyStripeSignature } from './webhook.ts'

export interface AppConfig extends CheckoutConfig {
  webhookSecret: string
  /** How many devices one licence may be activated on. */
  maxDevices: number
}

export interface AppDeps {
  store: Store
  stripe: StripeClient
  mailer: Mailer
  signer: Signer
  config: AppConfig
  /** The public keys a licence key is checked against, by `kid`; the signer's own at least. */
  publicKeys: Readonly<Record<string, Uint8Array>>
  /** Keys the hashes `/resend` counts addresses and IPs under, so no address is stored. */
  rateSecret: Uint8Array
  /** Runs work after the answer has gone (the Worker's `waitUntil`). */
  defer: (work: Promise<unknown>) => void
  now?: () => Date
  /** One line per event: a code and IDs, never an address or a key. */
  log?: (line: string) => void
}

export const LIMITS = {
  /** /resend sends allowed an hour, per address and per IP. */
  resendPerAddress: 3,
  resendPerIp: 10,
  /** A daily cap per address on top of the hourly one: a few a day, not 72. */
  resendPerAddressPerDay: 6,
  /** /resend sends allowed a day in all, well under Resend's 100 a day, so issued mails keep room. */
  resendAllPerDay: 25,
  resendWindowSeconds: 3600,
  /** How long a mail claim holds before another sender may take it (a Resend call times out in 10 s). */
  mailClaimSeconds: 60,
  webhookBytes: 512 * 1024,
  formBytes: 4 * 1024,
  /** Activations and device lookups allowed an hour per licence. */
  activatePerLicencePerHour: 120,
  activationBytes: 4 * 1024,
  labelChars: 64,
}

const SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/
/** The kid the test-vectors seed is used under: the only kid allowed to sign a test-mode purchase. */
const TEST_KID = 'test'
/** PaymentIntent statuses that mean a delayed payment failed, not that it is still coming. */
const FAILED_PAYMENT = new Set(['requires_payment_method', 'canceled'])

function pendingCheck(url: URL): number {
  const check = url.searchParams.get('check') ?? ''
  return /^\d+$/.test(check) ? Number(check) : 0
}
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
  E_LICENCE_UNPAID: 402,
  E_LICENCE_WEBHOOK_SIGNATURE: 400,
  E_LICENCE_DEVICE_LIMIT: 409,
  E_LICENCE_RATE_LIMITED: 429,
  E_LICENCE_MALFORMED: 400,
  E_LICENCE_UNKNOWN_KID: 400,
  E_LICENCE_SIGNATURE: 400,
}

/** A label the buyer can recognise their device by; never markup, never long. */
function cleanLabel(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  const plain = [...text]
    .filter((c) => c >= ' ' && c !== '\u007f')
    .join('')
    .trim()
  return plain.slice(0, LIMITS.labelChars) || 'Devot'
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await readBody(request, LIMITS.activationBytes)
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new LicenceError('E_LICENCE_BAD_REQUEST')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LicenceError('E_LICENCE_BAD_REQUEST')
  }
  return value as Record<string, unknown>
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

  /**
   * A live purchase, or a test-mode one under the test seed. A production seed never signs a
   * test-mode purchase, however a sandbox Worker was configured (docs/licensing.md, Stripe).
   */
  const payable = (session: CheckoutSession): boolean => session.livemode || signer.kid === TEST_KID

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
      emailHash: session.email ? await rateKey('email', session.email.toLowerCase()) : null,
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
    // /done and the webhook, or two deliveries of one event, can get here together: one claims.
    // A claim is not a send: a webhook that finds one in flight answers 500, so Stripe retries,
    // and a claim whose sender is cut off can be taken again once the lease ends.
    const at = instant(now())
    const staleBefore = instant(new Date(now().getTime() - LIMITS.mailClaimSeconds * 1000))
    if (!(await store.claimMail(purchase.sessionId, at, staleBefore))) {
      const latest = await store.purchase(purchase.sessionId)
      if (latest?.mailedAt) return
      throw new LicenceError('E_LICENCE_MAIL', 'claim')
    }
    try {
      await mailer.send(mail)
      await store.sentMail(purchase.sessionId, at)
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
          if (!payable(session)) {
            log(`E_LICENCE_SESSION_UNKNOWN ${session.id}`)
            break
          }
          await mailOnce(await fulfil(session), session)
          break
        }
        case 'checkout.session.async_payment_failed': {
          const session = toSession(object)
          if (session && ours(session)) log(`E_LICENCE_UNPAID ${session.id}`)
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
      if (!fetched || fetched.mode !== 'payment' || !ours(fetched) || !payable(fetched)) {
        return errorPage('E_LICENCE_SESSION_UNKNOWN', 404)
      }
      if (fetched.paymentStatus !== 'paid') {
        // A delayed payment that failed is not still coming: say so, not "check again".
        const intent = fetched.paymentIntent
          ? await stripe.retrievePaymentIntent(fetched.paymentIntent)
          : null
        if (intent && FAILED_PAYMENT.has(intent.status)) {
          return errorPage('E_LICENCE_UNPAID', 402)
        }
        return pendingPage(sessionId, pendingCheck(url))
      }
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
    const seconds = Math.floor(now().getTime() / 1000)
    const hour = Math.floor(seconds / LIMITS.resendWindowSeconds)
    const day = Math.floor(seconds / 86400)
    const lower = email.toLowerCase()
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    // The IP is counted first, and an address only when the IP is under its limit: an over-limit
    // IP must not spend a buyer's allowance and lock them out of their own recovery.
    const byIp = await store.hit(await rateKey('ip', ip), hour)
    let allowed = byIp <= LIMITS.resendPerIp
    let byAddress = 0
    if (allowed) {
      const [hourly, daily, everyone] = await Promise.all([
        store.hit(await rateKey('address', lower), hour),
        store.hit(await rateKey('address-day', lower), day),
        store.hit('resend:all', day),
      ])
      byAddress = hourly
      allowed =
        hourly <= LIMITS.resendPerAddress &&
        daily <= LIMITS.resendPerAddressPerDay &&
        everyone <= LIMITS.resendAllPerDay
    }
    if (!allowed) {
      log('I_LICENCE_RESEND_LIMITED')
    } else {
      deps.defer(
        mailAll(email, `${await rateKey('address', lower)}/${byAddress}/${hour}`).catch(
          (error: unknown) => fail(error),
        ),
      )
    }
    // The same answer, at once, whatever the address bought: the lookup runs after it.
    return resentPage()
  }

  async function mailAll(email: string, attempt: string): Promise<void> {
    const lower = email.toLowerCase()
    // The keyed hash finds the purchase whatever capitals Stripe stored; the customer lookup
    // still serves purchases recorded before the hash was kept.
    const hashed = await store.licencesOfEmail(await rateKey('email', lower))
    const found = await Promise.all(
      [...new Set([email, lower])].map((e) => stripe.customersByEmail(e)),
    )
    const customers = found.flat().filter((c) => c.email?.toLowerCase() === lower)
    const licences = new Map(hashed.map((l) => [l.id, l]))
    for (const customer of customers) {
      for (const licence of await store.licencesOfCustomers([customer.id])) {
        licences.set(licence.id, licence)
      }
    }
    const live = [...licences.values()].filter((l) => !l.revokedAt)
    if (live.length === 0) return
    const emails = new Map(customers.map((c) => [c.id, c.email ?? '']))
    const keys = []
    for (const licence of live) {
      const owner =
        emails.get(licence.customerId) || (await licensee(licence, undefined, async () => email))
      keys.push(await keyFor(licence, owner))
    }
    await mailer.send(licenceMail(email, 'resend', keys, `resend/${attempt}`))
    log(`I_LICENCE_RESENT ${live.map((l) => l.id).join(' ')}`)
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

  /**
   * The live licence a key names; a key that fails says why, as the app does. A complimentary key
   * has no row in D1 (docs/licensing.md, Complimentary licences): its signature is the root of
   * trust, and only a row that says it was revoked refuses it.
   */
  async function licenceFor(key: unknown): Promise<{ id: string }> {
    if (typeof key !== 'string' || key.length === 0 || key.length > 1024) {
      throw new LicenceError('E_LICENCE_BAD_REQUEST')
    }
    const verified = await verifyLicence(key, deps.publicKeys)
    if (!verified.ok) throw new LicenceError(verified.code)
    const id = verified.payload.id
    const licence = await store.licence(id)
    if (licence?.revokedAt) throw new LicenceError('E_LICENCE_REVOKED', id)
    return { id }
  }

  function deviceOf(value: unknown): string {
    if (typeof value !== 'string' || !DEVICE_ID.test(value)) {
      throw new LicenceError('E_LICENCE_BAD_REQUEST')
    }
    return value
  }

  /** Takes or refreshes a seat and answers with a lease the app verifies offline. */
  async function activate(request: Request): Promise<Response> {
    const body = await readJson(request)
    const licence = await licenceFor(body['key'])
    const device = deviceOf(body['device'])
    const at = instant(now())
    const hour = Math.floor(now().getTime() / 3_600_000)
    // Per device: a refused copy cannot spend the owner's allowance.
    const counter = `activate:${licence.id}:${device}`
    if ((await store.hit(counter, hour)) > LIMITS.activatePerLicencePerHour) {
      log(`I_LICENCE_ACTIVATE_LIMITED ${licence.id}`)
      throw new LicenceError('E_LICENCE_RATE_LIMITED')
    }
    const taken = await store.activate(
      licence.id,
      device,
      cleanLabel(body['label']),
      at,
      config.maxDevices,
    )
    if (!taken) {
      log(`I_LICENCE_DEVICE_LIMIT ${licence.id}`)
      throw new LicenceError('E_LICENCE_DEVICE_LIMIT', licence.id)
    }
    const expiresAt = instant(new Date(now().getTime() + ACTIVATION_DAYS * 86_400_000))
    const lease = await signActivation(signer, { id: licence.id, device, issuedAt: at, expiresAt })
    log(`I_LICENCE_ACTIVATED ${licence.id} ${device}`)
    return json({ lease, used: taken.used, limit: config.maxDevices }, 200)
  }

  async function deactivate(request: Request): Promise<Response> {
    const body = await readJson(request)
    const licence = await licenceFor(body['key'])
    const device = deviceOf(body['device'])
    const freed = await store.deactivate(licence.id, device)
    log(`I_LICENCE_DEACTIVATED ${licence.id} ${device} ${freed ? 'seat' : 'none'}`)
    return json({ deactivated: freed }, 200)
  }

  /** The page a buyer uses to free a seat, for a device they no longer have. */
  async function devices(request: Request): Promise<Response> {
    if (request.method === 'GET') return devicesPage(null, null, config.maxDevices)
    const form = new URLSearchParams(await readBody(request, LIMITS.formBytes))
    const key = form.get('key') ?? ''
    const licence = await licenceFor(key)
    const target = form.get('device')
    let notice: string | undefined
    if (target) {
      const freed = await store.deactivate(licence.id, deviceOf(target))
      log(`I_LICENCE_DEACTIVATED ${licence.id} ${target} ${freed ? 'page' : 'none'}`)
      notice = freed ? MESSAGES.devicesRemoved : MESSAGES.devicesUnknown
    }
    return devicesPage(key, await store.activations(licence.id), config.maxDevices, notice)
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
        case '/activate':
          return await activate(request)
        case '/deactivate':
          return await deactivate(request)
        case '/devices':
          return await devices(request)
        default:
          return await revoked()
      }
    } catch (error) {
      const code = fail(error)
      const status = STATUS[code] ?? 500
      const api =
        url.pathname === '/stripe/webhook' ||
        url.pathname === '/activate' ||
        url.pathname === '/deactivate'
      return api ? json({ code }, status) : errorPage(code, status)
    }
  }
}

const ROUTES: Record<string, string[]> = {
  '/buy': ['GET'],
  '/stripe/webhook': ['POST'],
  '/done': ['GET'],
  '/resend': ['GET', 'POST'],
  '/revoked': ['GET'],
  '/activate': ['POST'],
  '/deactivate': ['POST'],
  '/devices': ['GET', 'POST'],
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
