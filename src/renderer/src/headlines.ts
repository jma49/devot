// What a list row shows for a note that has no title: the first line of its
// body (see `headline` in core/extract.ts). It is looked up for the rows
// that show only, by the core, and kept until the note is written again; the
// title is never filled in with it.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteSummary } from '../../core'
import { errorCode } from '../../core/errors'

/** Looks up the headlines of notes by ID (see NoteService.headlines). */
export type HeadlineLoader = (ids: string[]) => Promise<Record<string, string>>

/** A headline, and the `updatedAt` of the note it was read for. */
export interface CachedHeadline {
  at: number
  text: string
}

/** Headlines kept, most recently read last; older ones are read again when shown. */
const KEPT = 2000

/** The untitled notes among `notes` whose headline is not in `cache` as of their last write. */
export function staleHeadlines(
  notes: readonly NoteSummary[],
  cache: ReadonlyMap<string, CachedHeadline>,
): NoteSummary[] {
  return notes.filter((n) => n.title === '' && cache.get(n.id)?.at !== n.updatedAt)
}

/** Drops the oldest entries of `cache` until at most `limit` are left. */
export function keepRecent(cache: Map<string, CachedHeadline>, limit: number) {
  for (const id of cache.keys()) {
    if (cache.size <= limit) return
    cache.delete(id)
  }
}

/**
 * `cache` with `found` (read for the writes in `at`) added. An answer for an
 * older write never replaces one read for a newer write.
 */
export function mergeHeadlines(
  cache: ReadonlyMap<string, CachedHeadline>,
  found: Readonly<Record<string, string>>,
  at: ReadonlyMap<string, number>,
): Map<string, CachedHeadline> {
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
export function useHeadlines(
  load: HeadlineLoader | undefined,
  notes: readonly NoteSummary[],
): ReadonlyMap<string, string> {
  const [cache, setCache] = useState<ReadonlyMap<string, CachedHeadline>>(() => new Map())
  // What was asked for and has not come back, so a render in between asks no more.
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (!load) return
    const keyOf = (n: NoteSummary) => `${n.id}@${n.updatedAt}`
    const ask = staleHeadlines(notes, cache).filter((n) => !asked.current.has(keyOf(n)))
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
  }, [load, notes, cache])
  return useMemo(() => {
    const shown = new Map<string, string>()
    for (const n of notes) {
      const text = n.title === '' ? cache.get(n.id)?.text : undefined
      if (text) shown.set(n.id, text)
    }
    return shown
  }, [notes, cache])
}
