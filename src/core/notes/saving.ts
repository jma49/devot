import * as Y from 'yjs'
import { agentWriteRows, sameRows, type AgentWriteRow } from '../authorship'
import { errorCode } from '../errors'
import type { NoteRecord } from '../storage'
import { BODY } from './body'
import type { Live, NoteContext } from './context'
import type { Kernel } from './kernel'
import { asWritten, dirty, heldOf, untilWritten } from './records'
import type { NoteService } from './types'

/** Each save encodes a note's whole Yjs state, so a note whose state is past the first size waits longer after a pause, up to SAVE_DELAY_STRETCH times as long at the second. */
const SAVE_DELAY_FROM_BYTES = 64 * 1024
const SAVE_DELAY_FULL_BYTES = 1024 * 1024
/** 2 s for the default 300 ms. */
const SAVE_DELAY_STRETCH = 2_000 / 300

/** How long after a pause a note whose state takes `stateBytes` is saved, for `baseMs` (NoteServiceOptions.saveDelayMs) a small note waits. */
export function saveDelay(baseMs: number, stateBytes: number): number {
  const span = SAVE_DELAY_FULL_BYTES - SAVE_DELAY_FROM_BYTES
  const share = Math.min(1, Math.max(0, (stateBytes - SAVE_DELAY_FROM_BYTES) / span))
  return Math.round(baseMs * (1 + (SAVE_DELAY_STRETCH - 1) * share))
}

const MAX_RETRY_MS = 30_000

const codeOf = (error: unknown) => errorCode(error, 'E_STORAGE_WRITE_FAILED')

