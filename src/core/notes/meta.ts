import { clipTitle } from '../noteLimits'
import { NOTE_STATUSES, type NoteRecord } from '../storage'
import { dirty, hlcOf, metaOf, untilWritten, withField, type MetaField } from './records'
import type { Live, NoteContext } from './context'
import type { Kernel } from './kernel'
import type { MetaChange, NoteService } from './types'

export function metaMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<
  NoteService,
  | 'setTitle'
  | 'setBook'
  | 'setStatus'
  | 'setStatusUndoable'
  | 'undoStatus'
  | 'setDates'
  | 'setPinned'
  | 'writeMeta'
  | 'checkBook'
> {
  const { storage, clock, now, live, loading, coldWrites } = ctx
  const { keepBaseline, recordEvents, sweep } = k.versions
  const { settle } = k.problems
  const { takeIn } = k.relay
  const { getStored, summaries, using } = k.memory
  const { exclusive, failed, write, save, schedule } = k.saving
  const { requireBook } = k.books
  const { retitle } = k.edits
  /** writeMeta for a note in memory. Returns the field's new HLC. */
  const writeLive = async (note: Live, change: MetaChange): Promise<string> => {
    const before = note.record
    const at = clock.tick()
    const field: MetaField = 'bookId' in change ? 'book' : 'status' in change ? 'status' : 'pinned'
    note.record = {
      ...note.record,
      ...('bookId' in change ? { bookId: change.bookId, bookHlc: at } : {}),
      ...('status' in change ? { status: change.status, statusHlc: at } : {}),
      ...('pinned' in change ? { pinned: change.pinned, pinnedHlc: at } : {}),
    }
    try {
      await exclusive(note, () => write(note))
    } catch (error) {
      // Not written: the field goes back, unless it changed again since.
      if (hlcOf(note.record, field) === at) note.record = withField(note.record, before, field)
      // The note's other changes stay pending, and are tried again.
      if (dirty(note)) failed(note, error)
      else settle(note)
      throw error
    }
    return at
  }

  /** writeMeta for a note not in memory: the stored record is rewritten with the field changed and its body as stored, so no Yjs document is built and the search index is left alone (schema v15). */
  // Writes of one note made this way go one at a time, and a load of it waits for them.
  const writeStored = (id: string, change: MetaChange): Promise<void> => {
    const run = (coldWrites.get(id) ?? Promise.resolve()).then(() =>
      untilWritten(async () => {
        const stored = await getStored(id)
        if (!stored) throw new Error('E_NOTE_NOT_FOUND')
        const title = clipTitle(stored.title)
        const before = title === stored.title ? stored : { ...stored, title }
        const at = clock.tick()
        const record: NoteRecord = {
          ...before,
          ...('bookId' in change ? { bookId: change.bookId, bookHlc: at } : {}),
          ...('status' in change ? { status: change.status, statusHlc: at } : {}),
          ...('pinned' in change ? { pinned: change.pinned, pinnedHlc: at } : {}),
          updatedAt: Math.max(now(), before.createdAt),
        }
        keepBaseline(id, {
          ydoc: stored.ydoc,
          text: stored.bodyMd,
          at: stored.updatedAt,
        })
        await storage.putNoteMeta(metaOf(record))
        recordEvents(undefined, before, record)
        sweep()
      }),
    )
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    coldWrites.set(id, settled)
    void settled.then(() => {
      if (coldWrites.get(id) === settled) coldWrites.delete(id)
    })
    return run
  }

  return {
    setTitle: (id, title) => using(id, (note) => retitle(note, title)),

    async setBook(id, bookId) {
      await requireBook(bookId)
      await using(id, (note) => {
        note.record = { ...note.record, bookId, bookHlc: clock.tick() }
        schedule(note)
      })
    },

    async setStatus(id, status) {
      if (!NOTE_STATUSES.includes(status)) throw new Error('E_NOTE_STATUS_INVALID')
      await using(id, (note) => {
        note.record = { ...note.record, status, statusHlc: clock.tick() }
        schedule(note)
      })
    },

    async setStatusUndoable(id, status) {
      if (!NOTE_STATUSES.includes(status)) throw new Error('E_NOTE_STATUS_INVALID')
      return using(id, async (note) => {
        // Written first: an earlier edit is not part of this change, nor its time.
        await save(note)
        const { status: was, updatedAt } = note.record
        const statusHlc = await writeLive(note, { status })
        return {
          status: was,
          updatedAt,
          statusHlc,
          bodyVersion: note.record.bodyVersion,
        }
      })
    },

    async undoStatus(id, undo) {
      if (!NOTE_STATUSES.includes(undo.status)) throw new Error('E_NOTE_STATUS_INVALID')
      await using(id, async (note) => {
        await save(note)
        await exclusive(note, async () => {
          // Sync writes storage directly: the note in memory may not have heard yet.
          // Every write moves the stored body version, so only a moved one is read whole.
          const [summary] = await summaries([id]).catch(() => [])
          if (summary?.bodyVersion !== note.record.bodyVersion) {
            const stored = await getStored(id, { trashed: true })
            // Storage lacks part of the document: written whole, even when the undo is not.
            if (stored && takeIn(note, stored)) {
              note.edits += 1
              schedule(note)
            }
          }
          if (note.record.statusHlc !== undo.statusHlc) return
          const at = clock.tick()
          const untouched = note.record.bodyVersion === undo.bodyVersion && !dirty(note)
          note.record = {
            ...note.record,
            status: undo.status,
            statusHlc: at,
            ...(untouched ? { updatedAt: undo.updatedAt, datesHlc: at } : {}),
          }
          try {
            await write(note)
          } catch (error) {
            failed(note, error)
            throw error
          }
        })
      })
    },

    async setDates(id, dates) {
      const valid = (at: number | undefined) =>
        at === undefined || (Number.isSafeInteger(at) && at >= 0)
      if (!valid(dates.createdAt) || !valid(dates.updatedAt)) {
        throw new Error('E_NOTE_TIME_INVALID')
      }
      await using(id, async (note) => {
        const createdAt = dates.createdAt ?? note.record.createdAt
        const updatedAt = dates.updatedAt ?? note.record.updatedAt
        if (updatedAt < createdAt) throw new Error('E_NOTE_TIME_INVALID')
        note.record = {
          ...note.record,
          createdAt,
          updatedAt,
          datesHlc: clock.tick(),
        }
        await save(note)
      })
    },

    setPinned: (id, pinned) =>
      using(id, (note) => {
        note.record = { ...note.record, pinned, pinnedHlc: clock.tick() }
        schedule(note)
      }),

    async writeMeta(id, change, writeOptions) {
      if ('bookId' in change && !writeOptions?.bookChecked) await requireBook(change.bookId)
      if ('status' in change && !NOTE_STATUSES.includes(change.status)) {
        throw new Error('E_NOTE_STATUS_INVALID')
      }
      if (!live.has(id) && !loading.has(id)) return writeStored(id, change)
      await using(id, (note) => writeLive(note, change))
    },

    checkBook: (bookId) => requireBook(bookId),
  }
}
