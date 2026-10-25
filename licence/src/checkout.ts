export interface CheckoutConfig {
  managedPayments: boolean
  priceLicence: string
  cancelUrl: string | undefined
}

/** Marks the sessions this Worker creates: the Stripe account may sell other things. */
export const LICENCE_KIND = 'licence'

/**
 * A Checkout Session in payment mode that always creates a Customer (`/resend` finds licences
 * through it). Managed Payments: https://docs.stripe.com/payments/managed-payments/set-up
 */
export function checkoutParams(config: CheckoutConfig, origin: string): Record<string, string> {
  const params: Record<string, string> = {
    mode: 'payment',
    'line_items[0][price]': config.priceLicence,
    'line_items[0][quantity]': '1',
    customer_creation: 'always',
    success_url: `${origin}/done?session_id={CHECKOUT_SESSION_ID}`,
    'metadata[kind]': LICENCE_KIND,
  }
  if (config.cancelUrl) params['cancel_url'] = config.cancelUrl
  if (config.managedPayments) params['managed_payments[enabled]'] = 'true'
  else params['automatic_tax[enabled]'] = 'true'
  return params
}
