// Runs the core library off the UI thread; the page passes in a storage adapter (Tauri commands are only reachable from the page).
import * as Comlink from 'comlink'
import {
  applyBatch,
  captureNote,
  createAiService,
  newWriter,
  createBookService,
  createClock,
  createIdGenerator,
  createMirrorRunner,
  createNoteService,
  createPieceRenderer,
  createPreviewRegistry,
  createTagService,
  createTemplateService,
  duplicateNote,
  exportMarkdown,
  importMarkdown,
  observeWrites,
  planExport,
  preparerHere,
  renderPreview,
  runHttpApiCall,
  type AiService,
  type WriterKind,
  type BatchChange,
  type MirrorHost,
  type MirrorRunner,
  type BookService,
  type ExportSink,
  type ExportTarget,
  type HttpApiCall,
  type ImportScan,
  type ImportSource,
  type NoteService,
  type NoteStatus,
  type TagService,
  type TemplateService,
  type PluginRendererSpec,
  type PreviewOptions,
  type RenderPluginBlock,
  type SearchScope,
  type StorageAdapter,
  type TagColor,
  type WelcomeContent,
  seedWelcome,
} from '../../core'
import { errorCode } from '../../core/errors'
import { createSyncEngine, type SyncEngine, type SyncStatus } from '../../core/sync/engine'
import type { SyncEvent } from '../../core/sync/transport'
import { preparerOffThread } from './importWorker'
import { fromWireRelay, toWireRelay, type RelayOut, type WireRelay } from './noteRelayWire'
import type { SaveProblemsMessage } from './saving'
import {
  fromWireSync,
  fromWireTransport,
  type WireSync,
  type WireTransport,
} from './storage/syncWire'
import { fromBase64, fromWire, toBase64, type WireStorage } from './storage/wire'
import { forwardWorkerLogs, type WorkerLogMessage } from './workerLog'

// The worker's own warnings, errors and uncaught failures go to the page,
// which writes them to the local log (see workerLog.ts).
forwardWorkerLogs(self, (message) => self.postMessage(message))

/** The core's info lines (I_AUTHORSHIP_*), which the console does not forward: codes and IDs only. */
const logInfo = (code: string, ...ids: string[]) =>
  self.postMessage({ workerLog: { level: 'info', code, ids } } satisfies WorkerLogMessage)

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
let httpApi: AiService | undefined
let sync: SyncEngine | undefined
let syncParts:
  | { storage: StorageAdapter; clock: ReturnType<typeof createClock>; newId: () => string }
  | undefined
