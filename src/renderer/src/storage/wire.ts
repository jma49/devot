// Storage between the core worker and the page. Tauri commands are reachable
// from the page only, so the worker's storage calls cross to it; a note's or
// a version's Yjs state crosses as the base64 string the commands take
// (note_put, note_get, revision_put, revision_get). The worker codes it
// (fromWire), finds the note's links and checks its limits, so the page
// hands what it gets to the commands without reading it: a save or an open
// costs the UI thread no work for each byte of a state, which for a long,
// much-edited note is several MiB. A note opened for its editor (note_open)
// comes as bytes, its state as stored and no body (see `openedNote`), which
// the page passes on without decoding any JSON.
import type { NoteRecord, OpenedRecord, RevisionRecord, StorageAdapter } from '../../../core'
import { noteLinks } from '../../../core/links'
import { checkNote } from '../../../core/noteLimits'

export type WireNote = Omit<NoteRecord, 'ydoc'> & { ydoc: string }
export type WireRevision = Omit<RevisionRecord, 'ydoc'> & { ydoc: string | null }

export interface WireStorage extends Omit<
  StorageAdapter,
  'getNote' | 'openNote' | 'putNote' | 'getRevision' | 'putRevision'
> {
  getNote(id: string, options?: { trashed?: boolean }): Promise<WireNote | null>
  /** The note as `openedFrame` lays it out. */
  openNote(id: string): Promise<ArrayBuffer>
  putNote(note: WireNote, links: string[]): Promise<void>
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

const noteIn = (note: WireNote): NoteRecord => ({ ...note, ydoc: fromBase64(note.ydoc) })
const revisionIn = (revision: WireRevision): RevisionRecord => ({
  ...revision,
  ydoc: revision.ydoc === null ? null : fromBase64(revision.ydoc),
})

/**
 * The worker's storage over the page's: states are coded here, and a note's
 * links found and its limits checked here (what note_put refuses is refused
 * with its code before anything crosses). Every call is passed on by name:
 * the page's storage reaches the worker as a proxy, which has no methods of
 * its own to copy.
 */
export function fromWire(wire: WireStorage): StorageAdapter {
  return {
    listNotes: () => wire.listNotes(),
    async getNote(id, options) {
      const note = await wire.getNote(id, options)
      return note ? noteIn(note) : null
    },
    openNote: async (id) => openedNote(await wire.openNote(id)),
    getBodies: (ids) => wire.getBodies(ids),
    searchNotes: (query, limit) => wire.searchNotes(query, limit),
    listBacklinks: (id, excludeBookId, limit) => wire.listBacklinks(id, excludeBookId, limit),
    listTrash: () => wire.listTrash(),
    purgeNote: (id, at, hlc) => wire.purgeNote(id, at, hlc),
    async putNote(note) {
      const links = noteLinks(note.bodyMd)
      checkNote(note, links)
      await wire.putNote({ ...note, ydoc: toBase64(note.ydoc) }, links)
    },
    putFile: (meta, data) => wire.putFile(meta, data),
    copyFiles: (noteId, copies) => wire.copyFiles(noteId, copies),
    listBooks: () => wire.listBooks(),
    putBook: (book) => wire.putBook(book),
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
    putNote: (note) => storage.putNote(noteIn(note)),
    async getRevision(id) {
      const revision = await storage.getRevision(id)
      return revision
        ? { ...revision, ydoc: revision.ydoc === null ? null : toBase64(revision.ydoc) }
        : null
    },
    putRevision: (revision) => storage.putRevision(revisionIn(revision)),
  }
}
