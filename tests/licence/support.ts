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
      updatesUntil: string
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

/** A D1 database in workerd through Miniflare, with the Worker's migrations applied; in memory. */
export async function d1Database(): Promise<{ db: SqlDatabase; close: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response(null) }',
    d1Databases: { DB: 'licence-test' },
  })
  const db = (await mf.getD1Database('DB')) as unknown as SqlDatabase
  await migrate(db)
  return { db, close: () => mf.dispose() }
}

export async function migrate(db: SqlDatabase): Promise<void> {
  for (const file of readdirSync('licence/migrations').sort()) {
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
  readonly created: Record<string, string>[] = []
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
    const paid = {
      ...session,
      paymentStatus: status,
      customer: customer.id,
      paymentIntent: `pi_${++this.n}`,
      email,
    }
    this.sessions.set(sessionId, paid)
    return paid
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
    customer: session.customer,
    payment_intent: session.paymentIntent,
    customer_details: session.email ? { email: session.email } : null,
    metadata: session.metadata,
  }
}

export class RecordingMailer implements Mailer {
  readonly sent: Mail[] = []
  failing = false

  async send(mail: Mail) {
    if (this.failing) throw new LicenceError('E_LICENCE_MAIL', 'E_DELIVERY_FAILED')
    this.sent.push(mail)
  }
}
