// Runs the core library off the UI thread. The UI thread passes in a
// storage adapter (Tauri commands are only reachable from the page).
import * as Comlink from 'comlink'
import {
  applyBatch,
  createBookService,
  createClock,
  createIdGenerator,
  createMirrorRunner,
  createNoteService,
  createTagService,
  createTemplateService,
  duplicateNote,
  exportMarkdown,
  importMarkdown,
  observeWrites,
  planExport,
  renderPreview,
  type BatchChange,
  type MirrorHost,
  type MirrorRunner,
  type BookService,
  type ExportSink,
  type ExportTarget,
  type ImportScan,
  type ImportSource,
  type NoteService,
  type NoteStatus,
  type TagService,
  type TemplateService,
  type PreviewOptions,
  type SearchScope,
  type StorageAdapter,
  type TagColor,
} from '../../core'
import { errorCode } from '../../core/errors'
import type { SaveProblemsMessage } from './saving'
import { fromWire, type WireStorage } from './storage/wire'
import { forwardWorkerLogs } from './workerLog'

// The worker's own warnings, errors and uncaught failures go to the page,
// which writes them to the local log (see workerLog.ts).
forwardWorkerLogs(self, (message) => self.postMessage(message))

let service: NoteService | undefined
let books: BookService | undefined
let tags: TagService | undefined
let templates: TemplateService | undefined
let newId: (() => string) | undefined
// The running import, and whether it was asked to stop.
let importing: Promise<unknown> = Promise.resolve()
let stopImport = false
// The Markdown mirror's passes (core/mirror.ts), once the window starts them;
// the storage below calls `touch` after every write the mirror follows.
let mirror: MirrorRunner | undefined
let mirrorStorage: StorageAdapter | undefined

const required = () => {
  if (!service) throw new Error('E_CORE_NOT_READY')
  return service
}

const requiredTags = () => {
  if (!tags) throw new Error('E_CORE_NOT_READY')
  return tags
}

const requiredBooks = () => {
  if (!books) throw new Error('E_CORE_NOT_READY')
  return books
}

const requiredTemplates = () => {
  if (!templates) throw new Error('E_CORE_NOT_READY')
  return templates
}

