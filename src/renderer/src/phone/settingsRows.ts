import { format, t } from '../i18n'
import { trialRunning, type LicenceSnapshot } from '../licence'

const DAY_MS = 24 * 60 * 60 * 1000

/** The Licence row's value, and whether it and the Settings tab show "!". */
export function licenceRow(
  licence: LicenceSnapshot,
  now: number,
): { label: string; needsAttention: boolean } {
  const seat = licence.activation?.state
  if (licence.state === 'valid' && (seat === undefined || seat === 'active'))
    return { label: t('phone.settings.licence.pro'), needsAttention: false }
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
  return { label: t('phone.settings.licence.attention'), needsAttention: true }
}

/** Panes whose name holds the query, in their order; an empty query finds them all. */
export function paneMatches<T extends { name: string }>(panes: readonly T[], query: string): T[] {
  const wanted = query.trim().toLocaleLowerCase()
  return panes.filter((pane) => pane.name.toLocaleLowerCase().includes(wanted))
}