// One piece renderer for the window's life, so piece keys never repeat; the plugins' renderers change under it.
let previewRegistry = createPreviewRegistry({ builtins: true })
let pluginRevision = 0
let pluginRender: RenderPluginBlock | undefined
const pieces = createPieceRenderer({
  registry: {
    register: (renderer) => previewRegistry.register(renderer),
    ids: () => previewRegistry.ids(),
    renderers: () => previewRegistry.renderers(),
  },
})

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
   * Starts the core on `remote`, the page's storage: Yjs states are coded here, off the UI thread (wire.ts), and a wrapper tells the Markdown mirror of every write. Unsaved notes are sent to the page as a SaveProblemsMessage each time that list changes, and what the core relays to the other windows and takes in from them as a RelayOut.
   * A lean core (a note window's, or a main window other than `main`) leaves compaction and the notebooks' order to the first main window's.
   */
  async init(remote: WireStorage, node: string, options: { lean?: boolean } = {}) {
    const clock = createClock(node)
    const ids = createIdGenerator()
    newId = ids
    const storage = observeWrites(fromWire(remote), () => {
      mirror?.touch()
      sync?.touch()
    })
    mirrorStorage = storage
    syncParts = { storage, clock, newId: ids }
    welcome = (content) => seedWelcome({ storage, clock, newId: ids, content })
    service = createNoteService({
      storage,
      clock,
      newId: ids,
      // On this worker's own channel, ahead of the reply to the call that
      // failed (see SaveProblemsMessage).
      onSaveProblems: (saveProblems) =>
        self.postMessage({ saveProblems } satisfies SaveProblemsMessage),
      relay: (message) =>
        self.postMessage({ noteRelay: toWireRelay(message, toBase64) } satisfies RelayOut),
      onTakenIn: (takenIn) => self.postMessage({ takenIn } satisfies RelayOut),
      compact: !options.lean,
      log: logInfo,
    })
    books = createBookService({ storage, clock, newId: ids })
    tags = createTagService({ storage, clock, newId: ids })
    templates = createTemplateService({ storage, notes: service, books, tags, clock, newId: ids })
    // Its own note service, as devot-mcp's: its writes reach the notes held
    // here as changes from outside (the page merges them, see httpApiHost).
    // One writer for each start of the core, which answers the HTTP API for as long as the app runs.
    const httpWriter = newWriter('http', '', node)
    httpApi = createAiService({
      storage,
      clock,
      newId: ids,
      writer: () => httpWriter,
      log: logInfo,
    })
    if (options.lean) return
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
  /** A quick capture from the menu bar, saved before it resolves (see captureNote). */
  capture: (title: string, markdown: string, bookId: string | null) =>
    captureNote(required(), { title, markdown, bookId }),
  /** A local HTTP API call (see httpApiHost), after pending edits are saved, so it reads and changes what the editor shows. */
  httpApi: async (call: HttpApiCall) => {
    const notes = required()
    if (!httpApi) throw new Error('E_CORE_NOT_READY')
    await notes.flush().catch(() => {})
    return runHttpApiCall(httpApi, call)
  },
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
  versionChanges: (id: string) => required().versionChanges(id),
  revisionText: (id: string, revisionId: string) => required().revisionText(id, revisionId),
  restorePassage: (id: string, revisionId: string, range: { from: number; to: number }) =>
    required().restorePassage(id, revisionId, range),
  applyAiEdit: (id: string, edit: { from: number; original: string; replacement: string }) =>
    required().applyAiEdit(id, edit),
  applyPluginEdit: (id: string, edit: { base: string; markdown: string }) =>
    required().applyPluginEdit(id, edit),
  undoAgentWrites: (id: string, writer: { kind: WriterKind; name: string }) =>
    required().undoAgentWrites(id, writer),
  clearAuthorship: (id: string) => required().clearAuthorship(id),
  agentWrites: (limit: number) => required().agentWrites(limit),
  markWritesSeen: (id: string, writeIds: string[]) => required().markWritesSeen(id, writeIds),
  activity: (now: number) => required().activity(now),
  noteActivity: (ids: string[], now: number) => required().noteActivity(ids, now),
  mergeStored: () => required().mergeStored(),
  /** What another window's core relayed (see NoteService.receive). */
  relayIn: (message: WireRelay) => required().receive(fromWireRelay(message, fromBase64)),
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
    const prepare = preparerOffThread(
      () => new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' }),
      preparerHere(newId),
      () => console.warn('W_IMPORT_WORKER_FAILED'),
    )
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
      prepare,
    })
    importing = run.catch(() => undefined).finally(prepare.close)
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
  /** The open note's preview in pieces; `known` are the keys of the pieces the page shows. */
  renderPreviewPieces: (markdown: string, options: PreviewOptions, known: string[]) =>
    pieces(markdown, { ...options, pluginRenderers: pluginRevision }, known),
  /** Plugins' preview renderers (ADR 0005); `render` asks the page, which asks the plugin. Pieces rendered before render again. */
  setPluginRenderers: (specs: PluginRendererSpec[], render: RenderPluginBlock) => {
    // The page sends `render` as a proxy; the one before is let go so its port closes.
    ;(pluginRender as Comlink.Remote<RenderPluginBlock> | undefined)?.[Comlink.releaseProxy]()
    pluginRender = render
    previewRegistry = createPreviewRegistry({ builtins: true, plugins: { specs, render } })
    pluginRevision += 1
  },
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
  /** Runs the sync engine on Rust's store and socket, which the page passes in. */
  startSync(
    store: WireSync,
    transport: WireTransport,
    onStatus: (status: SyncStatus) => void,
    onApplied: () => void,
  ) {
    if (sync || !syncParts) return
    sync = createSyncEngine({
      ...syncParts,
      sync: fromWireSync(store),
      transport: fromWireTransport(transport),
      onStatus: (status) => void Promise.resolve(onStatus(status)).catch(() => undefined),
      // The page merges the changes into the notes in memory and reloads, as for another process's writes.
      onApplied: () => void Promise.resolve(onApplied()).catch(() => undefined),
    })
    sync.start()
  },
  async stopSync() {
    const engine = sync
    sync = undefined
    await engine?.stop()
  },
  syncReceived: (event: SyncEvent) => sync?.received(event),
  syncTouch: () => sync?.touch(),
}

export type CoreApi = typeof coreApi

Comlink.expose(coreApi)
