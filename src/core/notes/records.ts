import * as Y from 'yjs'
import { errorCode } from '../errors'
import { clipTitle } from '../noteLimits'
import type { NoteRecord, OpenedRecord } from '../storage'
import { BODY } from './body'
import type { HeldRecord, Live } from './context'

/** Attempts when storage keeps refusing because another process wrote first; then the write fails like any other (see failed). */
const WRITE_TRIES = 5

const isStale = (error: unknown) => errorCode(error) === 'E_NOTE_BODY_STALE'

export const asWritten = <T extends HeldRecord>(record: T): T => ({
  ...record,
  bodyVersion: record.bodyVersion + 1,
})

export const untilWritten = async <T>(attempt: (retry: boolean) => Promise<T>): Promise<T> => {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt(tries > 1)
    } catch (error) {
      if (!isStale(error) || tries >= WRITE_TRIES) throw error
    }
  }
}

const META_HLCS = [
  'titleHlc',
  'bookHlc',
  'statusHlc',
  'pinnedHlc',
  'deletedHlc',
  'datesHlc',
] as const

export const stampsOf = (record: OpenedRecord) => META_HLCS.map((key) => record[key])

export type MetaField = 'book' | 'status' | 'pinned'

/** The record without its body, as a note in memory keeps it. */
export const heldOf = (record: OpenedRecord & Partial<NoteRecord>): HeldRecord => {
  const { ydoc: _, bodyMd: __, agentWrites: ___, ...held } = record
  return held
}

export const hlcOf = (record: HeldRecord, field: MetaField) =>
  field === 'book' ? record.bookHlc : field === 'status' ? record.statusHlc : record.pinnedHlc

export const withField = (record: HeldRecord, from: HeldRecord, field: MetaField): HeldRecord => {
  if (field === 'book') return { ...record, bookId: from.bookId, bookHlc: from.bookHlc }
  if (field === 'status') return { ...record, status: from.status, statusHlc: from.statusHlc }
  return { ...record, pinned: from.pinned, pinnedHlc: from.pinnedHlc }
}

/** Storage's merge: per field the newer HLC wins. A title past the limit is cut. */
export const withNewer = (to: HeldRecord, from: HeldRecord): HeldRecord => ({
  ...to,
  ...(from.titleHlc > to.titleHlc ? { title: clipTitle(from.title), titleHlc: from.titleHlc } : {}),
  ...(from.bookHlc > to.bookHlc ? { bookId: from.bookId, bookHlc: from.bookHlc } : {}),
  ...(from.statusHlc > to.statusHlc ? { status: from.status, statusHlc: from.statusHlc } : {}),
  ...(from.pinnedHlc > to.pinnedHlc ? { pinned: from.pinned, pinnedHlc: from.pinnedHlc } : {}),
  ...((from.deletedHlc ?? '') > (to.deletedHlc ?? '')
    ? { deletedAt: from.deletedAt, deletedHlc: from.deletedHlc }
    : {}),
  // Newer hand-set dates are taken as they are (see NoteRecord.datesHlc).
  ...((from.datesHlc ?? '') > (to.datesHlc ?? '')
    ? {
        createdAt: from.createdAt,
        updatedAt: from.updatedAt,
        datesHlc: from.datesHlc ?? '',
      }
    : (to.datesHlc ?? '') > (from.datesHlc ?? '')
      ? {}
      : { updatedAt: Math.max(to.updatedAt, from.updatedAt) }),
})

export const holdsMore = (doc: Y.Doc, stored: NoteRecord) => {
  if (doc.getText(BODY).toString() !== stored.bodyMd) return true
  const theirs = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(stored.ydoc))
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
    if (clock > (theirs.get(client) ?? 0)) return true
  }
  return false
}

export const dirty = (note: Live) =>
  note.edits !== note.savedEdits || META_HLCS.some((key) => note.record[key] !== note.saved[key])
