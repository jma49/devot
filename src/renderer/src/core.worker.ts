// Runs the core library off the UI thread; the page passes in a storage adapter (Tauri commands are only reachable from the page).
import * as Comlink from 'comlink'
import type { RootContent } from 'hast'
import type {
  AppendOptions,
  DailyNotesSettings,
  AiService,
  Writer,
  WriterKind,
  BatchChange,
  MirrorHost,
  MirrorRunner,
  BookService,
  ExportSink,
  ExportTarget,
  HttpApiCall,
  ImportScan,
  ImportSource,
  NoteService,
  NoteStatus,
  SavedSearchService,
  TagService,
  TemplateService,
  PluginRendererSpec,
  PreviewNote,
  PreviewOptions,
  RenderPluginBlock,
  SearchScope,
  StatusUndo,
  StorageAdapter,
  TagColor,
  TagColorValue,
  WelcomeContent,
} from '../../core'
import { newWriter } from '../../core/authorship'
import { applyBatch } from '../../core/batch'
import { createBookService } from '../../core/books'
import { captureNote } from '../../core/capture'
import { openTodaysNote } from '../../core/dailyNotes'
import { duplicateNote } from '../../core/duplicate'
import { createClock } from '../../core/hlc'
import { createIdGenerator } from '../../core/ids'
import { createNoteService } from '../../core/notes/service'
import { observeWrites } from '../../core/observeWrites'
import {
  createPieceRenderer,
  createPreviewRegistry,
  PIECE_LENGTH,
  renderPreview,
} from '../../core/preview'
import { createBlockSplitter, shareSplitter } from '../../core/preview/blocks'
import { createSavedSearchService } from '../../core/savedSearches'
import { createTagService } from '../../core/tags'
import { createTemplateService } from '../../core/templates'
import { seedWelcome } from '../../core/welcome'
import { errorCode } from '../../core/errors'
import { noteCounts } from '../../core/noteCounts'
import { noteFrontMatter, noteTally } from '../../core/noteFacts'
import { createLivePreviewRenderer } from '../../core/preview/live'
import { renderCardPreview, type CardLabels } from '../../core/preview/card'
import { libraryWarmFeatures } from '../../core/preview/warmFeatures'
import type { SyncEngine, SyncStatus } from '../../core/sync/engine'
import type { SyncEvent, TransportName } from '../../core/sync/transport'
import { fromWireRelay, relayOut, type RelayOut, type WireRelay } from './noteRelayWire'
import { importRuns } from './importRuns'
import { lazyEngine, lazyOnce } from './lazyStart'
import type { SaveProblemsMessage } from './saving'
import { starterTemplates } from './starterTemplates'
import type { WireSync, WireTransport } from './storage/syncWire'
import { fromBase64, fromWire, toBase64, type WireStorage } from './storage/wire'
import { forwardWorkerLogs, type WorkerLogMessage } from './workerLog'

// The worker's own warnings, errors and uncaught failures go to the page,
// which writes them to the local log (see workerLog.ts).
forwardWorkerLogs(self, (message) => self.postMessage(message))

/** The core's info lines (I_AUTHORSHIP_*), which the console does not forward: codes and IDs only. */
const logInfo = (code: string, ...ids: string[]) =>
  self.postMessage({
    workerLog: { level: 'info', code, ids },
  } satisfies WorkerLogMessage)

// What no launch needs before the first list loads on first use, so the worker's own script
// parses before `init` answers (issue 742).
const loadImport = () => Promise.all([import('../../core/import'), import('./importWorker')])
const loadExport = () => import('../../core/export')
const loadMirror = () => import('../../core/mirror')
const loadHttpApi = () => Promise.all([import('../../core/ai'), import('../../core/httpApi')])
const loadSync = () => Promise.all([import('../../core/sync/engine'), import('./storage/syncWire')])

