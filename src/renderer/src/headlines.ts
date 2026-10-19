// What a list row shows for a note that has no title: the first line of its
// body (see `headline` in core/extract.ts). It is looked up for the rows
// that show only, by the core, and kept until the note is written again; the
// title is never filled in with it.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteSummary } from '../../core'
import { errorCode } from '../../core/errors'
import { t } from './i18n'

export type HeadlineLoader<V = string> = (ids: string[]) => Promise<Record<string, V>>

/**
 * What names a note anywhere it is named: its title, else its headline (the
 * first line of its body), else "Untitled" for a note with neither (an empty
 * one). The one fallback every list, dialog, link and menu uses.
 */
export function displayTitle(title: string, headline: string | undefined): string {
  return title || headline || t('note.untitled')
}

/**
 * The display title (see `displayTitle`) of each of `notes`, by ID, for places
 * that name notes once rather than render a list. Only untitled notes are
 * looked up; when the lookup fails they get "Untitled", so naming a note
 * never fails with it.
 */
export async function displayTitles(
  load: HeadlineLoader | undefined,
  notes: readonly { id: string; title: string }[],
): Promise<Map<string, string>> {
  const untitled = notes.filter((n) => n.title === '').map((n) => n.id)
  let found: Record<string, string> = {}
  if (load && untitled.length > 0) {
    try {
      found = await load(untitled)
    } catch (e) {
      console.warn('W_HEADLINES_FAILED', errorCode(e))
    }
  }
  return new Map(notes.map((n) => [n.id, displayTitle(n.title, found[n.id])]))
}

export function newestUntitled(notes: readonly NoteSummary[], limit: number): NoteSummary[] {
  return notes
    .filter((n) => n.title === '')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

export interface CachedHeadline<V = string> {
  at: number
  text: V
}

const KEPT = 2000

export function staleHeadlines<V>(
  notes: readonly NoteSummary[],
  cache: ReadonlyMap<string, CachedHeadline<V>>,
  all = false,
): NoteSummary[] {
  return notes.filter((n) => (all || n.title === '') && cache.get(n.id)?.at !== n.updatedAt)
}

export function keepRecent<V>(cache: Map<string, CachedHeadline<V>>, limit: number) {
  for (const id of cache.keys()) {
    if (cache.size <= limit) return
    cache.delete(id)
  }
}

/**
 * `cache` with `found` (read for the writes in `at`) added. An answer for an
 * older write never replaces one read for a newer write.
 */
export function mergeHeadlines<V>(
  cache: ReadonlyMap<string, CachedHeadline<V>>,
  found: Readonly<Record<string, V>>,
  at: ReadonlyMap<string, number>,
): Map<string, CachedHeadline<V>> {
  const next = new Map(cache)
  for (const [id, text] of Object.entries(found)) {
    const was = next.get(id)
    const readAt = at.get(id) ?? 0
    if (was && was.at > readAt) continue
    // Moves the entry to the end: the most recently read last.
    next.delete(id)
    next.set(id, { at: readAt, text })
  }
  return next
}

/**
 * The headline of each untitled note of `notes` (the rows that show), by ID.
 * One that is not known yet is looked up, and the rows render again when it
 * is; one read for an earlier write shows until the new one arrives.
 */
export function useHeadlines<V = string>(
  load: HeadlineLoader<V> | undefined,
  notes: readonly NoteSummary[],
  all = false,
): ReadonlyMap<string, V> {
  const [cache, setCache] = useState<ReadonlyMap<string, CachedHeadline<V>>>(() => new Map())
  // What was asked for and has not come back, so a render in between asks no more.
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (!load) return
    const keyOf = (n: NoteSummary) => `${n.id}@${n.updatedAt}`
    const ask = staleHeadlines(notes, cache, all).filter((n) => !asked.current.has(keyOf(n)))
    if (ask.length === 0) return
    const keys = ask.map(keyOf)
    const at = new Map(ask.map((n) => [n.id, n.updatedAt]))
    for (const key of keys) asked.current.add(key)
    void load([...at.keys()])
      .then((found) => {
        setCache((before) => {
          const next = mergeHeadlines(before, found, at)
          keepRecent(next, KEPT)
          return next
        })
      })
      .catch((e: unknown) => console.warn('W_HEADLINES_FAILED', errorCode(e)))
      .finally(() => {
        for (const key of keys) asked.current.delete(key)
      })
  }, [load, notes, cache, all])
  return useMemo(() => {
    const shown = new Map<string, V>()
    for (const n of notes) {
      const text = all || n.title === '' ? cache.get(n.id)?.text : undefined
      if (text) shown.set(n.id, text)
    }
    return shown
  }, [notes, cache, all])
}
