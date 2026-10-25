import { useState, type ReactNode } from 'react'
import { errorCode } from './backups'
import { ConfirmDialog } from './ConfirmDialog'
import type { DeepLink } from './deepLink'
import { currentLocale, format, t } from './i18n'
import { addLicence, readCurrentLicence } from './licence'
import { licenceProblem, planLicenceLink, type LicenceOffer } from './licenceView'

type LicenceLink = Extract<DeepLink, { kind: 'licence' }>

/**
 * A devot://licence link in the main window: a key that failed Rust's check says why, a device
 * without a licence takes it, the same licence again changes nothing, and anything else asks
 * first (saying when the key is the licence held here, renewed).
 */
export function useLicenceLink(): {
  handle: (link: LicenceLink) => void
  dialog: ReactNode
  notice: ReactNode
} {
  const [asking, setAsking] = useState<{
    key: string
    offer: LicenceOffer
    message: string
    detail: string
  }>()
  const [notice, setNotice] = useState<string>()

  const add = (key: string, offer: LicenceOffer) =>
    void addLicence(key).then(
      (next) =>
        setNotice(
          format(
            t(
              next.state === 'valid' || !next.gated
                ? 'deepLink.licenceAdded'
                : 'deepLink.licenceAddedLocked',
            ),
            { licensee: offer.licensee },
          ),
        ),
      (e: unknown) => setNotice(format(t('deepLink.licenceFailed'), { code: errorCode(e) })),
    )

  const handle = (link: LicenceLink) => {
    setNotice(undefined)
    const { key, offer } = link
    if (key === null || offer === null) {
      setNotice(
        format(t('deepLink.licenceInvalid'), {
          problem: licenceProblem(link.code ?? 'E_LICENCE_MALFORMED'),
        }),
      )
      return
    }
    void readCurrentLicence().then(
      (current) => {
        const plan = planLicenceLink(current, offer, currentLocale())
        if (plan.kind === 'add') add(key, offer)
        else if (plan.kind === 'same') setNotice(t('deepLink.licenceSame'))
        else setAsking({ key, offer, message: plan.message, detail: plan.detail })
      },
      (e: unknown) => setNotice(format(t('deepLink.licenceFailed'), { code: errorCode(e) })),
    )
  }

  return {
    handle,
    dialog: asking ? (
      <ConfirmDialog
        message={asking.message}
        detail={asking.detail}
        confirm={t('licence.replace.confirm')}
        onConfirm={() => {
          setAsking(undefined)
          add(asking.key, asking.offer)
        }}
        onCancel={() => setAsking(undefined)}
      />
    ) : null,
    notice: notice ? (
      <div role="alert" className="notice" data-devot-part="notice" data-devot-licence-link>
        <span className="notice-text">{notice}</span>
        <button type="button" className="button" onClick={() => setNotice(undefined)}>
          {t('notice.dismiss')}
        </button>
      </div>
    ) : null,
  }
}
