import type { HistoryEntry } from '../../core'
import { countOf } from './format'
import { t } from './i18n'
export function describeChange(
  entry: Extract<HistoryEntry, { kind: 'body' }>,
  locale: string,
): string {
  // The oldest kept version: nothing before it to count a change from.
  if (entry.change === null)
    return countOf(entry.length, locale, 'history.earliestOne', 'history.earliestOther')
  if (entry.change === 0) return t('history.sameLength')
  return entry.change > 0
    ? countOf(entry.change, locale, 'history.addedOne', 'history.addedOther')
    : countOf(-entry.change, locale, 'history.removedOne', 'history.removedOther')
}
