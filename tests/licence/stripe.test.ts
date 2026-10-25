import { describe, expect, it } from 'vitest'
import { checkoutParams } from '../../licence/src/checkout'
import { LicenceError } from '../../licence/src/errors'
import { STRIPE_VERSION, stripeClient } from '../../licence/src/stripe'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = []
  const fetcher = async (url: string, init: RequestInit) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    }
    calls.push(call)
    return answer(call)
  }
  return { calls, fetcher }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

describe('the Stripe client', () => {
  it('posts a form-encoded body with the key and the pinned version', async () => {
    const { calls, fetcher } = fakeFetch(() =>
      json({ object: 'checkout.session', id: 'cs_test_1', url: 'https://checkout.stripe.com/c/1' }),
    )
    const stripe = stripeClient('rk_test_key', fetcher)
    const session = await stripe.createCheckoutSession({
      'line_items[0][price]': 'price_1',
      success_url: 'https://licence.example/done?session_id={CHECKOUT_SESSION_ID}',
    })
    expect(session).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/1' })
    const [call] = calls
    expect(call?.url).toBe('https://api.stripe.com/v1/checkout/sessions')
    expect(call?.method).toBe('POST')
    expect(call?.headers).toEqual({
      Authorization: 'Bearer rk_test_key',
      'Stripe-Version': STRIPE_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
    })
    expect(Object.fromEntries(new URLSearchParams(call?.body))).toEqual({
      'line_items[0][price]': 'price_1',
      success_url: 'https://licence.example/done?session_id={CHECKOUT_SESSION_ID}',
    })
  })

  it('reads a Checkout Session, expanded fields included', async () => {
    const { calls, fetcher } = fakeFetch(() =>
      json({
        object: 'checkout.session',
        id: 'cs_test_2',
        url: null,
        mode: 'payment',
        payment_status: 'paid',
        customer: { object: 'customer', id: 'cus_1' },
        payment_intent: 'pi_1',
        customer_details: { email: 'buyer@example.com' },
        metadata: { kind: 'licence', note: 'abc', ignored: 3 },
      }),
    )
    const session = await stripeClient('rk', fetcher).retrieveCheckoutSession('cs_test_2')
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_2')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.body).toBeUndefined()
    expect(session).toEqual({
      id: 'cs_test_2',
      url: null,
      mode: 'payment',
      paymentStatus: 'paid',
      customer: 'cus_1',
      paymentIntent: 'pi_1',
      email: 'buyer@example.com',
      metadata: { kind: 'licence', note: 'abc' },
    })
  })

  it('lists customers by email in the query and drops deleted ones', async () => {
    const { calls, fetcher } = fakeFetch(() =>
      json({
        object: 'list',
        data: [
          { object: 'customer', id: 'cus_1', email: 'a+b@example.com' },
          { object: 'customer', id: 'cus_2', deleted: true },
        ],
      }),
    )
    const customers = await stripeClient('rk', fetcher).customersByEmail('a+b@example.com')
    expect(customers).toEqual([{ id: 'cus_1', email: 'a+b@example.com' }])
    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/v1/customers')
    expect(url.searchParams.get('email')).toBe('a+b@example.com')
    expect(url.searchParams.get('limit')).toBe('100')
  })

  it('answers null for a missing object and throws a code for a failure', async () => {
    const missing = stripeClient('rk', fakeFetch(() => json({ error: {} }, 404)).fetcher)
    expect(await missing.retrieveCustomer('cus_x')).toBeNull()
    const failing = stripeClient('rk', fakeFetch(() => json({ error: {} }, 500)).fetcher)
    const error = await failing.retrieveCustomer('cus_x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LicenceError)
    expect(error).toMatchObject({ code: 'E_LICENCE_STRIPE', detail: '500' })
    const offline = stripeClient('rk', async () => Promise.reject(new Error('offline')))
    await expect(offline.customersByEmail('a@example.com')).rejects.toMatchObject({
      code: 'E_LICENCE_STRIPE',
      detail: 'network',
    })
  })
})

describe('Checkout Session parameters', () => {
  const config = {
    managedPayments: true,
    priceLicence: 'price_licence',
    cancelUrl: undefined,
  }

  it('sell the licence in payment mode with Managed Payments and a new Customer', () => {
    expect(checkoutParams(config, 'https://licence.example')).toEqual({
      mode: 'payment',
      'line_items[0][price]': 'price_licence',
      'line_items[0][quantity]': '1',
      customer_creation: 'always',
      success_url: 'https://licence.example/done?session_id={CHECKOUT_SESSION_ID}',
      'metadata[kind]': 'licence',
      'managed_payments[enabled]': 'true',
    })
  })

  it('use Stripe Tax instead when Managed Payments is off', () => {
    const params = checkoutParams({ ...config, managedPayments: false }, 'https://l.example')
    expect(params['automatic_tax[enabled]']).toBe('true')
    expect(params['managed_payments[enabled]']).toBeUndefined()
  })

  it('send a buyer who cancels to the page given', () => {
    const params = checkoutParams(
      { ...config, cancelUrl: 'https://devot.example/buy' },
      'https://l.example',
    )
    expect(params['cancel_url']).toBe('https://devot.example/buy')
  })
})
