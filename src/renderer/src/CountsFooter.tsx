import { useSyncExternalStore } from 'react'
import type { EditorCounts } from './editor/counts'
import { formatNumber } from './format'
import { currentLocale, format, t } from './i18n'

/** `12 of 340` for a selection, `340` for the note. */
export function countText(whole: number, selected: number | undefined, locale: string): string {
  const total = formatNumber(whole, locale)
  if (selected === undefined) return total
  return format(t('counts.of'), { part: formatNumber(selected, locale), total })
}

/** `340 / 1,500` toward the note's word goal; a selection shows its own part instead. */
export function wordsText(counts: EditorCounts, locale: string): string {
  const { selection, goal } = counts
  if (selection || goal === undefined) return countText(counts.words, selection?.words, locale)
  return format(t('counts.towardGoal'), {
    count: formatNumber(counts.words, locale),
    goal: formatNumber(goal, locale),
  })
}

export function CountsFooter(props: { counts: EditorCounts | null }) {
  const { counts } = props
  if (!counts) return <p className="editor-counts" />
  const locale = currentLocale()
  const { selection } = counts
  return (
    <p className="editor-counts">
      <span
        title={
          counts.goal === undefined
            ? undefined
            : format(t('counts.goalTitle'), { goal: formatNumber(counts.goal, locale) })
        }
      >
        {t('counts.words')} {wordsText(counts, locale)}
      </span>
      <span>
        {t('counts.characters')} {countText(counts.characters, selection?.characters, locale)}
      </span>
    </p>
  )
}

export interface CountsStore {
  get(): EditorCounts | null
  set(counts: EditorCounts): void
  subscribe(listener: () => void): () => void
}

/** Holds the counts outside React state, so a new count renders the footer and not the window. */
export function countsStore(): CountsStore {
  let current: EditorCounts | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(counts) {
      current = counts
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export function LiveCountsFooter(props: { store: CountsStore }) {
  const counts = useSyncExternalStore(props.store.subscribe, props.store.get)
  return <CountsFooter counts={counts} />
}
