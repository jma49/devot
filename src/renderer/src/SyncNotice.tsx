import { useState } from 'react'
import { t } from './i18n'
import { LICENCE_REQUIRED } from './licence'
import { LicenceButton } from './LicenceLocked'
import { usePauseOver, type SyncSnapshot } from './sync'
import { syncNoticeMessages } from './syncNoticeText'
import { useUsageNotice } from './syncUsage'

/** Sync stopped until the user acts, paused by the relay's quota or by iCloud, a relay near its storage cap, or records that stay on this device; dismissed until it says something else. */
export function SyncNotice(props: { snapshot: SyncSnapshot }) {
  const usage = useUsageNotice(props.snapshot)
  const all = syncNoticeMessages(
    props.snapshot,
    usePauseOver(props.snapshot.status.pausedUntil),
    usage,
  )
  const [dismissed, setDismissed] = useState<readonly string[]>()
  // A notice that went away is shown again when it comes back, even with the same words (a pause on another day). A recheck (connecting, syncing) is not going away: a clock that is still off stops sync again.
  const { state } = props.snapshot.status
  const checking = state === 'connecting' || state === 'syncing'
  if (all.length === 0 && !checking && dismissed !== undefined) setDismissed(undefined)
  // Each part is dismissed on its own, so the too-large note stays hidden while the stopped text comes and goes during a recheck.
  const shown = all.filter((part) => !dismissed?.includes(part))
  if (shown.length === 0) return null
  const text = shown.join(' ')
  const { code } = props.snapshot.status
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{text}</span>
      {state === 'stopped' && code === LICENCE_REQUIRED ? <LicenceButton /> : null}
      <button type="button" className="button" onClick={() => setDismissed(all)}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
