// The plugin drawings the notes shown keep (ADR 0030), read through the core for a preview in a window without their
// plugin. Another process or device may change them: on a DB_CHANGED event a note shown is read again while its list
// stays shown, and its preview draws again only when the list changed. A shown note whose read failed is read again
// once after KEPT_RETRY_MS, then on each DB_CHANGED that names it, until a read answers.
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
export const KEPT_RETRY_MS = 1000
/** By note: its list, and a revision moved on each time the list a window shows changes. */
const kept = new Map<string, { list: readonly KeptDrawing[]; revision: number }>()
const reads = new Map<string, Read>()
/** Shown notes whose last read failed, with the timer of their one retry while it waits. */
const failed = new Map<string, ReturnType<typeof setTimeout> | undefined>()
const watchers = new Set<Watcher>()
let reader: ReadKeptDrawings | undefined
let revisions = 0

/** Moves on when the note's list changed, so its kept islands draw again and other notes' stay. */
export const keptDrawingsRevision = (noteId?: string): string =>
  String((noteId && kept.get(noteId)?.revision) ?? 0)

export const keptDrawingsOf = (noteId: string): readonly KeptDrawing[] | undefined =>
  kept.get(noteId)?.list

const keyOf = (d: KeptDrawing) => `${d.pluginId}\n${d.language}\n${d.hash}\n${d.appearance}`

function sameList(a: readonly KeptDrawing[], b: readonly KeptDrawing[]): boolean {
  if (a.length !== b.length) return false
  const svgs = new Map(a.map((d) => [keyOf(d), d.svg]))
  return b.every((d) => svgs.get(keyOf(d)) === d.svg)
}

const isShown = (noteId: string) => [...watchers].some((w) => w.shown() === noteId)

function take(noteId: string, list: readonly KeptDrawing[]): readonly KeptDrawing[] {
  const before = kept.get(noteId)
  const retried = failed.has(noteId)
  clearTimeout(failed.get(noteId))
  failed.delete(noteId)
  const changed = before ? !sameList(before.list, list) : retried
  kept.delete(noteId)
  kept.set(noteId, { list, revision: changed || !before ? (revisions += 1) : before.revision })
  if (kept.size > KEPT_NOTES) kept.delete(kept.keys().next().value!)
  if (changed) for (const w of watchers) if (w.shown() === noteId) w.changed()
  return list
}

/** A shown note is read again once soon, then only on a change; one no window shows is not. */
function readFailed(read: ReadKeptDrawings, noteId: string) {
  if (!isShown(noteId)) return
  const retry = () => {
    failed.set(noteId, undefined)
    if (isShown(noteId)) void readKept(read, noteId)
    else failed.delete(noteId)
  }
  failed.set(noteId, failed.has(noteId) ? undefined : setTimeout(retry, KEPT_RETRY_MS))
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
      if (!entry.outdated) readFailed(read, noteId)
      return entry.outdated ? readKept(read, noteId) : undefined
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
  const known = kept.get(noteId)?.list
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
  for (const [id, timer] of failed) {
    if (!touched(id) || timer !== undefined) continue
    if (reader && shown.has(id)) void readKept(reader, id)
    else failed.delete(id)
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
    if (watchers.size > 0) return
    window.removeEventListener(DB_CHANGED, onDbChanged)
    for (const timer of failed.values()) clearTimeout(timer)
    failed.clear()
  }
}
