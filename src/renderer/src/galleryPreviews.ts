// Gallery cards' page thumbnails, read from the core for the cards that render
// and kept by note ID and body version (`bodyVersion`) for the window's life, so
// scrolling back or switching the layout again draws them at once.
import type { RootContent } from 'hast'
import { useEffect, useMemo, useState } from 'react'
import type { NoteSummary } from '../../core'
import type { CardLabels } from '../../core/preview/card'
import { errorCode } from '../../core/errors'
import {
  keepRecent,
  mergeHeadlines,
  PendingReads,
  type CachedHeadline,
  type HeadlineLoader,
} from './headlines'
import { t } from './i18n'

export type CardPreview = RootContent[]
export type CardPreviewLoader = HeadlineLoader<CardPreview>

const KEPT = 500

let cache: ReadonlyMap<string, CachedHeadline<CardPreview>> = new Map()
const pending = new PendingReads<CardPreviewLoader>()
const listeners = new Set<() => void>()

export function cardLabels(): CardLabels {
  return {
    diagram: t('gallery.diagram'),
    math: t('gallery.math'),
    embed: t('gallery.embed'),
    image: t('gallery.image'),
    alerts: {
      note: t('alert.note'),
      tip: t('alert.tip'),
      important: t('alert.important'),
      warning: t('alert.warning'),
      caution: t('alert.caution'),
    },
  }
}

/** The thumbnail of each of `notes` (the cards that render) known for its version; the rest are read, and the cards render again when they arrive. */
export function useCardPreviews(
  load: CardPreviewLoader | undefined,
  notes: readonly NoteSummary[],
): ReadonlyMap<string, CardPreview> {
  const [seen, setSeen] = useState(cache)
  useEffect(() => {
    const changed = () => setSeen(cache)
    listeners.add(changed)
    return () => {
      listeners.delete(changed)
    }
  }, [])
  useEffect(() => {
    if (!load) return
    const keyOf = (n: NoteSummary) => `${n.id}@${n.bodyVersion}`
    const stale = notes.filter((n) => seen.get(n.id)?.at !== n.bodyVersion)
    const keys = pending.take(load, stale.map(keyOf))
    if (keys.length === 0) return
    const fresh = new Set(keys)
    const at = new Map(stale.filter((n) => fresh.has(keyOf(n))).map((n) => [n.id, n.bodyVersion]))
    void load([...at.keys()])
      .then((found) => {
        // A note gone meanwhile is known as empty, so it is not asked for again and again.
        const all = Object.fromEntries([...at.keys()].map((id) => [id, found[id] ?? []]))
        const next = mergeHeadlines(cache, all, at)
        keepRecent(next, KEPT)
        cache = next
        for (const listener of listeners) listener()
      })
      .catch((e: unknown) => console.warn('W_CARD_PREVIEWS_FAILED', errorCode(e)))
      .finally(() => pending.done(load, keys))
  }, [load, notes, seen])
  return useMemo(() => {
    const shown = new Map<string, CardPreview>()
    for (const n of notes) {
      const known = seen.get(n.id)
      if (known) shown.set(n.id, known.text)
    }
    return shown
  }, [notes, seen])
}
