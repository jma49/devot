export interface CheckoutConfig {
  managedPayments: boolean
  priceLicence: string
  priceRenewal: string
  cancelUrl: string | undefined
}

export type Purchase = { kind: 'licence' } | { kind: 'renewal'; licenceId: string }

/**
 * A Checkout Session in payment mode that always creates a Customer (`/resend` finds licences
 * through it). Managed Payments: https://docs.stripe.com/payments/managed-payments/set-up
 */
export function checkoutParams(
  config: CheckoutConfig,
  origin: string,
  purchase: Purchase,
): Record<string, string> {
  const params: Record<string, string> = {
    mode: 'payment',
    'line_items[0][price]': purchase.kind === 'licence' ? config.priceLicence : config.priceRenewal,
    'line_items[0][quantity]': '1',
    customer_creation: 'always',
    success_url: `${origin}/done?session_id={CHECKOUT_SESSION_ID}`,
    'metadata[kind]': purchase.kind,
  }
  if (purchase.kind === 'renewal') params['metadata[licence]'] = purchase.licenceId
  if (config.cancelUrl) params['cancel_url'] = config.cancelUrl
  if (config.managedPayments) params['managed_payments[enabled]'] = 'true'
  else params['automatic_tax[enabled]'] = 'true'
  return params
}
