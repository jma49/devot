import { format, t } from '../i18n'
import {
  APP_STORE_UNREAD,
  soldOnAppStore,
  trialOver,
  trialRunning,
  type LicenceSnapshot,
} from '../licence'

const DAY_MS = 24 * 60 * 60 * 1000

/** The Licence row's value, and whether it and the Settings tab show "!". */
export function licenceRow(
  licence: LicenceSnapshot,
  now: number,
): { label: string; needsAttention: boolean } {
  const seat = licence.activation?.state
  if (
    licence.appStore?.pro ||
    (licence.state === 'valid' && (seat === undefined || seat === 'active'))
  )
    return { label: t('phone.settings.licence.pro'), needsAttention: false }
  if (licence.appStore?.code === APP_STORE_UNREAD)
    return { label: t('phone.settings.licence.checking'), needsAttention: false }
  if (!licence.gated) return { label: t('phone.settings.licence.free'), needsAttention: false }
  if (trialRunning(licence, now)) {
    const endsAt = licence.trial?.endsAt ?? null
    const days = endsAt === null ? null : Math.max(1, Math.ceil((endsAt - now) / DAY_MS))
    return {
      label:
        days === null
          ? t('phone.settings.licence.trial')
          : format(t('phone.settings.licence.trialDays'), { days: String(days) }),
      needsAttention: days !== null && days <= 3,
    }
  }
  if (licence.trial?.state === 'available')
    return { label: t('phone.settings.licence.available'), needsAttention: true }
  return { label: t('phone.settings.licence.attention'), needsAttention: true }
}

/** The panes a phone lists: General holds only crash reports there, so it shows only when they can be sent. */
export function phonePanes<T extends string>(panes: readonly T[], crashReports: boolean): T[] {
  return panes.filter((pane) => pane !== 'general' || crashReports)
}

/** Panes whose name holds the query, in their order; an empty query finds them all. */
export function paneMatches<T extends { name: string }>(panes: readonly T[], query: string): T[] {
  const wanted = query.trim().toLocaleLowerCase()
  return panes.filter((pane) => pane.name.toLocaleLowerCase().includes(wanted))
}

/**
 * Whether an App Store build opens the purchase sheet at launch: before the trial and once it has
 * ended, when the App Store purchases are known and no licence holds. A licence that lacks only
 * its seat says so in Settings instead.
 */
export function welcomeDue(licence: LicenceSnapshot, now: number): boolean {
  return (
    soldOnAppStore(licence) &&
    licence.appStore?.code === null &&
    licence.state === 'none' &&
    licence.trial?.code === null &&
    trialOver(licence, now)
  )
}