export const coreApi = {
  /**
   * Starts the core on `remote`, the page's storage: Yjs states are coded
   * here, off the UI thread (see wire.ts), and a wrapper tells the Markdown
   * mirror of every write. Every note whose changes could not be saved yet is
   * sent to the page as a SaveProblemsMessage, each time that list changes
   * (see NoteServiceOptions).
   */
  async init(remote: WireStorage, node: string) {
    const clock = createClock(node)
    const ids = createIdGenerator()
    newId = ids
    const storage = observeWrites(fromWire(remote), () => mirror?.touch())
    mirrorStorage = storage
    service = createNoteService({
      storage,
      clock,
      newId: ids,
      // On this worker's own channel, ahead of the reply to the call that
      // failed (see SaveProblemsMessage).
      onSaveProblems: (saveProblems) =>
        self.postMessage({ saveProblems } satisfies SaveProblemsMessage),
    })
    books = createBookService({ storage, clock, newId: ids })
    tags = createTagService({ storage, clock, newId: ids })
    templates = createTemplateService({ storage, notes: service, books, tags, clock, newId: ids })
    // Notebooks from before sort keys get theirs, in the order they show.
    // On failure they keep showing in that order and the next start retries.
    await books
      .settleOrder()
      .catch((e: unknown) => console.warn('W_BOOK_ORDER_FAILED', errorCode(e)))
  },
  list: (limit?: number) => required().list(limit),
  create: (title?: string, bookId?: string | null) => required().create(title, bookId),
  /** A note's title and Yjs state; with `known`, only what that replica lacks. */
  open: (id: string, known?: Uint8Array) => required().open(id, known),
  /** A live note's title, loading the note for the editor to open next. */
  title: (id: string) => required().title(id),
  /** The editor shows the note: it stays in memory until `unhold` (see NoteService.hold). */
  hold: (id: string) => required().hold(id),
  unhold: (id: string) => required().unhold(id),
  /** A note's title and current Markdown (unsaved typing included). */
  read: (id: string) => required().read(id),
  /**
   * A copy of a note: titled "<title> <suffix>", with the status and the tags
   * `tagIds` (see duplicateNote).
   */
  duplicate: (id: string, suffix?: string, tagIds?: string[]) =>
    duplicateNote({ notes: required(), tags: requiredTags() }, id, {
      ...(suffix === undefined ? {} : { suffix }),
      ...(tagIds === undefined ? {} : { tagIds }),
    }),
  /** What each untitled note's row shows instead of a title (see NoteService.headlines). */
  headlines: (ids: string[]) => required().headlines(ids),
  /** A new note from text selected in `sourceId` (see NoteService.extract). */
  extract: (sourceId: string, markdown: string) => required().extract(sourceId, markdown),
  applyUpdate: (id: string, update: Uint8Array) => required().applyUpdate(id, update),
  /** Text into a note at a remembered position, for an editor that closed (see NoteService.insertAt). */
  insertAt: (id: string, anchor: Uint8Array | null, markdown: string) =>
    required().insertAt(id, anchor, markdown),
  setTitle: (id: string, title: string) => required().setTitle(id, title),
  setBook: (id: string, bookId: string | null) => required().setBook(id, bookId),
  setStatus: (id: string, status: NoteStatus) => required().setStatus(id, status),
  setPinned: (id: string, pinned: boolean) => required().setPinned(id, pinned),
  /** One change to several notes, note by note (see applyBatch). */
  batch: (ids: string[], change: BatchChange) =>
    applyBatch({ notes: required(), tags: requiredTags() }, ids, change),
  listTags: () => requiredTags().list(),
  addTag: (noteId: string, name: string) => requiredTags().addToNote(noteId, name),
  removeTag: (noteId: string, tagId: string) => requiredTags().removeFromNote(noteId, tagId),
  renameTag: (id: string, name: string) => requiredTags().rename(id, name),
  setTagColor: (id: string, color: TagColor | null) => requiredTags().setColor(id, color),
  deleteTag: (id: string) => requiredTags().remove(id),
  /**
   * With `versions` (quitting), typing not kept as a version yet becomes one.
   * Rejects with E_NOTE_SAVE_FAILED when a note could not be saved.
   */
  flush: (options?: { versions?: boolean }) => required().flush(options),
  /** Holds compaction sweeps before a backup restore (see NoteService.holdCompaction). */
  holdCompaction: () => required().holdCompaction(),
  resumeCompaction: () => required().resumeCompaction(),
  search: (query: string, scope?: SearchScope, options?: { flush?: boolean }) =>
    required().search(query, scope, options),
  trash: (id: string) => required().trash(id),
  restore: (id: string) => required().restore(id),
  listTrash: () => required().listTrash(),
  peekTrashed: (id: string) => required().peekTrashed(id),
  purge: (id: string) => required().purge(id),
  emptyTrash: () => required().emptyTrash(),
  history: (id: string) => required().history(id),
  compareRevision: (id: string, revisionId: string) => required().compareRevision(id, revisionId),
  restoreRevision: (id: string, revisionId: string) => required().restoreRevision(id, revisionId),
  /** The activity heatmap ending on the local day of `now` (the page's clock). */
  activity: (now: number) => required().activity(now),
  /** Another process wrote to the database: notes in memory take it in (see NoteService.mergeStored). */
  mergeStored: () => required().mergeStored(),
  /** The live notes and the templates, apart, from one listing. */
  listWithTemplates: () => requiredTemplates().listWithNotes(),
  createTemplate: () => requiredTemplates().create(),
  /**
   * What a note made from a template at `now` (the page's clock) would get,
   * and its notebook (`bookId` unless the template names one).
   */
  templateDraft: (id: string, now: number, bookId: string | null) =>
    requiredTemplates().draft(id, { now }, bookId),
  /** Makes a note from a template at `now`; it goes to `bookId` unless the template names one. */
  applyTemplate: (id: string, now: number, bookId: string | null) =>
    requiredTemplates().apply(id, { now }, bookId),
  listBooks: () => requiredBooks().list(),
  createBook: (name: string, parentId: string | null) => requiredBooks().create(name, parentId),
  renameBook: (id: string, name: string) => requiredBooks().rename(id, name),
  moveBook: (id: string, parentId: string | null) => requiredBooks().move(id, parentId),
  placeBook: (id: string, targetId: string, where: 'before' | 'after') =>
    requiredBooks().place(id, targetId, where),
  removeBook: (id: string) => requiredBooks().remove(id),
  setBookAiAccess: (id: string, on: boolean) => requiredBooks().setAiAccess(id, on),
  /** Imports a scanned Markdown folder; `source` reads its files. */
  importMarkdown: (
    scan: ImportScan,
    source: ImportSource,
    onProgress: (done: number, total: number) => void,
  ) => {
    if (!newId) throw new Error('E_CORE_NOT_READY')
    stopImport = false
    const run = importMarkdown({
      notes: required(),
      books: requiredBooks(),
      tags: requiredTags(),
      newId,
      scan,
      source,
      onProgress,
      stopped: () => stopImport,
    })
    importing = run.catch(() => undefined)
    return run
  },
  /** Stops a running import after the file it is on; resolves once it has. */
  stopImport: async () => {
    stopImport = true
    await importing
  },
  /** What exporting a note or a notebook writes, and where (see core/export.ts). */
  planExport: (target: ExportTarget, untitled: string) =>
    planExport({
      notes: required(),
      books: requiredBooks(),
      tags: requiredTags(),
      target,
      untitled,
    }),
  /** Exports a note or a notebook as Markdown files through `sink`. */
  exportMarkdown: (target: ExportTarget, sink: ExportSink, untitled: string) =>
    exportMarkdown({
      notes: required(),
      books: requiredBooks(),
      tags: requiredTags(),
      target,
      untitled,
      sink,
    }),
  /** Markdown to a sanitized hast tree for the preview. */
  renderPreview: (markdown: string, options: PreviewOptions) => renderPreview(markdown, options),
  /**
   * Gets the Markdown mirror ready (once); `host` reaches Rust's side of it,
   * `untitled` names notes without a title, `logFailure` logs a pass's error
   * code. Nothing runs until `mirrorReconcile`.
   */
  startMirror: (host: MirrorHost, untitled: string, logFailure: (code: string) => void) => {
    if (mirror || !mirrorStorage) return
    // Failures reach the app's log through the window (codes only).
    mirror = createMirrorRunner({ storage: mirrorStorage, host, untitled, onError: logFailure })
  },
  /**
   * The mirror is on (turned on, the window started, settings changed): a
   * full pass soon, unless one for Rust's `generation` ran already.
   */
  mirrorReconcile: (generation?: number) => mirror?.reconcile(generation),
  /** The database changed from outside (devot-mcp): the mirror follows at its next pass. */
  mirrorTouch: () => mirror?.touch(),
  /** A paused mirror checks its folder again (the window came to the front). */
  mirrorWake: () => mirror?.wake(),
  /** The mirror is off, or the app quits: ends a running pass after its current step. */
  mirrorStop: () => mirror?.stop(),
}

export type CoreApi = typeof coreApi

Comlink.expose(coreApi)