/** Writes of the notes in memory: scheduled after a pause, one at a time per note, retried when they fail. */
export function createSaving(
  ctx: NoteContext,
  k: Pick<Kernel, 'versions' | 'problems' | 'relay' | 'memory'>,
) {
  const { storage, options, now, live, failing } = ctx
  const saveDelayMs = options.saveDelayMs ?? 300
  const retryDelayMs = options.retryDelayMs ?? 1000
  const { unchecked, keepBaseline, recordEvents, sweep } = k.versions
  const { report, settle } = k.problems
  const { relay, takeIn } = k.relay
  const { drop, getStored, trim } = k.memory
  /** Serialises writes of a note so they never overlap and land in the order asked for. */
  const exclusive = <T>(note: Live, work: () => Promise<T>): Promise<T> => {
    note.writes += 1
    const run = note.queue.then(work)
    note.queue = run.then(
      () => undefined,
      () => undefined,
    )
    void note.queue.then(() => {
      note.writes -= 1
      trim()
    })
    return run
  }

  // The changes stay pending: retried after a delay that doubles with each failure in a row, and reported.
  const failed = (note: Live, error: unknown) => {
    const { id } = note.record
    // A note let go meanwhile is not tried again.
    if (live.get(id) !== note) return
    note.failures += 1
    clearTimeout(note.retry)
    note.retry = undefined
    const code = codeOf(error)
    // A purged note is never written again: reported, but not retried.
    if (code !== 'E_NOTE_PURGED')
      note.retry = setTimeout(
        () => {
          note.retry = undefined
          save(note).catch(() => {})
        },
        Math.min(retryDelayMs * 2 ** (note.failures - 1), MAX_RETRY_MS),
      )
    if (failing.get(id) === code) return
    failing.set(id, code)
    report()
  }

  /** Retries up to WRITE_TRIES times after taking in the stored copy when another process wrote first. Returns undefined when the note was deleted for good meanwhile (it is let go). Runs only through exclusive. */
  const put = (note: Live, make: () => NoteRecord): Promise<NoteRecord | undefined> =>
    untilWritten(async (retry) => {
      if (retry) {
        const stored = await getStored(note.record.id, { trashed: true })
        if (!stored) {
          drop(note)
          return undefined
        }
        const title = note.record.title
        takeIn(note, stored)
        if (note.record.title !== title) note.retitled = true
      }
      const record = make()
      await storage.putNote(record)
      return record
    })

  /** The rows to write with the note: undefined (left as stored) when they are what storage holds. */
  const rowsOf = (note: Live) => {
    const rows = agentWriteRows(note.doc, note.record.id)
    return { rows, changed: sameRows(note.rows, rows) ? undefined : rows }
  }

  const write = async (note: Live) => {
    if (!dirty(note) || live.get(note.record.id) !== note) return
    // A title, notebook, status or pin change before any body edit moves
    // `updatedAt`: keep the body as a version first, dated by its own save.
    const body = unchecked(note)
    if (body) {
      note.rev.checked = true
      keepBaseline(note.record.id, body, note.rev)
    }
    let edits = note.edits
    let rows: readonly AgentWriteRow[] | undefined
    const record = await put(note, () => {
      edits = note.edits
      const datesSet = (note.record.datesHlc ?? '') > (note.saved.datesHlc ?? '')
      const derived = rowsOf(note)
      rows = derived.rows
      const state = Y.encodeStateAsUpdate(note.doc)
      note.state = state
      note.record = {
        ...note.record,
        updatedAt: datesSet ? note.record.updatedAt : Math.max(now(), note.record.createdAt),
      }
      return {
        ...note.record,
        bodyMd: note.doc.getText(BODY).toString(),
        ydoc: state,
        ...(derived.changed ? { agentWrites: derived.changed } : {}),
      }
    })
    if (!record) return
    // A note's first write here writes its rows again; none where none were known tells no one.
    const authored =
      record.agentWrites !== undefined && (note.rows !== undefined || record.agentWrites.length > 0)
    note.rows = rows
    relay({
      kind: 'saved',
      noteId: record.id,
      updatedAt: record.updatedAt,
      ...(authored ? { authored: true } : {}),
    })
    note.stateBytes = record.ydoc.byteLength
    const written = asWritten(heldOf(record))
    note.record = { ...note.record, bodyVersion: written.bodyVersion }
    const before = note.saved
    note.saved = written
    note.savedEdits = edits
    settle(note)
    recordEvents(note.rev, before, written)
    sweep()
  }

  const save = (note: Live): Promise<void> => {
    clearTimeout(note.timer)
    note.timer = undefined
    return exclusive(note, async () => {
      try {
        await write(note)
      } catch (error) {
        failed(note, error)
        throw error
      }
    })
  }

  const saveAll = () => Promise.allSettled([...live.values()].map(save))

  const schedule = (note: Live) => {
    clearTimeout(note.timer)
    const delay = saveDelay(saveDelayMs, note.stateBytes)
    note.timer = setTimeout(() => {
      note.timer = undefined
      save(note).catch(() => {})
    }, delay)
  }

  return { exclusive, failed, put, rowsOf, write, save, saveAll, schedule }
}

export function savingMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<NoteService, 'release' | 'flush' | 'holdCompaction' | 'resumeCompaction'> {
  const { live } = ctx
  const { stopTimers, takeVersion, settled } = k.versions
  const { drop } = k.memory
  const { exclusive, write, save } = k.saving
  return {
    // Released notes (import, the AI service) take no version here: the saved
    // body is the latest text, and the next edit keeps it (keepBaseline).
    async release(id) {
      const note = live.get(id)
      if (!note) return
      stopTimers(note)
      try {
        await exclusive(note, () => write(note))
      } finally {
        // Let go even when the write failed: the caller undoes or reports
        // the note, and a later retry must not write it after all.
        drop(note)
      }
      await settled()
    },

    async flush(quitting) {
      const notes = [...live.values()]
      const saved = await Promise.allSettled(notes.map(save))
      if (quitting?.versions) for (const note of live.values()) takeVersion(note)
      await settled()
      const unsaved = notes.filter((_, i) => saved[i]?.status === 'rejected')
      if (unsaved.length > 0) {
        throw new Error(`E_NOTE_SAVE_FAILED ${unsaved.map((n) => n.record.id).join(' ')}`)
      }
    },

    holdCompaction: () => k.versions.holdCompaction(),
    resumeCompaction: () => k.versions.resumeCompaction(),
  }
}
