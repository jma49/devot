import { useState } from 'react'
import { countOf } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'
import type { SyncSnapshot } from './sync'

const STOPPED: Readonly<Record<string, MessageKey>> = {
  E_SYNC_REVOKED: 'sync.notice.revoked',
  E_SYNC_UNAUTHORIZED: 'sync.notice.revoked',
  E_SYNC_CLOCK_SKEW: 'sync.notice.clock',
}

function message(snapshot: SyncSnapshot): string | undefined {
  const { state, code, tooLarge } = snapshot.status
  if (!snapshot.enabled) return undefined
  if (state === 'stopped' && code) {
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

/** Sync stopped until the user acts, or records that stay on this device; dismissed until it says something else. */
export function SyncNotice(props: { snapshot: SyncSnapshot }) {
  const text = message(props.snapshot)
  const [dismissed, setDismissed] = useState<string>()
  if (!text || text === dismissed) return null
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{text}</span>
      <button type="button" className="button" onClick={() => setDismissed(text)}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
