// Runs the core library off the UI thread; the page passes in a storage adapter (Tauri commands are only reachable from the page).
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
  type WelcomeContent,
  seedWelcome,
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
let welcome: ((content: WelcomeContent) => Promise<string | null>) | undefined
let importing: Promise<unknown> = Promise.resolve()
let stopImport = false
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
  /** Starts the core on `remote`, the page's storage: Yjs states are coded here, off the UI thread (wire.ts), and a wrapper tells the Markdown mirror of every write. Unsaved notes are sent to the page as a SaveProblemsMessage each time that list changes. */
  async init(remote: WireStorage, node: string) {
    const clock = createClock(node)
    const ids = createIdGenerator()
    newId = ids
    const storage = observeWrites(fromWire(remote), () => mirror?.touch())
    mirrorStorage = storage
    welcome = (content) => seedWelcome({ storage, clock, newId: ids, content })
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
  seedWelcome: (content: WelcomeContent) => {
    if (!welcome) throw new Error('E_CORE_NOT_READY')
    return welcome(content)
  },
  list: (limit?: number) => required().list(limit),
  create: (title?: string, bookId?: string | null) => required().create(title, bookId),
  open: (id: string, known?: Uint8Array) => required().open(id, known),
  title: (id: string) => required().title(id),
  /** The editor shows the note: it stays in memory until `unhold` (see NoteService.hold). */
  hold: (id: string) => required().hold(id),
  unhold: (id: string) => required().unhold(id),
  read: (id: string) => required().read(id),
  duplicate: (id: string, suffix?: string, tagIds?: string[]) =>
    duplicateNote({ notes: required(), tags: requiredTags() }, id, {
      ...(suffix === undefined ? {} : { suffix }),
      ...(tagIds === undefined ? {} : { tagIds }),
    }),
  headlines: (ids: string[]) => required().headlines(ids),
  excerpts: (ids: string[]) => required().excerpts(ids),
  rowDetails: (ids: string[]) => required().rowDetails(ids),
  extract: (sourceId: string, markdown: string, title?: string) =>
    required().extract(sourceId, markdown, title),
  applyUpdate: (id: string, update: Uint8Array) => required().applyUpdate(id, update),
  insertAt: (id: string, anchor: Uint8Array | null, markdown: string) =>
    required().insertAt(id, anchor, markdown),
  setTitle: (id: string, title: string) => required().setTitle(id, title),
  setBook: (id: string, bookId: string | null) => required().setBook(id, bookId),
  setStatus: (id: string, status: NoteStatus) => required().setStatus(id, status),
  setPinned: (id: string, pinned: boolean) => required().setPinned(id, pinned),
  setNoteDates: (id: string, dates: { createdAt?: number; updatedAt?: number }) =>
    required().setDates(id, dates),
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
  holdCompaction: () => required().holdCompaction(),
  resumeCompaction: () => required().resumeCompaction(),
  search: (query: string, scope?: SearchScope, options?: { flush?: boolean }) =>
    required().search(query, scope, options),
  trash: (id: string) => required().trash(id),
  restore: (id: string) => required().restore(id),
  listTrash: () => required().listTrash(),
  peekTrashed: (id: string) => required().peekTrashed(id),
  backlinks: (id: string) => required().backlinks(id),
  linkTargets: (ids: string[]) => required().linkTargets(ids),
  purge: (id: string) => required().purge(id),
  emptyTrash: () => required().emptyTrash(),
  history: (id: string) => required().history(id),
  compareRevision: (id: string, revisionId: string) => required().compareRevision(id, revisionId),
  restoreRevision: (id: string, revisionId: string) => required().restoreRevision(id, revisionId),
  activity: (now: number) => required().activity(now),
  mergeStored: () => required().mergeStored(),
  listWithTemplates: () => requiredTemplates().listWithNotes(),
  createTemplate: () => requiredTemplates().create(),
  /**
   * Saves an edit of a template; a built-in one is read-only, so the edit
   * goes to a new template of the user's own (its ID is returned).
   */
  saveTemplate: (id: string, edit: { title?: string; body?: string }) =>
    requiredTemplates().save(id, edit),
  templateDraft: (id: string, now: number, bookId: string | null) =>
    requiredTemplates().draft(id, { now }, bookId),
  applyTemplate: (id: string, now: number, bookId: string | null) =>
    requiredTemplates().apply(id, { now }, bookId),
  applyTemplateTo: (id: string, noteId: string, now: number) =>
    requiredTemplates().applyTo(id, noteId, { now }),
  listBooks: () => requiredBooks().list(),
  createBook: (name: string, parentId: string | null) => requiredBooks().create(name, parentId),
  renameBook: (id: string, name: string) => requiredBooks().rename(id, name),
  moveBook: (id: string, parentId: string | null) => requiredBooks().move(id, parentId),
  placeBook: (id: string, targetId: string, where: 'before' | 'after') =>
    requiredBooks().place(id, targetId, where),
  removeBook: (id: string) => requiredBooks().remove(id),
  setBookAiAccess: (id: string, on: boolean) => requiredBooks().setAiAccess(id, on),
  setBookIcon: (id: string, icon: string | null, color: TagColor | null) =>
    requiredBooks().setIcon(id, icon, color),
  importMarkdown: (
    scan: ImportScan,
    destination: string | null,
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
      files: mirrorStorage,
      destination,
      onProgress,
      stopped: () => stopImport,
    })
    importing = run.catch(() => undefined)
    return run
  },
  stopImport: async () => {
    stopImport = true
    await importing
  },
  planExport: (target: ExportTarget, untitled: string) =>
    planExport({
      notes: required(),
      books: requiredBooks(),
      tags: requiredTags(),
      target,
      untitled,
    }),
  exportMarkdown: (target: ExportTarget, sink: ExportSink, untitled: string) =>
    exportMarkdown({
      notes: required(),
      books: requiredBooks(),
      tags: requiredTags(),
      target,
      untitled,
      sink,
    }),
  renderPreview: (markdown: string, options: PreviewOptions) => renderPreview(markdown, options),
  /** Prepares the mirror (once); nothing runs until `mirrorReconcile`. */
  startMirror: (host: MirrorHost, untitled: string, logFailure: (code: string) => void) => {
    if (mirror || !mirrorStorage) return
    // Failures reach the app's log through the window (codes only).
    mirror = createMirrorRunner({ storage: mirrorStorage, host, untitled, onError: logFailure })
  },
  /** A full pass soon, unless one for Rust's `generation` ran already. */
  mirrorReconcile: (generation?: number) => mirror?.reconcile(generation),
  mirrorTouch: () => mirror?.touch(),
  mirrorWake: () => mirror?.wake(),
  mirrorStop: () => mirror?.stop(),
}

export type CoreApi = typeof coreApi

Comlink.expose(coreApi)
