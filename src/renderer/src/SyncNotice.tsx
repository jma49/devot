import { useState } from 'react'
import { countOf, untilTime, uploadCounts } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'
import { LICENCE_REQUIRED, licenceSnapshot, trialOver } from './licence'
import { LicenceButton } from './LicenceLocked'
import type { SyncSnapshot } from './sync'

const STOPPED: Readonly<Record<string, MessageKey>> = {
  E_SYNC_REVOKED: 'sync.notice.revoked',
  E_SYNC_UNAUTHORIZED: 'sync.notice.revoked',
  E_SYNC_CLOCK_SKEW: 'sync.notice.clock',
  E_LICENCE_REQUIRED: 'sync.notice.licence',
}

function message(snapshot: SyncSnapshot): string | undefined {
  const { state, code, tooLarge, pausedUntil, upload } = snapshot.status
  if (!snapshot.enabled) return undefined
  if (state === 'paused' && pausedUntil !== null) {
    const locale = currentLocale()
    const time = untilTime(pausedUntil, Date.now(), locale)
    if (!upload) return format(t('sync.notice.paused'), { time })
    return format(t('sync.notice.pausedUpload'), { time, ...uploadCounts(upload, locale) })
  }
  if (state === 'stopped' && code) {
    if (code === LICENCE_REQUIRED && trialOver(licenceSnapshot(), Date.now()))
      return t('sync.notice.licenceTrialEnded')
    return format(t(STOPPED[code] ?? 'sync.notice.stopped'), { code })
  }
  if (tooLarge > 0) {
    return countOf(
      tooLarge,
      currentLocale(),
      'sync.notice.tooLargeOne',
      'sync.notice.tooLargeOther',
    )
  }
  return undefined
}

/** Sync stopped until the user acts, paused by the relay's quota, or records that stay on this device; dismissed until it says something else. */
export function SyncNotice(props: { snapshot: SyncSnapshot }) {
  const text = message(props.snapshot)
  const [dismissed, setDismissed] = useState<string>()
  // A notice that went away is shown again when it comes back, even with the same words (a pause on another day).
  if (!text && dismissed !== undefined) setDismissed(undefined)
  if (!text || text === dismissed) return null
  const { state, code } = props.snapshot.status
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{text}</span>
      {state === 'stopped' && code === LICENCE_REQUIRED ? <LicenceButton /> : null}
      <button type="button" className="button" onClick={() => setDismissed(text)}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