let service: NoteService | undefined
let relayed: ReturnType<typeof relayOut> | undefined
let books: BookService | undefined
let tags: TagService | undefined
let savedSearches: SavedSearchService | undefined
let templates: TemplateService | undefined
let newId: (() => string) | undefined
let welcome: ((content: WelcomeContent) => Promise<string | null>) | undefined
const imports = importRuns()
const mirror = lazyOnce<Awaited<ReturnType<typeof loadMirror>>, MirrorRunner>(loadMirror)
let mirrorStorage: StorageAdapter | undefined
let httpApi: AiService | undefined
let httpWriter: Writer | null = null
let callWriter: Writer | null = null
const sync = lazyEngine<Awaited<ReturnType<typeof loadSync>>, SyncEngine>(loadSync)
let coreParts:
  | {
      storage: StorageAdapter
      clock: ReturnType<typeof createClock>
      newId: () => string
    }
  | undefined
// One piece renderer for the window's life, so piece keys never repeat; the plugins' renderers change under it.
let previewRegistry = createPreviewRegistry({ builtins: true })
let pluginRevision = 0
let pluginRender: RenderPluginBlock | undefined
const noteSplitter = shareSplitter(createBlockSplitter(PIECE_LENGTH))
const pieces = createPieceRenderer({
  split: noteSplitter(),
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

const livePreview = createLivePreviewRenderer({
  renderPieces: (markdown, options, known) =>
    pieces(markdown, { ...options, pluginRenderers: pluginRevision }, known),
  linkTargets: (ids) => required().linkTargets(ids),
  onTargetsFailed: () => console.warn('W_LINK_TARGETS_FAILED'),
  split: noteSplitter(),
})

const requiredTags = () => {
  if (!tags) throw new Error('E_CORE_NOT_READY')
  return tags
}
const requiredSavedSearches = () => {
  if (!savedSearches) throw new Error('E_CORE_NOT_READY')
  return savedSearches
}

const requiredBooks = () => {
  if (!books) throw new Error('E_CORE_NOT_READY')
  return books
}

const requiredTemplates = () => {
  if (!templates) throw new Error('E_CORE_NOT_READY')
  return templates
}

const coreApi = {
  /**
   * Starts the core on `remote`, the page's storage: Yjs states are coded here, off the UI thread (wire.ts), and a wrapper tells the Markdown mirror of every write. Unsaved notes are sent to the page as a SaveProblemsMessage each time that list changes, and what the core relays to the other windows and takes in from them as a RelayOut.
   * A lean core (a note window's, or a main window other than `main`) leaves compaction and the notebooks' order to the first main window's.
   * A note window's core (`relayAll`) relays every change; another relays a note's changes once another window has spoken of it (see relayGate).
   */
  async init(
    remote: WireStorage,
    node: string,
    options: { lean?: boolean; relayAll?: boolean } = {},
  ) {
    const clock = createClock(node)
    const ids = createIdGenerator()
    newId = ids
    const storage = observeWrites(fromWire(remote), (noteIds) => {
      mirror.current?.touch(noteIds)
      sync.current?.touch()
    })
    mirrorStorage = storage
    coreParts = { storage, clock, newId: ids }
    welcome = (content) => seedWelcome({ storage, clock, content })
    const relay = relayOut((out) => self.postMessage(out), toBase64, options.relayAll ?? false)
    relayed = relay
    service = createNoteService({
      storage,
      clock,
      newId: ids,
      // On this worker's own channel, ahead of the reply to the call that
      // failed (see SaveProblemsMessage).
      onSaveProblems: (saveProblems) =>
        self.postMessage({ saveProblems } satisfies SaveProblemsMessage),
      relay: relay.send,
      onTakenIn: (takenIn) => self.postMessage({ takenIn } satisfies RelayOut),
      compact: !options.lean,
      log: logInfo,
    })
    books = createBookService({ storage, clock, newId: ids })
    tags = createTagService({ storage, clock, newId: ids })
    savedSearches = createSavedSearchService({ storage, clock, newId: ids })
    templates = createTemplateService({
      storage,
      notes: service,
      books,
      tags,
      clock,
      newId: ids,
      starters: starterTemplates,
    })
    // Its own note service: its writes reach the notes held here as changes from outside
    // (the page merges them, see httpApiHost).
    // One writer for each start of the core, which answers the HTTP API for as long as the app runs.
    httpWriter = newWriter('http', '', node)
    httpApi = undefined
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
    const parts = coreParts
    if (!parts) throw new Error('E_CORE_NOT_READY')
    const [{ createAiService }, { runHttpApiCall, writerOfCall }] = await loadHttpApi()
    httpApi ??= createAiService({
      ...parts,
      writer: () => callWriter ?? httpWriter!,
      log: logInfo,
    })
    await notes.flush().catch(() => {})
    // The window runs calls one at a time (httpApiHost), so this names the one running.
    callWriter = httpWriter ? writerOfCall(call, httpWriter) : null
    try {
      return await runHttpApiCall(httpApi, call)
    } finally {
      callWriter = null
    }
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
  taskCounts: (ids: string[]) => required().taskCounts(ids),
  /** Gallery cards' thumbnails: the start of each body as a sanitized tree, by note ID. */
  cardPreviews: async (ids: string[], labels: CardLabels) => {
    const found: Record<string, RootContent[]> = {}
    for (const [id, markdown] of Object.entries(await required().cardExcerpts(ids))) {
      found[id] = (await renderCardPreview(markdown, labels)).children
    }
    return found
  },
  extract: (sourceId: string, markdown: string, title?: string) =>
    required().extract(sourceId, markdown, title),
  applyUpdate: (id: string, update: Uint8Array) => required().applyUpdate(id, update),
  insertAt: (id: string, anchor: Uint8Array | null, markdown: string) =>
    required().insertAt(id, anchor, markdown),
  setTitle: (id: string, title: string) => required().setTitle(id, title),
  setBook: (id: string, bookId: string | null) => required().setBook(id, bookId),
  setStatus: (id: string, status: NoteStatus) => required().setStatus(id, status),
  setStatusUndoable: (id: string, status: NoteStatus) => required().setStatusUndoable(id, status),
  undoStatus: (id: string, undo: StatusUndo) => required().undoStatus(id, undo),
  setPinned: (id: string, pinned: boolean) => required().setPinned(id, pinned),
  setNoteDates: (id: string, dates: { createdAt?: number; updatedAt?: number }) =>
    required().setDates(id, dates),
  batch: (ids: string[], change: BatchChange) =>
    applyBatch({ notes: required(), tags: requiredTags() }, ids, change),
  listTags: () => requiredTags().list(),
  addTag: (noteId: string, name: string) => requiredTags().addToNote(noteId, name),
  removeTag: (noteId: string, tagId: string) => requiredTags().removeFromNote(noteId, tagId),
  renameTag: (id: string, name: string) => requiredTags().rename(id, name),
  setTagColor: (id: string, color: TagColorValue | null) => requiredTags().setColor(id, color),
  deleteTag: (id: string) => requiredTags().remove(id),
  listSavedSearches: () => requiredSavedSearches().list(),
  createSavedSearch: (name: string, query: string) => requiredSavedSearches().create(name, query),
  renameSavedSearch: (id: string, name: string) => requiredSavedSearches().rename(id, name),
  setSavedSearchQuery: (id: string, query: string) => requiredSavedSearches().setQuery(id, query),
  placeSavedSearch: (id: string, targetId: string, where: 'before' | 'after') =>
    requiredSavedSearches().place(id, targetId, where),
  deleteSavedSearch: (id: string) => requiredSavedSearches().remove(id),
  /**
   * With `versions` (quitting), typing not kept as a version yet becomes one.
   * Rejects with E_NOTE_SAVE_FAILED when a note could not be saved.
   */
  flush: (options?: { versions?: boolean }) => required().flush(options),
  holdCompaction: () => required().holdCompaction(),
  resumeCompaction: () => required().resumeCompaction(),
  search: (
    query: string,
    scope?: SearchScope,
    options?: { flush?: boolean; shortInTitles?: boolean },
  ) => required().search(query, scope, options),
  trash: (id: string) => required().trash(id),
  restore: (id: string) => required().restore(id),
  listTrash: () => required().listTrash(),
  peekTrashed: (id: string) => required().peekTrashed(id),
  backlinks: (id: string) => required().backlinks(id),
  linkTargets: (ids: string[]) => required().linkTargets(ids),
  noteSummaries: (ids: string[]) => required().summaries(ids),
  purge: (id: string) => required().purge(id),
  discardEmpty: (id: string) => required().discardEmpty(id),
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
  appendToNote: (id: string, text: string, options: AppendOptions) =>
    required().appendToNote(id, text, options),
  undoAgentWrites: (id: string, writer: { kind: WriterKind; names: readonly string[] }) =>
    required().undoAgentWrites(id, writer),
  clearAuthorship: (id: string) => required().clearAuthorship(id),
  agentWrites: (limit: number) => required().agentWrites(limit),
  authoredNotes: () => required().authoredNotes(),
  markWritesSeen: (id: string, writeIds: string[]) => required().markWritesSeen(id, writeIds),
  activity: (now: number) => required().activity(now),
  writing: (now: number) => required().writing(now),
  noteActivity: (ids: string[], now: number) => required().noteActivity(ids, now),
  mergeStored: () => required().mergeStored(),
  /** What another window's core relayed (see NoteService.receive). */
  relayIn: (message: WireRelay) => {
    relayed?.heard(message.noteId)
    return required().receive(fromWireRelay(message, fromBase64))
  },
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
  openTodaysNote: (settings: DailyNotesSettings, now: number, create: boolean) =>
    openTodaysNote({
      notes: required(),
      templates: requiredTemplates(),
      books: requiredBooks(),
      settings,
      at: now,
      create,
    }),
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
    wikiLinks = true,
  ) => {
    const ids = newId
    if (!ids) throw new Error('E_CORE_NOT_READY')
    const parts = {
      notes: required(),
      books: requiredBooks(),
      tags: requiredTags(),
    }
    const files = mirrorStorage
    return imports.run((stopped) =>
      loadImport().then(([{ importMarkdown, preparerHere }, { preparerOffThread }]) => {
        const prepare = preparerOffThread(
          () =>
            new Worker(new URL('./import.worker.ts', import.meta.url), {
              type: 'module',
            }),
          preparerHere(ids),
          () => console.warn('W_IMPORT_WORKER_FAILED'),
        )
        return importMarkdown({
          ...parts,
          newId: ids,
          scan,
          source,
          files,
          destination,
          onProgress,
          stopped,
          prepare,
          wikiLinks,
        }).finally(prepare.close)
      }),
    )
  },
  holdImport: () => imports.hold(),
  resumeImport: () => imports.resume(),
  stopImport: () => imports.stop(),
  planExport: async (target: ExportTarget, untitled: string) => {
    const parts = {
      notes: required(),
      books: requiredBooks(),
      tags: requiredTags(),
    }
    const { planExport } = await loadExport()
    return planExport({ ...parts, target, untitled })
  },
  exportMarkdown: async (target: ExportTarget, sink: ExportSink, untitled: string) => {
    const parts = {
      notes: required(),
      books: requiredBooks(),
      tags: requiredTags(),
    }
    const { exportMarkdown } = await loadExport()
    return exportMarkdown({ ...parts, target, untitled, sink })
  },
  renderPreview: (markdown: string, options: PreviewOptions) => renderPreview(markdown, options),
  noteCounts: (markdown: string) => noteCounts(markdown),
  /** The open note's words, characters and tasks, which the page asks for once per text (noteTally.ts). */
  noteTally: (markdown: string) => noteTally(markdown),
  /** The open note's front matter as rows, from its `frontMatterHead`. */
  noteFrontMatter: (head: string, note: PreviewNote | undefined, untitled: string) =>
    noteFrontMatter(head, note, untitled),
  /** The open note's preview in pieces; `known` are the keys of the pieces the page shows. */
  renderPreviewPieces: (markdown: string, options: PreviewOptions, known: string[]) =>
    pieces(markdown, { ...options, pluginRenderers: pluginRevision }, known),
  /** The preview closed, so the pieces it showed are kept no longer than a note left. */
  forgetShownPieces: () => pieces.forgetShown(),
  /** A preview render the page does not show, which leaves the open note's pieces cached. */
  warmPreviewPieces: (markdown: string, options: PreviewOptions) =>
    pieces.sample(markdown, { ...options, pluginRenderers: pluginRevision }),
  /** The code languages, math and emoji the open note and the first `listed` notes use. */
  warmFeatures: (openText: string, listed: string[]) => {
    const parts = coreParts
    if (!parts) throw new Error('E_CORE_NOT_READY')
    return libraryWarmFeatures(parts.storage, openText, listed)
  },
  /**
   * The open note's live preview: its pieces with the note's linked notes in, and its task
   * progress and line count. Link targets are asked again when `scope` or the links change.
   */
  renderLivePreview: (
    markdown: string,
    options: Omit<PreviewOptions, 'noteLinks'>,
    known: string[],
    scope: string,
  ) => livePreview(markdown, options, known, scope),
  /** Plugins' preview renderers (ADR 0005); `render` asks the page, which asks the plugin. Pieces rendered before render again. */
  setPluginRenderers: (specs: PluginRendererSpec[], render: RenderPluginBlock) => {
    // The page sends `render` as a proxy; the one before is let go so its port closes.
    ;(pluginRender as Comlink.Remote<RenderPluginBlock> | undefined)?.[Comlink.releaseProxy]()
    pluginRender = render
    previewRegistry = createPreviewRegistry({
      builtins: true,
      plugins: { specs, render },
    })
    pluginRevision += 1
  },
  /**
   * Prepares the mirror (once); nothing runs until `mirrorReconcile`. Notes a file changed outside Devot is brought back
   * into are written by services of their own and named to `changed`, so the window takes them in as changes from
   * outside, as an HTTP API write.
   */
  startMirror: async (
    host: MirrorHost,
    untitled: string,
    logFailure: (code: string) => void,
    changed?: (noteIds: readonly string[]) => void,
  ) => {
    const storage = mirrorStorage
    const parts = coreParts
    const notes = service
    if (!storage || !parts || !notes) return
    // Failures reach the app's log through the window (codes only).
    await mirror.start(({ createMirrorRunner, createMirrorTakeBack }) =>
      createMirrorRunner({
        storage,
        host,
        untitled,
        onError: logFailure,
        takeBack: createMirrorTakeBack({
          notes: createNoteService({
            storage,
            clock: parts.clock,
            newId: parts.newId,
          }),
          tags: createTagService({
            storage,
            clock: parts.clock,
            newId: parts.newId,
          }),
          storage,
          before: () => notes.flush(),
          ...(changed ? { after: changed } : {}),
        }),
      }),
    )
  },
  /** A full pass soon, unless one for Rust's `generation` ran already. */
  mirrorReconcile: (generation?: number) => mirror.current?.reconcile(generation),
  /** A pass soon: for the named notes only when nothing else changed, or for every note. */
  mirrorTouch: (noteIds?: readonly string[]) => mirror.current?.touch(noteIds),
  mirrorWake: () => mirror.current?.wake(),
  /** With Bring Back Outside Edits on, a look for files changed outside Devot soon. */
  mirrorRescan: () => mirror.current?.rescan(),
  mirrorStop: () => mirror.current?.stop(),
  /** Runs the sync engine on Rust's store and socket, which the page passes in. */
  async startSync(
    store: WireSync,
    transport: WireTransport,
    onStatus: (status: SyncStatus) => void,
    onApplied: () => void,
    build?: string,
    via: TransportName = 'relay',
  ) {
    const parts = coreParts
    if (!parts) return
    await sync.start(([{ createSyncEngine }, { fromWireSync, fromWireTransport }]) =>
      createSyncEngine({
        ...parts,
        ...(build ? { build } : {}),
        via,
        sync: fromWireSync(store),
        transport: fromWireTransport(transport, via),
        onStatus: (status) => void Promise.resolve(onStatus(status)).catch(() => undefined),
        // The page merges the changes into the notes in memory and reloads, as for another process's writes.
        onApplied: () => void Promise.resolve(onApplied()).catch(() => undefined),
      }),
    )
  },
  stopSync: () => sync.stop(),
  syncReceived: (event: SyncEvent) => sync.current?.received(event),
  syncTouch: () => sync.current?.touch(),
  syncFocused: () => sync.current?.focused(),
  syncFlush: () => sync.current?.flush(),
  syncAfterRestore: (choice: 'merge' | 'keep') => sync.current?.afterRestore(choice),
}

export type CoreApi = typeof coreApi

Comlink.expose(coreApi)
