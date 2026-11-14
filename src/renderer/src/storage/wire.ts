// Storage between the core worker and the page. Tauri commands are reachable
// from the page only, so the worker's storage calls cross to it. A note to
// write crosses as one buffer the worker lays out (`noteFrame`) and moves to
// the page without a copy, which hands it to note_put as the raw request
// body; a note opened for its editor (note_open) comes back as bytes the same
// way (`openedNote`). The worker finds the note's links and checks its limits,
// so the page reads nothing of either: a save or an open costs the UI thread
// no work for each byte of the note, which for a long, much-edited one is
// several MiB. A write that changed no text sends the fields alone
// (note_put_meta). A version's Yjs state still crosses as base64 coded in the
// worker (revision_put, revision_get), as does a note read whole (note_get).
import * as Comlink from 'comlink'
import type { NoteRecord, OpenedRecord, RevisionRecord, StorageAdapter } from '../../../core'
import { noteLinks } from '../../../core/links'
import { checkNote, checkNoteMeta } from '../../../core/noteLimits'

export type WireNote = Omit<NoteRecord, 'ydoc'> & { ydoc: string }
export type WireRevision = Omit<RevisionRecord, 'ydoc'> & { ydoc: string | null }

/** A note to write: the page reads its ID and date, and passes `frame` (`noteFrame`) on as it is. */
export interface WireNoteFrame {
  id: string
  updatedAt: number
  /** Whether it brings the note's agent_writes rows. */
  withRows: boolean
  frame: ArrayBuffer
}

export interface WireStorage extends Omit<
  StorageAdapter,
  'getNote' | 'openNote' | 'putNote' | 'getRevision' | 'putRevision'
> {
  getNote(id: string, options?: { trashed?: boolean }): Promise<WireNote | null>
  /** The note as `openedFrame` lays it out. */
  openNote(id: string): Promise<ArrayBuffer>
  putNote(note: WireNoteFrame): Promise<void>
  getRevision(id: string): Promise<WireRevision | null>
  putRevision(revision: WireRevision): Promise<void>
}

type NativeBytes = { toBase64?: (this: Uint8Array) => string }
type NativeCodec = { fromBase64?: (text: string) => Uint8Array }

const ALPHABET = new TextEncoder().encode(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
)
const PAD = 0x3d
const ascii = new TextDecoder()

export function toBase64(bytes: Uint8Array): string {
  const native = (Uint8Array.prototype as NativeBytes).toBase64
  if (native) return native.call(bytes)
  // Engines without one (V8 before 14) write the ASCII digits into bytes and
  // read them back as one string: a tenth of the time of building a binary
  // string for btoa.
  const full = bytes.length - (bytes.length % 3)
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4)
  let o = 0
  for (let i = 0; i < full; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o] = ALPHABET[v >>> 18]!
    out[o + 1] = ALPHABET[(v >>> 12) & 63]!
    out[o + 2] = ALPHABET[(v >>> 6) & 63]!
    out[o + 3] = ALPHABET[v & 63]!
    o += 4
  }
  if (full < bytes.length) {
    const two = full + 1 < bytes.length
    const v = (bytes[full]! << 16) | (two ? bytes[full + 1]! << 8 : 0)
    out[o] = ALPHABET[v >>> 18]!
    out[o + 1] = ALPHABET[(v >>> 12) & 63]!
    out[o + 2] = two ? ALPHABET[(v >>> 6) & 63]! : PAD
    out[o + 3] = PAD
  }
  return ascii.decode(out)
}

export function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as NativeCodec).fromBase64
  if (native) return native(text)
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

/**
 * A note as note_open sends it (`opened_frame` in src-tauri/src/commands/notes.rs): nothing for a
 * note not stored, otherwise the length of the fields' JSON (4 bytes, little-endian), the JSON,
 * then the Yjs state.
 */
export function openedFrame(note: OpenedRecord | null): ArrayBuffer {
  if (!note) return new ArrayBuffer(0)
  const { ydoc, ...fields } = note
  const json = utf8.encode(JSON.stringify(fields))
  const frame = new Uint8Array(4 + json.length + ydoc.length)
  new DataView(frame.buffer).setUint32(0, json.length, true)
  frame.set(json, 4)
  frame.set(ydoc, 4 + json.length)
  return frame.buffer
}

export function openedNote(frame: ArrayBuffer): OpenedRecord | null {
  if (frame.byteLength === 0) return null
  const length = new DataView(frame).getUint32(0, true)
  const fields = JSON.parse(fromUtf8.decode(new Uint8Array(frame, 4, length))) as Omit<
    OpenedRecord,
    'ydoc'
  >
  return { ...fields, ydoc: new Uint8Array(frame, 4 + length) }
}

/**
 * A note as note_put takes it (`note_frame` in src-tauri/src/commands/notes.rs): the length of the
 * JSON of its fields, its links and its agent_writes rows (4 bytes, little-endian), that JSON, the
 * length of its body, the body as UTF-8, then its Yjs state.
 */
export function noteFrame(note: NoteRecord, links: readonly string[]): ArrayBuffer {
  const { bodyMd, ydoc, agentWrites, ...fields } = note
  const json = utf8.encode(JSON.stringify({ note: fields, links, writes: agentWrites ?? null }))
  const body = utf8.encode(bodyMd)
  const frame = new Uint8Array(8 + json.length + body.length + ydoc.length)
  const view = new DataView(frame.buffer)
  view.setUint32(0, json.length, true)
  frame.set(json, 4)
  view.setUint32(4 + json.length, body.length, true)
  frame.set(body, 8 + json.length)
  frame.set(ydoc, 8 + json.length + body.length)
  return frame.buffer
}

