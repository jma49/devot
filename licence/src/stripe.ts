import { LicenceError } from './errors.ts'

/** Every request pins this version, so a change in the account's default changes nothing here. */
export const STRIPE_VERSION = '2026-09-30.endive'
const API = 'https://api.stripe.com'

export interface CheckoutSession {
  id: string
  url: string | null
  mode: string
  paymentStatus: string
  customer: string | null
  paymentIntent: string | null
  email: string | null
  metadata: Record<string, string>
}

export interface Customer {
  id: string
  email: string | null
}

/** The few Stripe calls the Worker makes; tests give it a fake. */
export interface StripeClient {
  createCheckoutSession(params: Record<string, string>): Promise<{ id: string; url: string }>
  retrieveCheckoutSession(id: string): Promise<CheckoutSession | null>
  customersByEmail(email: string): Promise<Customer[]>
  retrieveCustomer(id: string): Promise<Customer | null>
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

export function stripeClient(apiKey: string, fetcher: Fetch = (i, init) => fetch(i, init)) {
  async function call(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string> = {},
  ): Promise<Record<string, unknown> | null> {
    const form = new URLSearchParams(params).toString()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Stripe-Version': STRIPE_VERSION,
    }
    let url = `${API}${path}`
    let body: string | undefined
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = form
    } else if (form) {
      url += `?${form}`
    }
    let response: Response
    try {
      response = await fetcher(
        url,
        body === undefined ? { method, headers } : { method, headers, body },
      )
    } catch {
      throw new LicenceError('E_LICENCE_STRIPE', 'network')
    }
    if (response.status === 404) return null
    if (!response.ok) throw new LicenceError('E_LICENCE_STRIPE', String(response.status))
    const json: unknown = await response.json().catch(() => null)
    if (!isRecord(json)) throw new LicenceError('E_LICENCE_STRIPE', 'body')
    return json
  }

  const client: StripeClient = {
    async createCheckoutSession(params) {
      const session = toSession(await call('POST', '/v1/checkout/sessions', params))
      if (!session?.url) throw new LicenceError('E_LICENCE_STRIPE', 'session')
      return { id: session.id, url: session.url }
    },
    async retrieveCheckoutSession(id) {
      return toSession(await call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`))
    },
    async customersByEmail(email) {
      const list = await call('GET', '/v1/customers', { email, limit: '100' })
      const data = Array.isArray(list?.['data']) ? list['data'] : []
      return data.flatMap((item) => {
        const customer = toCustomer(item)
        return customer ? [customer] : []
      })
    },
    async retrieveCustomer(id) {
      return toCustomer(await call('GET', `/v1/customers/${encodeURIComponent(id)}`))
    },
  }
  return client
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
/** An expandable field: an ID, or the object with its `id`. */
const ref = (value: unknown): string | null => (isRecord(value) ? text(value['id']) : text(value))

export function toSession(value: unknown): CheckoutSession | null {
  if (!isRecord(value) || value['object'] !== 'checkout.session') return null
  const id = text(value['id'])
  if (!id) return null
  const details = value['customer_details']
  const metadata = isRecord(value['metadata']) ? value['metadata'] : {}
  return {
    id,
    url: text(value['url']),
    mode: text(value['mode']) ?? '',
    paymentStatus: text(value['payment_status']) ?? '',
    customer: ref(value['customer']),
    paymentIntent: ref(value['payment_intent']),
    email: isRecord(details) ? text(details['email']) : null,
    metadata: Object.fromEntries(
      Object.entries(metadata).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])),
    ),
  }
}

function toCustomer(value: unknown): Customer | null {
  if (!isRecord(value) || value['object'] !== 'customer' || value['deleted'] === true) return null
  const id = text(value['id'])
  return id ? { id, email: text(value['email']) } : null
}
