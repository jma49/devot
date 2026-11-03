import { useState } from 'react'
import { countOf, untilTime, uploadCounts } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'
import { LICENCE_REQUIRED, licenceSnapshot, trialOver } from './licence'
import { LicenceButton } from './LicenceLocked'
import { STOP_ADVICE, STORAGE_FULL, usePauseOver, type SyncSnapshot } from './sync'
import type { UsageNotice } from '../../core/sync/usage'
import { USAGE_NOTICE_TEXT, useUsageNotice } from './syncUsage'

const STOPPED: Readonly<Record<string, MessageKey>> = {
  E_SYNC_REVOKED: 'sync.notice.revoked',
  E_SYNC_UNAUTHORIZED: 'sync.notice.revoked',
  E_SYNC_CLOCK_SKEW: 'sync.notice.clock',
  E_LICENCE_REQUIRED: 'sync.notice.licence',
}

function stateMessage(snapshot: SyncSnapshot, pauseOver: boolean): string | undefined {
  const { state, code, pausedUntil, upload } = snapshot.status
  if (state === 'paused' && pausedUntil !== null) {
    const locale = currentLocale()
    if (pauseOver) {
      if (code === STORAGE_FULL) return t('sync.notice.storageFullRetry')
      if (!upload) return t('sync.notice.resuming')
      return format(t('sync.notice.resumingUpload'), uploadCounts(upload, locale))
    }
    const time = untilTime(pausedUntil, Date.now(), locale)
    if (code === STORAGE_FULL) return format(t('sync.notice.storageFull'), { time })
    if (!upload) return format(t('sync.notice.paused'), { time })
    return format(t('sync.notice.pausedUpload'), { time, ...uploadCounts(upload, locale) })
  }
  if (state === 'stopped' && code) {
    if (code === LICENCE_REQUIRED && trialOver(licenceSnapshot(), Date.now()))
      return t('sync.notice.licenceTrialEnded')
    const advice = STOP_ADVICE[code]
    if (advice) return format(t('sync.notice.stoppedAdvice'), { code, advice: t(advice) })
    return format(t(STOPPED[code] ?? 'sync.notice.stopped'), { code })
  }
  return undefined
}

function usageMessage(snapshot: SyncSnapshot, usage: UsageNotice | null): string | undefined {
  if (usage === null) return undefined
  // The pause's own notice already says the storage is full.
  if (usage === 'storageFull' && snapshot.status.code === STORAGE_FULL) return undefined
  return t(USAGE_NOTICE_TEXT[usage])
}

function messages(snapshot: SyncSnapshot, pauseOver: boolean, usage: UsageNotice | null): string[] {
  if (!snapshot.enabled) return []
  const { tooLarge } = snapshot.status
  return [
    stateMessage(snapshot, pauseOver),
    usageMessage(snapshot, usage),
    tooLarge > 0
      ? countOf(tooLarge, currentLocale(), 'sync.notice.tooLargeOne', 'sync.notice.tooLargeOther')
      : undefined,
  ].filter((part) => part !== undefined)
}

/** Sync stopped until the user acts, paused by the relay's quota, a relay near its storage cap, or records that stay on this device; dismissed until it says something else. */
export function SyncNotice(props: { snapshot: SyncSnapshot }) {
  const usage = useUsageNotice(props.snapshot)
  const all = messages(props.snapshot, usePauseOver(props.snapshot.status.pausedUntil), usage)
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
