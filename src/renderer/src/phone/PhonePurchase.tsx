import { useEffect, useState } from 'react'
import { errorCode } from '../../../core/errors'
import { format, t } from '../i18n'
import { Icon } from '../icons/Icon'
import {
  editingAllowed,
  purchase,
  restorePurchases,
  storeProducts,
  TRIAL_DAYS,
  type LicenceSnapshot,
  type StoreProduct,
  type StoreProductView,
} from '../licence'
import { licenceProblem } from '../licenceView'
import { closePurchase } from '../purchaseSheet'
import { doveMask } from './dove'
import { PhoneSheet } from './PhoneSheet'
import { logFailure } from '../failure'

export type PurchaseBusy = StoreProduct | 'restore'

export type PurchaseMessage =
  | { readonly kind: 'pending' }
  | { readonly kind: 'nothingRestored' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'restoreFailed'; readonly code: string }

function messageText(message: PurchaseMessage): string {
  switch (message.kind) {
    case 'pending':
      return t('phone.purchase.pending')
    case 'nothingRestored':
      return t('phone.purchase.nothingRestored')
    case 'failed':
      return format(t('phone.purchase.failed'), { problem: licenceProblem(message.code) })
    case 'restoreFailed':
      return format(t('phone.purchase.restoreFailed'), { problem: licenceProblem(message.code) })
  }
}

const FEATURES = [
  ['phone.purchase.featureEdit', 'phone.purchase.featureFree'],
  ['phone.purchase.featureSync', null],
  ['phone.purchase.featureAi', null],
] as const

function purchaseHeading(licence: LicenceSnapshot): string {
  if (licence.trial?.state === 'available') return t('phone.purchase.title')
  if (licence.appStore?.code) return t('phone.purchase.unknown')
  return t(licence.trial?.state === 'ended' ? 'phone.purchase.ended' : 'phone.purchase.title')
}

/**
 * The welcome and purchase sheet's contents (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md,
 * What the iPhone shows): what Devot Pro unlocks and what stays free, one main action (the
 * trial while it is available, otherwise Devot Pro at StoreKit's price), and the account links.
 * It names no other price and links nowhere: StoreKit's own sheets take the payment.
 */
export function PurchaseOffer(props: {
  licence: LicenceSnapshot
  products: readonly StoreProductView[]
  busy: PurchaseBusy | null
  message: PurchaseMessage | null
  onBuy: (product: StoreProduct) => void
  onRestore: () => void
  onEnterKey: () => void
}) {
  const { licence, busy } = props
  const price = props.products.find((product) => product.product === 'pro')?.displayPrice
  const startable = licence.trial?.state === 'available'
  const message = props.message
  const buy = () => busy === null && props.onBuy('pro')
  return (
    <>
      <ul className="phone-purchase-features">
        {FEATURES.map(([feature, note]) => (
          <li key={feature} className="phone-purchase-feature">
            <span className="phone-purchase-check">
              <Icon name="check" size="sm" />
            </span>
            <span className="phone-purchase-feature-text">
              {t(feature)}
              {note && <span className="phone-purchase-note">{t(note)}</span>}
            </span>
          </li>
        ))}
      </ul>
      {message && (
        <p
          className="phone-detail-body phone-purchase-message"
          role={message.kind === 'failed' || message.kind === 'restoreFailed' ? 'alert' : 'status'}
        >
          {messageText(message)}
        </p>
      )}
      <div className="phone-purchase-actions">
        {startable ? (
          <>
            <button
              type="button"
              className="phone-purchase-primary"
              aria-disabled={busy !== null}
              onClick={() => busy === null && props.onBuy('trial')}
            >
              {format(t('phone.purchase.tryFree'), { days: String(TRIAL_DAYS) })}
            </button>
            <button
              type="button"
              className="phone-purchase-buy-once"
              aria-disabled={busy !== null}
              onClick={buy}
            >
              {price ? format(t('phone.purchase.buyOnce'), { price }) : t('phone.purchase.buy')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="phone-purchase-primary"
            aria-disabled={busy !== null}
            onClick={buy}
          >
            {t('phone.purchase.buy')}
            {price && <span className="phone-purchase-price">{price}</span>}
          </button>
        )}
      </div>
      <div className="phone-purchase-links">
        <button
          type="button"
          className="phone-purchase-link"
          aria-disabled={busy !== null}
          onClick={() => busy === null && props.onRestore()}
        >
          {t('phone.purchase.restore')}
        </button>
        {licence.appStore?.takesKeys && (
          <>
            <span aria-hidden="true" className="phone-purchase-divider" />
            <button type="button" className="phone-purchase-link" onClick={props.onEnterKey}>
              {t('phone.purchase.enterKey')}
            </button>
          </>
        )}
      </div>
    </>
  )
}

/** The purchase sheet, over every tab, while `purchaseSheet` says it is open. */
export function PhonePurchaseSheet(props: { licence: LicenceSnapshot; onEnterKey: () => void }) {
  const [products, setProducts] = useState<readonly StoreProductView[]>([])
  const [busy, setBusy] = useState<PurchaseBusy | null>(null)
  const [message, setMessage] = useState<PurchaseMessage | null>(null)
  useEffect(() => {
    let alive = true
    // Without StoreKit's price Buy still works: StoreKit's own sheet shows it.
    storeProducts().then(
      (found) => alive && setProducts(found),
      () => console.warn('W_STORE_PRODUCTS_FAILED'),
    )
    return () => {
      alive = false
    }
  }, [])
  const buy = (product: StoreProduct) => {
    setBusy(product)
    setMessage(null)
    purchase(product)
      .then(
        (bought) => {
          if (bought === 'purchased') closePurchase()
          else if (bought === 'pending') setMessage({ kind: 'pending' })
        },
        (error: unknown) =>
          setMessage({
            kind: 'failed',
            code: logFailure(errorCode(error), 'W_PHONE_PURCHASE_FAILED'),
          }),
      )
      .finally(() => setBusy(null))
  }
  const restore = () => {
    setBusy('restore')
    setMessage(null)
    restorePurchases()
      .then(
        () => (editingAllowed() ? closePurchase() : setMessage({ kind: 'nothingRestored' })),
        (error: unknown) =>
          setMessage({
            kind: 'restoreFailed',
            code: logFailure(errorCode(error), 'W_PHONE_RESTORE_FAILED'),
          }),
      )
      .finally(() => setBusy(null))
  }
  return (
    <PhoneSheet
      title={purchaseHeading(props.licence)}
      onClose={closePurchase}
      lead={
        <span className="phone-detail-icon">
          <span aria-hidden="true" className="phone-dove phone-purchase-dove" style={doveMask} />
        </span>
      }
    >
      <PurchaseOffer
        licence={props.licence}
        products={products}
        busy={busy}
        message={message}
        onBuy={buy}
        onRestore={restore}
        onEnterKey={() => {
          closePurchase()
          props.onEnterKey()
        }}
      />
    </PhoneSheet>
  )
}
