// The plugin drawings the notes shown keep (ADR 0030), read through the core for a preview in a window without their
// plugin. Another process or device may change them: a DB_CHANGED event drops what was read, and the preview reads again.
import type { KeptDrawing } from '../../../core/plugins/drawings'
import { DB_CHANGED } from '../externalChanges'

export type ReadKeptDrawings = (noteId: string) => Promise<readonly KeptDrawing[]>

const KEPT_NOTES = 16
const kept = new Map<string, readonly KeptDrawing[]>()
const listeners = new Set<() => void>()
let revision = 0

export const keptDrawingsRevision = (): string => String(revision)

export const keptDrawingsOf = (noteId: string): readonly KeptDrawing[] | undefined =>
  kept.get(noteId)

/** The note's drawings, read once until they change; an answer to a read made before a change is not kept. */
export async function loadKeptDrawings(
  read: ReadKeptDrawings,
  noteId: string,
): Promise<readonly KeptDrawing[]> {
  const known = kept.get(noteId)
  if (known) return known
  const asked = revision
  let list: readonly KeptDrawing[]
  try {
    list = await read(noteId)
  } catch {
    // Kept as none, so the preview does not read again at every render; the next change reads again.
    console.warn('W_KEPT_DRAWINGS_READ_FAILED')
    list = []
  }
  if (asked === revision) {
    kept.set(noteId, list)
    if (kept.size > KEPT_NOTES) kept.delete(kept.keys().next().value!)
  }
  return list
}

export function keptDrawingsChanged(): void {
  kept.clear()
  revision += 1
  for (const listener of listeners) listener()
}

/** The languages `drawings` are in, for the preview to make islands of their blocks. */
export const keptLanguages = (drawings: readonly KeptDrawing[]): string[] =>
  [...new Set(drawings.map((d) => d.language))].sort()

export function findKeptDrawing(
  drawings: readonly KeptDrawing[],
  block: { language: string; hash: string; appearance: KeptDrawing['appearance'] },
): KeptDrawing | undefined {
  return drawings
    .filter(
      (d) =>
        d.language === block.language && d.hash === block.hash && d.appearance === block.appearance,
    )
    .at(-1)
}

const onDbChanged = () => keptDrawingsChanged()

export function onKeptDrawingsChanged(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener(DB_CHANGED, onDbChanged)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener(DB_CHANGED, onDbChanged)
  }
}
