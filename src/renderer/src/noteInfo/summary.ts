// The note summary at the end of the pill row: what the note has, then its length.
import type { TaskProgress } from '../../../core/extract'
import { countOf, formatNumber, relativeTime } from '../format'
import { format, t } from '../i18n'

export interface SummaryFacts {
  tasks: TaskProgress
  properties: number
  backlinks: number
  words: number
  updatedAt: number
}

/**
 * Task progress, properties and backlinks where the note has them, then the words; a note with none
 * of the first three says when it was last updated instead.
 */
export function summaryText(facts: SummaryFacts, locale: string, now: number): string {
  const parts: string[] = []
  if (facts.tasks.total > 0) {
    parts.push(
      format(t('noteInfo.summaryTasks'), {
        done: formatNumber(facts.tasks.done, locale),
        total: formatNumber(facts.tasks.total, locale),
      }),
    )
  }
  if (facts.properties > 0) {
    parts.push(
      countOf(facts.properties, locale, 'noteInfo.propertiesOne', 'noteInfo.propertiesOther'),
    )
  }
  if (facts.backlinks > 0) {
    parts.push(countOf(facts.backlinks, locale, 'noteInfo.backlinksOne', 'noteInfo.backlinksOther'))
  }
  if (parts.length === 0) {
    parts.push(
      now - facts.updatedAt < 60_000
        ? t('noteInfo.summaryUpdatedNow')
        : format(t('noteInfo.summaryUpdated'), {
            time: relativeTime(facts.updatedAt, now, locale),
          }),
    )
  }
  parts.push(countOf(facts.words, locale, 'noteInfo.wordsOne', 'noteInfo.wordsOther'))
  return parts.join(t('noteInfo.summarySeparator'))
}
