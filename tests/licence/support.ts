import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'
import { LicenceError } from '../../licence/src/errors'
import type { Mail, Mailer } from '../../licence/src/mail'
import type { SqlDatabase } from '../../licence/src/store'
import type { CheckoutSession, Customer, StripeClient } from '../../licence/src/stripe'

export interface Vectors {
  keys: { kid: string; seed: string; publicKey: string }[]
  licences: {
    name: string
    key: string
    payload: {
      id: string
      kid: string
      plan: string
      licensee: string
      issuedAt: string
    }
  }[]
  invalid: { name: string; key: string; code: string }[]
  revocations: {
    list: string
    payload: { kid: string; issuedAt: string; ids: string[] }
    tampered: { list: string; code: string }
    licenceAsList: { list: string; code: string }
  }
}

export const vectors: Vectors = JSON.parse(readFileSync('licence/test-vectors.json', 'utf8'))

/**
 * A D1 database in workerd through Miniflare, with the Worker's migrations applied (those up to
 * `through`, a file name, when given); in memory.
 */
export async function d1Database(
  through?: string,
): Promise<{ db: SqlDatabase; close: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response(null) }',
    d1Databases: { DB: 'licence-test' },
  })
  const db = (await mf.getD1Database('DB')) as unknown as SqlDatabase
  await migrate(db, (file) => through === undefined || file <= through)
  return { db, close: () => mf.dispose() }
}

export async function migrate(
  db: SqlDatabase,
  include: (file: string) => boolean = () => true,
): Promise<void> {
  for (const file of readdirSync('licence/migrations').sort().filter(include)) {
    const sql = readFileSync(join('licence/migrations', file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    const statements = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean)
    await db.batch(statements.map((s) => db.prepare(s)))
  }
}

/** Stripe as far as the Worker sees it, in memory: sessions, customers and their payments. */
export class FakeStripe implements StripeClient {
  readonly sessions = new Map<string, CheckoutSession>()
  readonly customers = new Map<string, Customer>()
  readonly intents = new Map<string, { status: string }>()
  readonly created: Record<string, string>[] = []
  /** Live-mode when true, test-mode when false (the default): the Worker refuses the latter under a production kid. */
  livemode = false
  failing = false
  private n = 0

  async createCheckoutSession(params: Record<string, string>) {
    this.check()
    const id = `cs_test_${++this.n}`
    this.created.push(params)
    const metadata = Object.fromEntries(
      Object.entries(params).flatMap(([k, v]) => {
        const key = /^metadata\[(.+)\]$/.exec(k)?.[1]
        return key ? [[key, v]] : []
      }),
    )
    const url = `https://checkout.stripe.test/${id}`
    this.sessions.set(id, {
      id,
      url,
      mode: params['mode'] ?? '',
      paymentStatus: 'unpaid',
      livemode: this.livemode,
      customer: null,
      paymentIntent: null,
      email: null,
      metadata,
    })
    return { id, url }
  }

  async retrieveCheckoutSession(id: string) {
    this.check()
    return this.sessions.get(id) ?? null
  }

  async retrievePaymentIntent(id: string) {
    this.check()
    return this.intents.get(id) ?? null
  }

  async customersByEmail(email: string) {
    this.check()
    return [...this.customers.values()].filter((c) => c.email === email)
  }

  async retrieveCustomer(id: string) {
    this.check()
    return this.customers.get(id) ?? null
  }

  /** The buyer pays: Checkout creates a Customer for the address and a PaymentIntent. */
  pay(sessionId: string, email: string, status: 'paid' | 'unpaid' = 'paid'): CheckoutSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`no session ${sessionId}`)
    const customer = { id: `cus_${++this.n}`, email }
    this.customers.set(customer.id, customer)
    const paymentIntent = `pi_${++this.n}`
    this.intents.set(paymentIntent, { status: status === 'paid' ? 'succeeded' : 'processing' })
    const paid = {
      ...session,
      paymentStatus: status,
      customer: customer.id,
      paymentIntent,
      email,
    }
    this.sessions.set(sessionId, paid)
    return paid
  }

  /** A delayed payment whose debit failed: Stripe leaves the PaymentIntent needing a new method. */
  failPayment(paymentIntent: string) {
    this.intents.set(paymentIntent, { status: 'requires_payment_method' })
  }

  private check() {
    if (this.failing) throw new LicenceError('E_LICENCE_STRIPE', '500')
  }
}

/** A session as Stripe's API and webhooks write it. */
export function rawSession(session: CheckoutSession) {
  return {
    object: 'checkout.session',
    id: session.id,
    url: session.url,
    mode: session.mode,
    payment_status: session.paymentStatus,
    livemode: session.livemode,
    customer: session.customer,
    payment_intent: session.paymentIntent,
    customer_details: session.email ? { email: session.email } : null,
    metadata: session.metadata,
  }
}

export class RecordingMailer implements Mailer {
  readonly sent: Mail[] = []
  failing = false
  /** True while a send is waiting on hold(); the tests use it to let /done claim the mail first. */
  sending = false
  private held: Promise<void> | undefined
  private heldFails = false

  /** Holds every send until the returned function is called; that held send then fails when `fail`. */
  hold(fail = false): () => void {
    let release = () => {}
    this.held = new Promise((resolve) => {
      release = resolve
    })
    this.heldFails = fail
    return release
  }

  async send(mail: Mail) {
    if (this.failing) throw new LicenceError('E_LICENCE_MAIL', 'E_DELIVERY_FAILED')
    this.sending = true
    await this.held
    if (this.heldFails) {
      this.heldFails = false
      this.sending = false
      throw new LicenceError('E_LICENCE_MAIL', 'E_DELIVERY_FAILED')
    }
    this.sent.push(mail)
    this.sending = false
  }
}
