import * as Y from 'yjs'
import { agentWriteRows } from '../authorship'
import { TEMPLATES_BOOK_ID } from '../books'
import { extractTitle } from '../extract'
import { fileLinkSpans, newFileCopies, replaceFileLinks, type FileCopy } from '../files'
import { clipTitle, MAX_TITLE_CHARS } from '../noteLimits'
import type { NoteRecord, NoteStatus } from '../storage'
import { lineFeeds } from '../text'
import { BODY, seedClient } from './body'
import { asWritten } from './records'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

export function creatingMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<NoteService, 'list' | 'create' | 'seed' | 'duplicate' | 'extract'> {
  const { storage, clock, newId, now, live } = ctx
  const { relay } = k.relay
  const { liveNote, trim, using } = k.memory
  const { requireBook, liveBook } = k.books
  /** Writes a new note holding `doc`, a body taken from another note, in one write so it is never stored empty. Attachments belong to one note: `doc` must already show `copies` (see newFileCopies), made in the same write; if that fails the new note is purged and the copy's error thrown. */
  const insertNote = async (
    title: string,
    bookId: string | null,
    doc: Y.Doc,
    copies: readonly FileCopy[],
    status: NoteStatus = 'none',
    id = newId(),
    rowsSeen = false,
    pinned = false,
  ) => {
    const at = now()
    const record: NoteRecord = {
      id,
      title: clipTitle(title),
      titleHlc: clock.tick(),
      bodyMd: doc.getText(BODY).toString(),
      ydoc: Y.encodeStateAsUpdate(doc),
      bodyVersion: 0,
      bookId,
      bookHlc: bookId === null ? '' : clock.tick(),
      status,
      statusHlc: status === 'none' ? '' : clock.tick(),
      pinned,
      pinnedHlc: pinned ? clock.tick() : '',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      deletedHlc: null,
    }
    const rows = agentWriteRows(doc, id)
    await storage.putNote({ ...record, agentWrites: rows })
    if (rowsSeen && rows.length > 0) {
      await storage.markAgentWritesSeen(
        id,
        rows.map((row) => row.writeId),
      )
    }
    relay({
      kind: 'saved',
      noteId: id,
      updatedAt: at,
      ...(rows.length > 0 ? { authored: true } : {}),
    })
    const note = liveNote(asWritten(record), doc, false)
    note.rows = rows
    live.set(id, note)
    trim()
    if (copies.length === 0) return id
    try {
      await storage.copyFiles(id, copies)
    } catch (error) {
      live.delete(id)
      // Storage purges only a trashed note.
      await storage
        .putNote({ ...asWritten(record), deletedAt: now(), deletedHlc: clock.tick() })
        .then(() => storage.purgeNote(id, now(), clock.tick()))
        .catch(() => console.warn('W_NOTE_COPY_CLEANUP_FAILED', id))
      throw error
    }
    return id
  }

  return {
    list: (limit) =>
      storage.listNotes({
        excludeBookId: TEMPLATES_BOOK_ID,
        ...(limit === undefined ? {} : { limit }),
      }),

    async create(title = '', bookId = null) {
      await requireBook(bookId)
      const doc = new Y.Doc()
      doc.getText(BODY)
      const at = now()
      const record: NoteRecord = {
        id: newId(),
        title: clipTitle(title),
        titleHlc: clock.tick(),
        bodyMd: '',
        ydoc: Y.encodeStateAsUpdate(doc),
        bodyVersion: 0,
        bookId,
        bookHlc: bookId === null ? '' : clock.tick(),
        status: 'none',
        statusHlc: '',
        pinned: false,
        pinnedHlc: '',
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        deletedHlc: null,
      }
      await storage.putNote(record)
      relay({ kind: 'saved', noteId: record.id, updatedAt: at })
      live.set(record.id, liveNote(asWritten(record), doc, true))
      trim()
      return record.id
    },

    async seed(id, title, bookId, markdown, pinned = false) {
      const seeded = new Y.Doc()
      seeded.clientID = seedClient(id, markdown)
      seeded.getText(BODY).insert(0, lineFeeds(markdown))
      // Edits go on under a client of this device's own: two devices writing as the seed's client would give two changes one ID.
      const doc = new Y.Doc()
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded))
      await insertNote(title, await liveBook(bookId), doc, [], 'none', id, false, pinned)
    },

    duplicate: (id, copy) =>
      using(id, async (source) => {
        const doc = new Y.Doc()
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc))
        // The links take their copies' IDs as edits to the source's state:
        // only the IDs' characters change, so a size preset after one stays.
        const text = doc.getText(BODY)
        const markdown = text.toString()
        const copies = newFileCopies(markdown, newId)
        const to = new Map(copies.map((c) => [c.from, c.to]))
        doc.transact(() => {
          // From the end, so the offsets still ahead stay right.
          for (const { id: from, index } of fileLinkSpans(markdown).reverse()) {
            text.delete(index, from.length)
            text.insert(index, to.get(from) as string)
          }
        })
        const { title } = source.record
        // The original is cut to make room, so the suffix always survives.
        const tail = copy?.suffix ? ` ${copy.suffix}` : ''
        const room = Math.max(0, MAX_TITLE_CHARS - [...tail].length)
        return insertNote(
          title !== '' && tail ? `${[...title].slice(0, room).join('')}${tail}` : title,
          await liveBook(source.record.bookId),
          doc,
          copies,
          source.record.status,
          newId(),
          // The copy keeps the authorship; the owner made it, so its writes start seen (ADR 0007).
          true,
        )
      }),

    async extract(sourceId, markdown, given) {
      const bookId = await using(sourceId, (source) => source.record.bookId)
      const title = given === undefined ? extractTitle(markdown) : clipTitle(given)
      const moved = lineFeeds(markdown)
      const copies = newFileCopies(moved, newId)
      const doc = new Y.Doc()
      doc.getText(BODY).insert(0, replaceFileLinks(moved, copies))
      const id = await insertNote(title, await liveBook(bookId), doc, copies)
      return { id, title }
    },
  }
}