/** `noteFrame` read back. */
export function framedNote(frame: ArrayBuffer): { note: NoteRecord; links: string[] } {
  const view = new DataView(frame)
  const jsonLength = view.getUint32(0, true)
  const { note, links, writes } = JSON.parse(
    fromUtf8.decode(new Uint8Array(frame, 4, jsonLength)),
  ) as {
    note: Omit<NoteRecord, 'bodyMd' | 'ydoc' | 'agentWrites'>
    links: string[]
    writes: NoteRecord['agentWrites'] | null
  }
  const bodyLength = view.getUint32(4 + jsonLength, true)
  const bodyAt = 8 + jsonLength
  return {
    note: {
      ...note,
      bodyMd: fromUtf8.decode(new Uint8Array(frame, bodyAt, bodyLength)),
      ydoc: new Uint8Array(frame.slice(bodyAt + bodyLength)),
      ...(writes ? { agentWrites: writes } : {}),
    },
    links,
  }
}

const noteIn = (note: WireNote): NoteRecord => ({ ...note, ydoc: fromBase64(note.ydoc) })
const revisionIn = (revision: WireRevision): RevisionRecord => ({
  ...revision,
  ydoc: revision.ydoc === null ? null : fromBase64(revision.ydoc),
})

/**
 * The worker's storage over the page's: notes are framed and states coded
 * here, and a note's links found and its limits checked here (what note_put
 * refuses is refused with its code before anything crosses). Every call is passed on by name:
 * the page's storage reaches the worker as a proxy, which has no methods of
 * its own to copy.
 */
export function fromWire(wire: WireStorage): StorageAdapter {
  return {
    listNotes: (page) => wire.listNotes(page),
    getSummaries: (ids) => wire.getSummaries(ids),
    async getNote(id, options) {
      const note = await wire.getNote(id, options)
      return note ? noteIn(note) : null
    },
    openNote: async (id) => openedNote(await wire.openNote(id)),
    getBodies: (ids) => wire.getBodies(ids),
    searchNotes: (query, limit) => wire.searchNotes(query, limit),
    semanticSearch: async (query) => {
      if (!wire.semanticSearch) throw new Error('E_SEMANTIC_UNAVAILABLE')
      return wire.semanticSearch(query)
    },
    semanticStatus: async () =>
      wire.semanticStatus ? wire.semanticStatus() : { state: 'unavailable' },
    listBacklinks: (id, excludeBookId, limit) => wire.listBacklinks(id, excludeBookId, limit),
    listLinkGraph: (excludeBookId, limit) => wire.listLinkGraph(excludeBookId, limit),
    listTrash: () => wire.listTrash(),
    purgeNote: (id, at, hlc) => wire.purgeNote(id, at, hlc),
    async putNote(note) {
      const links = noteLinks(note.bodyMd)
      checkNote(note, links)
      const frame = noteFrame(note, links)
      const { id, updatedAt } = note
      const framed = { id, updatedAt, withRows: note.agentWrites !== undefined, frame }
      await wire.putNote(Comlink.transfer(framed, [frame]))
    },
    async putNoteMeta(note) {
      checkNoteMeta(note)
      await wire.putNoteMeta(note)
    },
    putFile: (meta, data) => wire.putFile(meta, data),
    copyFiles: (noteId, copies) => wire.copyFiles(noteId, copies),
    listBooks: () => wire.listBooks(),
    isLiveBook: (id) => wire.isLiveBook(id),
    putBook: (book) => wire.putBook(book),
    putBooks: (books) => wire.putBooks(books),
    seedWelcome: (seed) => wire.seedWelcome(seed),
    listTags: () => wire.listTags(),
    putTag: (tag) => wire.putTag(tag),
    renameTag: (tag, searches) => wire.renameTag(tag, searches),
    listSavedSearches: () => wire.listSavedSearches(),
    putSavedSearch: (search) => wire.putSavedSearch(search),
    putNoteTag: (link) => wire.putNoteTag(link),
    getNoteTag: (noteId, tagId) => wire.getNoteTag(noteId, tagId),
    putRevision: (revision) =>
      wire.putRevision({
        ...revision,
        ydoc: revision.ydoc === null ? null : toBase64(revision.ydoc),
      }),
    listRevisions: (noteId) => wire.listRevisions(noteId),
    async getRevision(id) {
      const revision = await wire.getRevision(id)
      return revision ? revisionIn(revision) : null
    },
    deleteRevisions: (noteId, ids) => wire.deleteRevisions(noteId, ids),
    listCompactable: (from, to, after, limit) => wire.listCompactable(from, to, after, limit),
    compactRevisions: (ids, sweptAt) => wire.compactRevisions(ids, sweptAt),
    lastCompaction: () => wire.lastCompaction(),
    listActivity: (since) => wire.listActivity(since),
    listNoteActivity: (ids, since) => wire.listNoteActivity(ids, since),
    listAgentWrites: (limit) => wire.listAgentWrites(limit),
    authoredNotes: () => wire.authoredNotes(),
    markAgentWritesSeen: (noteId, writeIds) => wire.markAgentWritesSeen(noteId, writeIds),
  }
}

export function toWire(storage: StorageAdapter): WireStorage {
  return {
    ...storage,
    async getNote(id, options) {
      const note = await storage.getNote(id, options)
      return note ? { ...note, ydoc: toBase64(note.ydoc) } : null
    },
    openNote: async (id) => openedFrame(await storage.openNote(id)),
    putNote: ({ frame }) => storage.putNote(framedNote(frame).note),
    async getRevision(id) {
      const revision = await storage.getRevision(id)
      return revision
        ? { ...revision, ydoc: revision.ydoc === null ? null : toBase64(revision.ydoc) }
        : null
    },
    putRevision: (revision) => storage.putRevision(revisionIn(revision)),
  }
}
