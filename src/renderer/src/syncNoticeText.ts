import { countOf, untilTime, uploadCounts } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'
import { LICENCE_REQUIRED, licenceSnapshot, trialOver } from './licence'
import { STOP_ADVICE, STORAGE_FULL, type SyncSnapshot } from './sync'
import { RESTORE_CHOICE } from '../../core/sync/restore'
import type { UsageNotice } from '../../core/sync/usage'
import { USAGE_NOTICE_TEXT } from './syncUsage'
import { BEFORE_JOINING, icloudAttention, icloudNotice } from './syncICloud'

const STOPPED: Readonly<Record<string, MessageKey>> = {
  E_SYNC_REVOKED: 'sync.notice.revoked',
  E_SYNC_UNAUTHORIZED: 'sync.notice.revoked',
  E_SYNC_CLOCK_SKEW: 'sync.notice.clock',
  E_LICENCE_REQUIRED: 'sync.notice.licence',
  E_LICENCE_UNREADABLE: 'sync.notice.licenceUnreadable',
}

function stateMessage(snapshot: SyncSnapshot, pauseOver: boolean): string | undefined {
  const { state, code, pausedUntil, upload } = snapshot.status
  const icloud = icloudAttention(snapshot)
  if (icloud && icloud.kind !== 'joined') return icloudNotice(icloud, pauseOver)
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
    // The main window asks (RestoreSyncChoice).
    if (code === RESTORE_CHOICE) return undefined
    if (code === LICENCE_REQUIRED && trialOver(licenceSnapshot(), Date.now()))
      return t('sync.notice.licenceTrialEnded')
    const advice = STOP_ADVICE[code]
    if (advice) return format(t('sync.notice.stoppedAdvice'), { code, advice: t(advice) })
    return format(t(STOPPED[code] ?? 'sync.notice.stopped'), { code })
  }
  return icloud ? icloudNotice(icloud, pauseOver) : undefined
}

function usageMessage(snapshot: SyncSnapshot, usage: UsageNotice | null): string | undefined {
  if (usage === null) return undefined
  // The pause's own notice already says the storage is full.
  if (usage === 'storageFull' && snapshot.status.code === STORAGE_FULL) return undefined
  return t(USAGE_NOTICE_TEXT[usage])
}

export function syncNoticeMessages(
  snapshot: SyncSnapshot,
  pauseOver: boolean,
  usage: UsageNotice | null,
): string[] {
  if (!snapshot.enabled) {
    const icloud = icloudAttention(snapshot)
    return icloud && BEFORE_JOINING.has(icloud.kind) ? [icloudNotice(icloud, pauseOver)] : []
  }
  const { tooLarge } = snapshot.status
  return [
    stateMessage(snapshot, pauseOver),
    usageMessage(snapshot, usage),
    tooLarge > 0
      ? countOf(tooLarge, currentLocale(), 'sync.notice.tooLargeOne', 'sync.notice.tooLargeOther')
      : undefined,
  ].filter((part) => part !== undefined)
}
