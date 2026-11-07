import * as Y from 'yjs'
import { receiveStored } from '../hlc'
import { clipTitle } from '../noteLimits'
import { REVISION_PAUSE_MS } from '../revisions'
import { MAX_BODY_IDS, type NoteBody, type NoteRecord, type NoteSummary } from '../storage'
import { BODY } from './body'
import type { Live, NoteContext } from './context'
import type { Kernel } from './kernel'
import { dirty, stampsOf } from './records'

/** Notes beyond this go once nothing of them can be lost (see trim); held and busy notes stay besides. */
export const NOTES_IN_MEMORY = 8

/** The notes a note service holds in memory: reading them in, using them, and letting them go. */
export function createMemory(ctx: NoteContext, k: Pick<Kernel, 'versions' | 'problems' | 'relay'>) {
  const { storage, clock, options, now, live, loading, holds, coldWrites, failing } = ctx
  const { stopTimers, takeVersion } = k.versions
  const { settle } = k.problems
  const { relay, relayChanges } = k.relay
  const liveNote = (record: NoteRecord, doc: Y.Doc, fresh: boolean): Live => {
    relayChanges(record.id, doc)
    const note: Live = {
      record,
      saved: record,
      doc,
      state: undefined,
      timer: undefined,
      edits: 0,
      savedEdits: 0,
      queue: Promise.resolve(),
      writes: 0,
      users: 0,
      retitled: false,
      rows: fresh ? [] : undefined,
      failures: 0,
      retry: undefined,
      rev: {
        checked: fresh,
        lastText: fresh ? '' : undefined,
        pending: false,
        pause: undefined,
        every: undefined,
        title: undefined,
      },
    }
    doc.on('update', () => {
      note.state = undefined
    })
    return note
  }

  const drop = (note: Live) => {
    clearTimeout(note.timer)
    note.timer = undefined
    stopTimers(note)
    if (live.get(note.record.id) === note) live.delete(note.record.id)
    settle(note)
  }

  /** Pending edits included: a note in memory is read from its document, the rest in batched storage reads. */
  const bodies = async (ids: readonly string[]): Promise<NoteBody[]> => {
    const found: NoteBody[] = []
    const stored: string[] = []
    for (const id of new Set(ids)) {
      const note = live.get(id)
      if (note)
        found.push({
          id,
          title: note.record.title,
          bodyMd: note.doc.getText(BODY).toString(),
        })
      else stored.push(id)
    }
    const batches: Promise<NoteBody[]>[] = []
    for (let i = 0; i < stored.length; i += MAX_BODY_IDS) {
      batches.push(storage.getBodies(stored.slice(i, i + MAX_BODY_IDS)))
    }
    for (const batch of await Promise.all(batches)) found.push(...batch)
    return found
  }

  const summaries = async (ids: readonly string[]): Promise<NoteSummary[]> => {
    const batches: Promise<NoteSummary[]>[] = []
    for (let i = 0; i < ids.length; i += MAX_BODY_IDS) {
      batches.push(storage.getSummaries(ids.slice(i, i + MAX_BODY_IDS)))
    }
    return (await Promise.all(batches)).flat()
  }

  const getStored = async (id: string, which?: { trashed: boolean }) => {
    const record = await storage.getNote(id, which)
    if (record) receiveStored(clock, stampsOf(record))
    return record
  }

  /** Calls that ask for a note while it is being read share that read: one note in memory, never two. */
  const load = (id: string): Promise<Live> => {
    const cached = live.get(id)
    if (cached) {
      live.delete(id)
      live.set(id, cached)
      cached.users += 1
      return Promise.resolve(cached)
    }
    let reading = loading.get(id)
    if (!reading) {
      const pending = {
        note: Promise.resolve() as unknown as Promise<Live>,
        users: 0,
      }
      pending.note = (async () => {
        try {
          await coldWrites.get(id)
          const opened = await storage.openNote(id)
          if (!opened) throw new Error('E_NOTE_NOT_FOUND')
          receiveStored(clock, stampsOf(opened))
          const doc = new Y.Doc()
          Y.applyUpdate(doc, opened.ydoc)
          // A title stored past the limit (by an older build) is cut here, so
          // the note's writes are taken. The stored one stays until a rename:
          // a write with the same HLC never replaces it.
          const record: NoteRecord = {
            ...opened,
            title: clipTitle(opened.title),
            bodyMd: doc.getText(BODY).toString(),
          }
          const note = liveNote(record, doc, false)
          note.state = opened.ydoc
          note.users = pending.users
          live.set(id, note)
          if (options.relay) relay({ kind: 'want', noteId: id, data: Y.encodeStateVector(doc) })
          return note
        } finally {
          loading.delete(id)
        }
      })()
      loading.set(id, pending)
      reading = pending
    }
    reading.users += 1
    return reading.note
  }

  const using = async <T>(id: string, work: (note: Live) => T | Promise<T>): Promise<T> => {
    const note = await load(id)
    try {
      return await work(note)
    } finally {
      note.users -= 1
      trim()
    }
  }

  // Nothing of the note would be lost if it left memory: no user, no editor hold, no write pending or failed, title not being typed.
  const idle = (note: Live) =>
    note.users === 0 &&
    note.writes === 0 &&
    note.timer === undefined &&
    note.retry === undefined &&
    !dirty(note) &&
    !holds.has(note.record.id) &&
    !failing.has(note.record.id) &&
    !(note.rev.title && now() - note.rev.title.at < REVISION_PAUSE_MS)

  // Lets the least recently used idle notes go beyond NOTES_IN_MEMORY; unversioned typing becomes a version first.
  const trim = () => {
    let over = live.size - NOTES_IN_MEMORY
    for (const note of live.values()) {
      if (over <= 0) return
      if (!idle(note)) continue
      takeVersion(note)
      drop(note)
      over -= 1
    }
  }

  /** A note in memory, or one being read in once it is; undefined when neither. */
  const inMemory = async (id: string) => {
    const note = live.get(id) ?? (await loading.get(id)?.note.catch(() => undefined))
    return note && live.get(id) === note ? note : undefined
  }

  return { liveNote, drop, bodies, summaries, getStored, load, using, trim, inMemory }
}
