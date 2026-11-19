// The plugin drawings the notes shown keep (ADR 0030), read through the core for a preview in a window without their
// plugin. Another process or device may change them: on a DB_CHANGED event a note shown is read again while its list
// stays shown, and its preview draws again only when the list changed.
import type { KeptDrawing } from '../../../core/plugins/drawings'
import { DB_CHANGED, widened } from '../externalChanges'

export type ReadKeptDrawings = (noteId: string) => Promise<readonly KeptDrawing[]>

interface Read {
  answer: Promise<readonly KeptDrawing[] | undefined>
  /** A change came after it was asked, so its answer is not taken. */
  outdated: boolean
}

interface Watcher {
  shown: () => string | undefined
  changed: () => void
}

const KEPT_NOTES = 16
const kept = new Map<string, readonly KeptDrawing[]>()
const reads = new Map<string, Read>()
const watchers = new Set<Watcher>()
let reader: ReadKeptDrawings | undefined
let revision = 0

export const keptDrawingsRevision = (): string => String(revision)

export const keptDrawingsOf = (noteId: string): readonly KeptDrawing[] | undefined =>
  kept.get(noteId)

const keyOf = (d: KeptDrawing) => `${d.pluginId}\n${d.language}\n${d.hash}\n${d.appearance}`

function sameList(a: readonly KeptDrawing[], b: readonly KeptDrawing[]): boolean {
  if (a.length !== b.length) return false
  const svgs = new Map(a.map((d) => [keyOf(d), d.svg]))
  return b.every((d) => svgs.get(keyOf(d)) === d.svg)
}

function take(noteId: string, list: readonly KeptDrawing[]): readonly KeptDrawing[] {
  const before = kept.get(noteId)
  kept.delete(noteId)
  kept.set(noteId, list)
  if (kept.size > KEPT_NOTES) kept.delete(kept.keys().next().value!)
  if (before && !sameList(before, list)) {
    revision += 1
    for (const w of watchers) if (w.shown() === noteId) w.changed()
  }
  return list
}

function readKept(read: ReadKeptDrawings, noteId: string): Read['answer'] {
  const running = reads.get(noteId)
  if (running && !running.outdated) return running.answer
  const entry: Read = { answer: Promise.resolve(undefined), outdated: false }
  const settled = () => {
    if (reads.get(noteId) === entry) reads.delete(noteId)
  }
  entry.answer = read(noteId).then(
    (list) => {
      settled()
      return entry.outdated ? readKept(read, noteId) : take(noteId, list)
    },
    () => {
      settled()
      // Not kept: the next render reads again.
      console.warn('W_KEPT_DRAWINGS_READ_FAILED')
      return undefined
    },
  )
  reads.set(noteId, entry)
  return entry.answer
}

/** The note's drawings, read once until they change, one read at a time; undefined when the read failed. */
export function loadKeptDrawings(
  read: ReadKeptDrawings,
  noteId: string,
): Promise<readonly KeptDrawing[] | undefined> {
  reader = read
  const known = kept.get(noteId)
  return known ? Promise.resolve(known) : readKept(read, noteId)
}

/** The drawings of `notes` (of any note, without) may have changed: the ones shown are read again, the others let go. */
export function keptDrawingsChanged(notes?: ReadonlySet<string>): void {
  const touched = (id: string) => !notes || notes.has(id)
  for (const [id, read] of reads) if (touched(id)) read.outdated = true
  const shown = new Set([...watchers].map((w) => w.shown()))
  for (const id of [...kept.keys()]) {
    if (!touched(id)) continue
    if (reader && shown.has(id)) void readKept(reader, id)
    else kept.delete(id)
  }
}

/** The languages `drawings` are in, for the preview to make islands of their blocks. */
export const keptLanguages = (drawings: readonly KeptDrawing[]): string[] =>
  [...new Set(drawings.map((d) => d.language))].sort()

/** The drawing kept for a block; between plugins that drew the same block, the greatest ID, so every device shows one. */
export function findKeptDrawing(
  drawings: readonly KeptDrawing[],
  block: { language: string; hash: string; appearance: KeptDrawing['appearance'] },
): KeptDrawing | undefined {
  let found: KeptDrawing | undefined
  for (const d of drawings) {
    if (d.language !== block.language || d.hash !== block.hash) continue
    if (d.appearance !== block.appearance) continue
    if (!found || d.pluginId > found.pluginId) found = d
  }
  return found
}

const onDbChanged = (event: Event) => {
  const scope = widened(undefined, event)
  keptDrawingsChanged(scope === 'all' ? undefined : scope)
}

/** Calls `changed` when the list of the note `shown` names changed. */
export function watchKeptDrawings(
  shown: () => string | undefined,
  changed: () => void,
): () => void {
  const watcher = { shown, changed }
  if (watchers.size === 0) window.addEventListener(DB_CHANGED, onDbChanged)
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
    if (watchers.size === 0) window.removeEventListener(DB_CHANGED, onDbChanged)
  }
}
