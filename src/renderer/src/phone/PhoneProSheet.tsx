import { useEffect, useRef, useState } from 'react'
import { errorCode } from '../../../core/errors'
import { logFailure } from '../failure'
import { format, t, type MessageKey } from '../i18n'
import {
  editingAllowed,
  readCurrentLicence,
  restorePurchases,
  type LicenceSnapshot,
} from '../licence'
import { licenceProblem } from '../licenceView'
import { usePurchaseOpen } from '../purchaseSheet'
import { doveMask } from './dove'
import { PhonePurchaseSheet } from './PhonePurchase'
import { PhoneSheet, type SheetHandle } from './PhoneSheet'
import {
  closeGate,
  gateUnlocked,
  useProSheet,
  type ProSheetKind,
  type ProSheetState,
} from './requireEditing'

const SHEETS: Readonly<
  Record<ProSheetKind, { title: MessageKey; body: MessageKey; action: MessageKey }>
> = {
  checking: {
    title: 'phone.purchase.unknown',
    body: 'phone.pro.bodyChecking',
    action: 'phone.pro.tryAgain',
  },
  key: {
    title: 'phone.purchase.ended',
    body: 'phone.pro.bodyKey',
    action: 'phone.purchase.enterKey',
  },
  attention: {
    title: 'phone.pro.titleAttention',
    body: 'phone.pro.bodyAttention',
    action: 'phone.pro.openLicence',
  },
  seat: {
    title: 'phone.pro.titleAttention',
    body: 'phone.pro.bodySeat',
    action: 'phone.pro.openLicence',
  },
  unreadable: {
    title: 'phone.pro.titleUnreadable',
    body: 'phone.pro.bodyUnreadable',
    action: 'phone.pro.tryAgain',
  },
}

const opensLicence = (sheet: ProSheetKind) =>
  sheet === 'key' || sheet === 'attention' || sheet === 'seat'

/**
 * The short Pro sheet (design/phone.md, Sheets): what is locked and the one thing that unlocks
 * it. It names no price and links nowhere: in an App Store build that needs a purchase the
 * purchase sheet shows instead.
 */
function ProSheet(props: { state: ProSheetState; onOpenLicence: (focusKey: boolean) => void }) {
  const { sheet, ai } = props.state
  const look = SHEETS[sheet]
  const [busy, setBusy] = useState<'check' | 'restore' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<SheetHandle>(null)
  useEffect(() => primary.current?.focus({ preventScroll: true }), [])

  const act = () => {
    if (busy) return
    if (opensLicence(sheet)) {
      closeGate()
      props.onOpenLicence(sheet === 'key')
      return
    }
    setBusy('check')
    readCurrentLicence()
      .then(
        () => editingAllowed() && gateUnlocked(),
        () => console.warn('W_LICENCE_READ_FAILED'),
      )
      .finally(() => setBusy(null))
  }
  const restore = () => {
    if (busy) return
    setBusy('restore')
    setMessage(t('phone.settings.restoring'))
    restorePurchases()
      .then(
        () => (editingAllowed() ? gateUnlocked() : setMessage(t('phone.purchase.nothingRestored'))),
        (error: unknown) =>
          setMessage(
            format(t('phone.purchase.restoreFailed'), {
              problem: licenceProblem(logFailure(errorCode(error), 'W_PHONE_RESTORE_FAILED')),
            }),
          ),
      )
      .finally(() => setBusy(null))
  }
  const title = t(look.title)
  return (
    <PhoneSheet title={title} onClose={closeGate} ref={sheetRef} plain>
      <div className="phone-pro">
        <span className="phone-pro-lens">
          <span aria-hidden="true" className="phone-dove phone-pro-dove" style={doveMask} />
        </span>
        <h2 className="phone-pro-title">{title}</h2>
        <p className="phone-detail-body">
          {t(ai && sheet === 'key' ? 'phone.pro.bodyAiKey' : look.body)}
        </p>
        <div className="phone-pro-actions">
          <button
            ref={primary}
            type="button"
            className="phone-purchase-primary"
            aria-disabled={busy !== null}
            onClick={act}
          >
            {t(look.action)}
          </button>
          {message && (
            <p className="phone-pro-line" role="status">
              {message}
            </p>
          )}
          <button
            type="button"
            className="phone-pro-plain"
            onClick={() => sheetRef.current?.close()}
          >
            {t('phone.pro.notNow')}
          </button>
          {sheet === 'checking' && (
            <button
              type="button"
              className="phone-pro-plain"
              aria-disabled={busy !== null}
              onClick={restore}
            >
              {t('phone.purchase.restore')}
            </button>
          )}
        </div>
      </div>
    </PhoneSheet>
  )
}

/** The gate's surfaces, over every tab: the purchase sheet (also Buy's and the welcome's) and the short Pro sheet. */
export function PhoneGate(props: {
  licence: LicenceSnapshot
  onOpenLicence: (focusKey: boolean) => void
}) {
  const purchasing = usePurchaseOpen()
  const proSheet = useProSheet()
  return (
    <>
      {purchasing && (
        <PhonePurchaseSheet licence={props.licence} onEnterKey={() => props.onOpenLicence(true)} />
      )}
      {proSheet && (
        <ProSheet
          key={`${proSheet.sheet}:${proSheet.ai}`}
          state={proSheet}
          onOpenLicence={props.onOpenLicence}
        />
      )}
    </>
  )
}
