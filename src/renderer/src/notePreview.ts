// What a note link's hover card shows: the linked note's title and the start
// of its body (the plain-text excerpt the note list shows, pending edits
// included). The editor's hover, the preview's hover and the `[[` popup share
// one loader per core. A load is shared while it runs and its answer is kept
// briefly, so moving between links does not ask the core again; the answer
// goes stale after `PREVIEW_FRESH_MS`, so an edit shows on the next hover.
import type { Core } from './core-client'

export interface NotePreview {
  title: string
  excerpt: string
}

export const PREVIEW_FRESH_MS = 3000
export const PREVIEW_KEPT = 50

export type PreviewCore = {
  linkTargets: (ids: string[]) => Promise<Record<string, { title: string }>>
  excerpts: (ids: string[]) => Promise<Record<string, string>>
}

export type LoadPreview = (id: string) => Promise<NotePreview | null>

export function previewLoader(
  core: PreviewCore,
  now: () => number = Date.now,
  fresh = PREVIEW_FRESH_MS,
): LoadPreview {
  // Oldest first: a Map keeps insertion order.
  const kept = new Map<string, { at: number; preview: Promise<NotePreview | null> }>()
  return (id) => {
    const hit = kept.get(id)
    if (hit && now() - hit.at < fresh) return hit.preview
    kept.delete(id)
    const preview = Promise.all([core.linkTargets([id]), core.excerpts([id])]).then(
      ([targets, excerpts]) => {
        const target = targets[id]
        return target ? { title: target.title, excerpt: excerpts[id] ?? '' } : null
      },
    )
    // A failed load is not kept.
    preview.catch(() => {
      if (kept.get(id)?.preview === preview) kept.delete(id)
    })
    kept.set(id, { at: now(), preview })
    while (kept.size > PREVIEW_KEPT) kept.delete(kept.keys().next().value as string)
    return preview
  }
}

const loaders = new WeakMap<object, LoadPreview>()

export function previewsFor(core: Core): LoadPreview {
  let load = loaders.get(core)
  if (!load) {
    load = previewLoader(core)
    loaders.set(core, load)
  }
  return load
}
