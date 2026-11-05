// The sync engine (docs/adr/0002-sync-latest-state-per-record.md, Client): pulls what other devices
// wrote and merges it into storage, and pushes what changed here. The relay keeps one sealed copy of
// each record and takes a push only when it is based on the version it holds (compare-and-swap); a
// rejected push pulls, merges and pushes again. Storage marks every written record (schema v19), so
// the engine looks only at those, and pushes one only when its state differs from the one the relay
// holds (`fingerprint`).
//
// It runs one task at a time. Pushes wait for 3 s without writes, and go at least every 10 s while
// writes go on; a large backlog goes out in batches (`pushMany`). It refuses to sync while this
// device's clock is more than 5 minutes off the relay's, and a new vault epoch (a relay that lost its
// data, or a new one) means every record is uploaded again. Revoked, unknown or refused devices stop
// until the user acts; the relay's quota cap pauses pushes until its next 00:00 UTC, another
// transport's pause lasts as long as it says (a full iCloud until it is looked at again); anything
// else retries with backoff and jitter. The cursor and each record's change tag are the
// transport's, never read here (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md).

import * as Y from 'yjs'
import { textEdits } from '../diff'
import { errorCode } from '../errors'
import { fileLinks } from '../files'
import { receiveStored, type Clock } from '../hlc'
import { clipTitle } from '../noteLimits'
import { isNotebookIcon } from '../notebookIcons'
import { BODY } from '../notes'
import { MERGE, REVISION_EVERY_MS, textLength } from '../revisions'
import { countWords } from '../words'
import { quotaResetAt } from './protocol'
import type {
  BookRecord,
  NoteRecord,
  SavedSearchRecord,
  StorageAdapter,
  TagRecord,
} from '../storage'
import { retargetSavedSearches } from '../savedSearches'
import { isTagColor, isTagColorValue, sameName } from '../tags'
import {
  bodyPrint,
  decodeRecord,
  encodeRecord,
  fingerprint,
  mergeRecord,
  stampsOf,
  bodyFacts,
  textOf,
  tombstone,
  tombstoneFile,
  type BookState,
  type FileState,
  type MergedNote,
  type NoteState,
  type SyncRecord,
  type SearchState,
  type TagState,
} from './records'
import {
  MAX_SYNC_IDS,
  type SyncEntry,
  type SyncFileMeta,
  type SyncLocal,
  type SyncStore,
} from './store'
import { MOVED_ID, readMoved } from './moved'
import { RESTORE_CHOICE, RESTORED_AT } from './restore'
import {
  ICLOUD_FULL,
  pauseGoesOn,
  QUOTA,
  recordFailure,
  START,
  STORAGE_FULL,
  storedCursor,
  VAULT_MOVED,
  type PulledRecord,
  type PushItem,
  type PushResult,
  type SyncEvent,
  type SyncTransport,
  type TransportName,
} from './transport'

export const PUSH_IDLE_MS = 3_000
export const PUSH_EVERY_MS = 10_000
export const MAX_PUSH_RETRIES = 5
export const MAX_CLOCK_SKEW_MS = 5 * 60_000
const RETRY_BASE_MS = 250
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 5 * 60_000
const SKEW_RECHECK_MS = 5 * 60_000
/** Spreads a vault's devices over the minute after the relay's reset. */
const QUOTA_JITTER_MS = 60_000
/** A timer can fall behind the clock while the machine sleeps, so a quota pause checks the time this often. */
const QUOTA_RECHECK_MS = 60 * 60_000
/** A pause with no end (a full iCloud) is looked at again this often, besides on launch and on focus. */
const PAUSE_RECHECK_MS = 60 * 60_000
/** Spreads the end of another transport's timed pause, which is short (its own retry-after). */
const PAUSE_JITTER_MS = 1_000
/** The most records, and about the most plaintext bytes, one `pushMany` carries. */
const BATCH_RECORDS = 100
const BATCH_BYTES = 8 * 1024 * 1024
/** A backlog this large (a first upload, a new epoch) shows its progress. */
const UPLOAD_SHOWN_FROM = 100
const PROGRESS_EVERY_MS = 1_000
/** One record pushed this often within a minute is a loop between devices, not typing (6 a minute at most). */
const BREAKER_PUSHES = 30
const BREAKER_WINDOW_MS = 60_000
const PAGE = 100
/** A note that shows more attachments than this has the rest sent in their turn. */
const MAX_SHOWN_FILES = 500
const WRITE_TRIES = 5
/** The size of the upload under way, in `sync_state`, so its progress survives a restart; '0' when none. */
const UPLOAD_TOTAL = 'uploadTotal'
/** The build that skipped a record it could not read, in `sync_state`; a different build pulls everything again. */
const SKIPPED_BY = 'skippedBy'
/** After Keep: the HLC of the choice, until the first full pull after it; '' otherwise. */
const KEEP_BEFORE = 'keepRestoredBefore'
/** The pull cursor, in `sync_state`. */
const SINCE = 'since'
/** '1' once a pull got past the start: a restore then asks first (ADR 0013). Kept through a new epoch. */
export const HAS_SYNCED = 'hasSynced'

export type SyncState = 'off' | 'connecting' | 'syncing' | 'idle' | 'offline' | 'paused' | 'stopped'

export interface SyncStatus {
  state: SyncState
  lastSync: number | null
  /** Why sync is offline, paused or stopped. */
  code: string | null
  /** Records past the relay's size limit, kept on this device only. */
  tooLarge: string[]
  /** Paused: when pushes are taken again (the relay's 00:00 UTC); null for a pause with no end. */
  pausedUntil: number | null
  /** A large upload under way, kept across pauses and restarts. */
  upload: { sent: number; total: number } | null
  /** The relay predates the quota cap or the attachment share: its owner should update it. */
  relayOutdated: boolean
  /** Images kept on this device only, and why: E_SYNC_ATTACHMENTS_FULL, or E_SYNC_RELAY_OUTDATED (a relay that cannot hold them). */
  unsyncedFiles: { count: number; code: string } | null
  /** Records this run could not read or apply: a newer Devot may. */
  skipped: number
}

/** Why attachments stay local; the relay's refusal is retried after a purge frees space and on the next launch. */
const FILES_FULL = 'E_SYNC_ATTACHMENTS_FULL'
const FILES_UNSUPPORTED = 'E_SYNC_RELAY_OUTDATED'

class Paused extends Error {
  readonly until: number | null
  readonly storageFull: boolean
  constructor(code: string, until: number | null, storageFull = false) {
    super(code)
    this.until = until
    this.storageFull = storageFull
  }
}

const pausedBy = (result: Extract<PushResult, { type: 'paused' }>) =>
  new Paused(result.code ?? QUOTA, result.until, result.limit === 'storedBytes')

/** Codes that stop sync until the user acts (Settings > Sync). */
const STOPPING = new Set([
  'E_SYNC_REVOKED',
  'E_SYNC_UNAUTHORIZED',
  'E_SYNC_NO_VAULT',
  'E_SYNC_NOT_ENROLLED',
  'E_SYNC_NO_VAULT_KEY',
  'E_SYNC_PROTOCOL',
  'E_SYNC_CLOCK_SKEW',
  'E_SYNC_CIRCUIT_OPEN',
  VAULT_MOVED,
  // The build gates sync and no valid licence is on this device (src-tauri/src/licence).
  'E_LICENCE_REQUIRED',
  'E_LICENCE_UNREADABLE',
])

export interface SyncEngineOptions {
  storage: StorageAdapter
  sync: SyncStore
  transport: SyncTransport
  clock: Clock
  newId: () => string
  now?: () => number
  random?: () => number
  idleMs?: number
  everyMs?: number
  retryBaseMs?: number
  quotaJitterMs?: number
  uploadShownFrom?: number
  /** Names this build (its version). A record it could not read is pulled again once the build changes. */
  build?: string
  /** The transport the vault is on: a moved marker naming another one stops sync. */
  via?: TransportName
  /** How often a pause with no end is looked at again. */
  recheckMs?: number
  onStatus?: (status: SyncStatus) => void
  /** Records another device changed here, after each page they came in. */
  onApplied?: (ids: string[]) => void
}

export interface SyncEngine {
  start(): void
  stop(): Promise<void>
  /** Something was written here: push it soon. */
  touch(): void
  received(event: SyncEvent): void
  status(): SyncStatus
  /** Pulls and pushes now (connecting first when needed); resolves when done. */
  syncNow(): Promise<void>
  /** Resolves once no task is running or queued. */
  idle(): Promise<void>
  /**
   * After a backup was restored (`RESTORE_CHOICE`): `merge` syncs as usual, so the other devices'
   * later changes come back; `keep` gives every record here fresh clocks and puts this device's
   * text back over bodies changed elsewhere before the choice, so the restored notes win. A note
   * another device purged stays purged either way.
   */
  afterRestore(choice: 'merge' | 'keep'): Promise<void>
  /** A window came to the front: a pause with no end (a full iCloud) is looked at again. */
  focused(): void
  /** Internal, for tests: how many records the push breaker still holds times for. */
  pushesRemembered(): number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const storageFailure = (code: string) => code.startsWith('E_STORAGE_')

function noteStateOf(row: NonNullable<SyncLocal['note']>, bodyHlc: string): NoteState {
  const { note, purged, tags } = row
  if (purged) return tombstone(note.id, note.deletedAt ?? 0, note.deletedHlc ?? '')
  return {
    kind: 'note',
    id: note.id,
    purged: false,
    title: note.title,
    titleHlc: note.titleHlc,
    bookId: note.bookId,
    bookHlc: note.bookHlc,
    status: note.status,
    statusHlc: note.statusHlc,
    pinned: note.pinned,
    pinnedHlc: note.pinnedHlc,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    datesHlc: note.datesHlc ?? '',
    deletedAt: note.deletedAt,
    deletedHlc: note.deletedHlc ?? '',
    bodyHlc,
    tags: tags.map((t) => ({ tagId: t.tagId, present: t.present, hlc: t.hlc })),
    ydoc: note.ydoc,
  }
}

const bookStateOf = (book: BookRecord): BookState => ({
  kind: 'book',
  id: book.id,
  name: book.name,
  nameHlc: book.nameHlc,
  parentId: book.parentId,
  parentHlc: book.parentHlc,
  createdAt: book.createdAt,
  updatedAt: book.updatedAt,
  deletedAt: book.deletedAt,
  deletedHlc: book.deletedHlc ?? '',
  sortKey: book.sortKey,
  sortKeyHlc: book.sortKeyHlc,
  icon: book.icon,
  iconColor: book.iconColor,
  iconHlc: book.iconHlc,
})

const tagStateOf = (tag: TagRecord): TagState => ({
  kind: 'tag',
  id: tag.id,
  name: tag.name,
  nameHlc: tag.nameHlc,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
  deletedAt: tag.deletedAt,
  deletedHlc: tag.deletedHlc ?? '',
  color: tag.color,
  colorHlc: tag.colorHlc,
})

const searchStateOf = (search: SavedSearchRecord): SearchState => ({
  kind: 'search',
  id: search.id,
  name: search.name,
  nameHlc: search.nameHlc,
  query: search.query,
  queryHlc: search.queryHlc,
  sortKey: search.sortKey,
  sortKeyHlc: search.sortKeyHlc,
  createdAt: search.createdAt,
  updatedAt: search.updatedAt,
  deletedAt: search.deletedAt,
  deletedHlc: search.deletedHlc ?? '',
})

const fileStateOf = (file: SyncFileMeta): FileState => ({
  kind: 'file',
  id: file.id,
  purged: false,
  noteId: file.noteId,
  noteHlc: file.noteHlc,
  name: file.name,
  mime: file.mime,
  size: file.size,
  createdAt: file.createdAt,
  data: new Uint8Array(0),
})

function stateOf(local: SyncLocal | undefined, bodyHlc: string): SyncRecord | null {
  if (local?.note) return noteStateOf(local.note, bodyHlc)
  if (local?.book) return bookStateOf(local.book)
  if (local?.tag) return tagStateOf(local.tag)
  if (local?.file) return fileStateOf(local.file)
  if (local?.search) return searchStateOf(local.search)
  // An attachment with an entry and no row was purged: the entry is its tombstone.
  if (local?.entry?.kind === 'file') return tombstoneFile(local.id)
  return null
}

const noteRecordOf = (state: NoteState, bodyVersion: number): NoteRecord => ({
  id: state.id,
  title: clipTitle(state.title),
  titleHlc: state.titleHlc,
  ...bodyFacts(state.id, state.ydoc),
  ydoc: state.ydoc,
  bodyVersion,
  bookId: state.bookId,
  bookHlc: state.bookHlc,
  status: state.status,
  statusHlc: state.statusHlc,
  pinned: state.pinned,
  pinnedHlc: state.pinnedHlc,
  createdAt: state.createdAt,
  updatedAt: state.updatedAt,
  datesHlc: state.datesHlc,
  deletedAt: state.deletedAt,
  deletedHlc: state.deletedHlc || null,
})

// A name or colour a later build wrote reads as unset here, keeping its HLC, as storage reads one.
const bookRecordOf = (state: BookState): BookRecord => ({
  id: state.id,
  name: state.name,
  nameHlc: state.nameHlc,
  parentId: state.parentId,
  parentHlc: state.parentHlc,
  createdAt: state.createdAt,
  updatedAt: state.updatedAt,
  deletedAt: state.deletedAt,
  deletedHlc: state.deletedHlc || null,
  aiAccess: false,
  aiAccessHlc: '',
  sortKey: state.sortKey,
  sortKeyHlc: state.sortKeyHlc,
  icon: isNotebookIcon(state.icon) ? state.icon : null,
  iconColor: isTagColor(state.iconColor) ? state.iconColor : null,
  iconHlc: state.iconHlc,
})

const tagRecordOf = (state: TagState): TagRecord => ({
  id: state.id,
  name: state.name,
  nameHlc: state.nameHlc,
  createdAt: state.createdAt,
  updatedAt: state.updatedAt,
  deletedAt: state.deletedAt,
  deletedHlc: state.deletedHlc || null,
  color: isTagColorValue(state.color) ? state.color : null,
  colorHlc: state.colorHlc,
})

const searchRecordOf = (state: SearchState): SavedSearchRecord => ({
  id: state.id,
  name: state.name,
  nameHlc: state.nameHlc,
  query: state.query,
  queryHlc: state.queryHlc,
  sortKey: state.sortKey,
  sortKeyHlc: state.sortKeyHlc,
  createdAt: state.createdAt,
  updatedAt: state.updatedAt,
  deletedAt: state.deletedAt,
  deletedHlc: state.deletedHlc || null,
})

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { storage, sync, transport, clock, newId } = options
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const idleMs = options.idleMs ?? PUSH_IDLE_MS
  const everyMs = options.everyMs ?? PUSH_EVERY_MS
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS
  const quotaJitterMs = options.quotaJitterMs ?? QUOTA_JITTER_MS
  const uploadShownFrom = options.uploadShownFrom ?? UPLOAD_SHOWN_FROM
  const via = options.via ?? 'relay'
  const recheckMs = options.recheckMs ?? PAUSE_RECHECK_MS

  let running = false
  let connected = false
  let status: SyncStatus = {
    state: 'off',
    lastSync: null,
    code: null,
    tooLarge: [],
    pausedUntil: null,
    upload: null,
    relayOutdated: false,
    unsyncedFiles: null,
    skipped: 0,
  }
  /** The relay's clock less this device's, from the last welcome. */
  let relayOffset = 0
  let queue: Promise<void> = Promise.resolve()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = RECONNECT_MIN_MS
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  let firstTouch: number | undefined
  /** Record ID to the fingerprint the relay refused as too large; a changed record is tried again. */
  const tooLarge = new Map<string, string>()
  /** Past the retry cap: left until the next `changed`. */
  const parked = new Set<string>()
  /** Records this run skipped, by ID: a later pull that reads one takes it off the count. */
  const skippedIds = new Set<string>()
  /** A `changed` event waits for a pass that has not started; it covers any that come before it does. */
  let passQueued = false
  /** A record this build could not read came in during the current pull. */
  let unreadable = false
  const pushTimes = new Map<string, number[]>()
  /** `KEEP_BEFORE` during a pull. */
  let keepBefore = ''
  /** Attachment ID to why it stays local: the relay refused it (or cannot hold it), or it would be refused as a larger one was. */
  const unsynced = new Map<string, { print: string; code: string }>()
  /** Whether the relay said (in its welcome) that it holds attachments within a share. */
  let filesSupported = true
  /** The smallest attachment the relay refused for lack of room; larger ones are not sent until room is made. */
  let fullAt: number | undefined
  /** Room was made (a purge was pushed or pulled): refused attachments are tried again. */
  let roomMade = false
  /** The refusal of an image a note shows, held to the end of the pass so the note still goes. */
  let shownRefused: Paused | undefined
  /** What a rejected push said the transport holds; the push after the merge of that version goes against its tag. */
  const serverTags = new Map<string, { version: number; tag: string }>()

  const reportUnsynced = () => {
    const codes = new Set([...unsynced.values()].map((u) => u.code))
    const code = codes.has(FILES_UNSUPPORTED) ? FILES_UNSUPPORTED : FILES_FULL
    set({ unsyncedFiles: unsynced.size > 0 ? { count: unsynced.size, code } : null })
  }

  const makeRoom = () => {
    if (unsynced.size === 0 && fullAt === undefined) return
    roomMade = true
    fullAt = undefined
    for (const [id, u] of [...unsynced]) if (u.code === FILES_FULL) unsynced.delete(id)
    reportUnsynced()
  }

  const set = (patch: Partial<SyncStatus>) => {
    status = { ...status, ...patch }
    if (status.state !== 'paused') status.pausedUntil = null
    options.onStatus?.(status)
  }

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = queue.then(() => (running ? task() : undefined))
    queue = run.catch(failed)
    return run
  }

  const reconnect = (delay?: number) => {
    if (!running || reconnectTimer) return
    const wait = delay ?? reconnectDelay * (0.5 + random())
    reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void enqueue(() => connect(true)).catch(() => undefined)
    }, wait)
  }

  /** Reconnects once the relay's clock reaches `until`, after a jitter. */
  const resumeAt = (until: number, jitterMs = quotaJitterMs) => {
    if (!running || reconnectTimer) return
    const wait = until - (now() + relayOffset)
    if (wait <= 0) return reconnect(jitterMs * (0.5 + random()))
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined
        resumeAt(until, jitterMs)
      },
      Math.min(wait, QUOTA_RECHECK_MS),
    )
  }

  async function failed(error: unknown) {
    if (!running) return
    const code = errorCode(error, 'E_SYNC_FAILED')
    console.warn('W_SYNC_FAILED', code)
    connected = false
    await transport.close().catch(() => undefined)
    // A request cut off by the close that stopped sync must not turn the stop into a retry.
    const stoppedFor = status.state === 'stopped' ? status.code : null
    if (stoppedFor && stoppedFor !== 'E_SYNC_CLOCK_SKEW' && !STOPPING.has(code)) return
    const paused =
      error instanceof Paused ? error : code === ICLOUD_FULL ? new Paused(code, null) : undefined
    if (STOPPING.has(code)) {
      set({ state: 'stopped', code })
      if (code === 'E_SYNC_CLOCK_SKEW') reconnect(SKEW_RECHECK_MS)
    } else if (paused && code !== QUOTA) {
      // Another transport's pause: no daily reset, and none at all for a full iCloud.
      set({ state: 'paused', code, pausedUntil: paused.until })
      if (paused.until === null) reconnect(recheckMs)
      else resumeAt(paused.until, PAUSE_JITTER_MS)
    } else if (code === QUOTA) {
      const relayNow = now() + relayOffset
      const said = paused ? paused.until : null
      const next = quotaResetAt(relayNow)
      // A reset already past (the refusal came in after it) resumes after the jitter; one past the next two is not believed.
      const until = said === null ? next : Math.min(said, quotaResetAt(next))
      const full = paused?.storageFull ?? false
      set({ state: 'paused', code: full ? STORAGE_FULL : code, pausedUntil: until })
      resumeAt(until)
    } else {
      set({ state: 'offline', code })
      reconnect()
    }
  }

  /** A device that was stopped (revoked, refused) stays so until sync is turned off and on, or a recheck (`again`). */
  async function connect(again = false) {
    if (connected) return syncAll()
    if (status.state === 'stopped' && !again) return
    if (await waitsForRestoreChoice()) return
    set({ state: 'connecting' })
    const welcome = await transport.connect()
    relayOffset = welcome.time - now()
    if (Math.abs(relayOffset) > MAX_CLOCK_SKEW_MS) throw new Error('E_SYNC_CLOCK_SKEW')
    const known = (value: unknown) => value === 'on' || value === 'off'
    const relayOutdated = !known(welcome.quota) || !known(welcome.attachments)
    if (relayOutdated !== status.relayOutdated) set({ relayOutdated })
    // A relay that does not say it holds attachments within a share is not sent any: they could
    // take the room notes need. They go once the owner has updated it.
    filesSupported = known(welcome.attachments)
    if (filesSupported) {
      for (const [id, u] of [...unsynced]) if (u.code === FILES_UNSUPPORTED) unsynced.delete(id)
      reportUnsynced()
    }
    const state = await sync.syncState()
    if (state['epoch'] !== welcome.epoch) {
      await sync.syncReset()
      await sync.syncSetState(SINCE, START)
      await sync.syncSetState(UPLOAD_TOTAL, '0')
      await sync.syncSetState('epoch', welcome.epoch)
      tooLarge.clear()
      parked.clear()
      serverTags.clear()
      unsynced.clear()
      fullAt = undefined
      set({ tooLarge: [] })
      reportUnsynced()
    }
    connected = true
    reconnectDelay = RECONNECT_MIN_MS
    await syncAll()
  }

  /** A library that never synced has nothing later to bring back, so nobody is asked. */
  async function waitsForRestoreChoice() {
    const state = await sync.syncState()
    if (!state[RESTORED_AT]) return false
    if (state[HAS_SYNCED] !== '1') {
      await sync.syncSetState(RESTORED_AT, '')
      return false
    }
    set({ state: 'stopped', code: RESTORE_CHOICE })
    return true
  }

  /** Every field of every live record gets a new HLC, so it wins each merge; bodies are put back as they are pulled (`keptBody`). */
  async function keepRestored() {
    const tick = () => clock.tick()
    const notes = [...(await storage.listNotes()), ...(await storage.listTrash())].map((n) => n.id)
    for (let at = 0; at < notes.length; at += MAX_SYNC_IDS) {
      for (const row of await sync.syncRead(notes.slice(at, at + MAX_SYNC_IDS))) {
        if (!row.note || row.note.purged) continue
        const note = row.note.note
        await storage.putNote({
          ...note,
          titleHlc: tick(),
          bookHlc: tick(),
          statusHlc: tick(),
          pinnedHlc: tick(),
          datesHlc: tick(),
          deletedHlc: tick(),
        })
        for (const tag of row.note.tags) await storage.putNoteTag({ ...tag, hlc: tick() })
      }
    }
    // A key never given stays unset (books.ts `unkeyed`).
    const keyed = (sortKey: string) => (sortKey === '' ? {} : { sortKeyHlc: tick() })
    for (const book of await storage.listBooks()) {
      await storage.putBook({
        ...book,
        nameHlc: tick(),
        parentHlc: tick(),
        iconHlc: tick(),
        ...keyed(book.sortKey),
        deletedHlc: tick(),
      })
    }
    for (const tag of await storage.listTags()) {
      await storage.putTag({ ...tag, nameHlc: tick(), colorHlc: tick(), deletedHlc: tick() })
    }
    for (const search of await storage.listSavedSearches()) {
      await storage.putSavedSearch({
        ...search,
        nameHlc: tick(),
        queryHlc: tick(),
        ...keyed(search.sortKey),
        deletedHlc: tick(),
      })
    }
    await sync.syncSetState(KEEP_BEFORE, tick())
    if (notes.length > 0) options.onApplied?.(notes)
  }

  /** After Keep: a body another device changed before the choice is edited back to this device's text, on top of both, so every device ends with it. */
  function keptBody(mine: SyncRecord | null, remote: SyncRecord, merged: MergedNote): MergedNote {
    const record = merged.record
    if (keepBefore === '' || mine?.kind !== 'note' || mine.purged) return merged
    if (remote.kind !== 'note' || remote.bodyHlc > keepBefore) return merged
    if (record.kind !== 'note' || record.purged) return merged
    const doc = new Y.Doc()
    Y.applyUpdate(doc, record.ydoc)
    const text = doc.getText(BODY)
    const edits = textEdits(text.toString(), textOf(mine.ydoc))
    if (edits.length === 0) return merged
    doc.transact(() => {
      for (const edit of edits.reverse()) {
        if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start)
        if (edit.text) text.insert(edit.start, edit.text)
      }
    })
    return {
      record: { ...record, ydoc: Y.encodeStateAsUpdate(doc), bodyHlc: clock.tick() },
      localNews: true,
      remoteNews: true,
      bodyChanged: false,
      bothEdited: false,
    }
  }

  async function syncAll() {
    set({ state: 'syncing' })
    await pullAll()
    await pushAll()
    await finishPass()
  }

  async function finishPass() {
    const at = now()
    await sync.syncSetState('lastSync', String(at))
    set({ state: 'idle', code: null, lastSync: at })
  }

  async function pullAll() {
    const state = await sync.syncState()
    keepBefore = state[KEEP_BEFORE] ?? ''
    let since = storedCursor(state[SINCE])
    let skippedBy = state[SKIPPED_BY] ?? ''
    const build = options.build
    // A newer build may read what the one that skipped it could not.
    if (build && skippedBy !== '' && skippedBy !== build) {
      since = START
      skippedBy = ''
      await sync.syncSetState(SINCE, START)
      await sync.syncSetState(SKIPPED_BY, '')
    }
    for (;;) {
      unreadable = false
      const page = await transport.pull(since)
      const applied: string[] = []
      try {
        for (const record of page.records) {
          if (await applyPulled(record)) applied.push(record.id)
        }
      } finally {
        if (applied.length > 0) options.onApplied?.(applied)
      }
      if (unreadable && build && skippedBy !== build) {
        skippedBy = build
        await sync.syncSetState(SKIPPED_BY, build)
      }
      const advanced = page.next !== since
      since = page.next
      await sync.syncSetState(SINCE, since)
      if (!page.more || !advanced) break
    }
    if (since !== START && state[HAS_SYNCED] !== '1') await sync.syncSetState(HAS_SYNCED, '1')
    if (keepBefore !== '') {
      keepBefore = ''
      await sync.syncSetState(KEEP_BEFORE, '')
    }
  }

  /** The body's HLC to send: a body changed here since it was last taken gets a new one, unless the note is in the Trash (it changed before it went there). */
  const stamp = (local: SyncLocal): { bodyHlc: string; bodyFp: string } => {
    const entry = local.entry
    const row = local.note
    const kept = { bodyHlc: entry?.bodyHlc ?? '', bodyFp: entry?.bodyFp ?? '' }
    if (!row || row.purged) return kept
    const print = bodyPrint(row.note.ydoc)
    if (print === kept.bodyFp) return kept
    return { bodyHlc: row.note.deletedAt === null ? clock.tick() : kept.bodyHlc, bodyFp: print }
  }

  async function applyPulled(pulled: PulledRecord): Promise<boolean> {
    const skip = (code: string) => {
      console.warn('W_SYNC_RECORD_SKIPPED', pulled.id, code)
      unreadable = true
      if (!skippedIds.has(pulled.id)) {
        skippedIds.add(pulled.id)
        set({ skipped: skippedIds.size })
      }
      return false
    }
    if (pulled.kind !== 'record' && pulled.kind !== 'file') return false
    if (!pulled.plaintext) return skip(pulled.error ?? 'E_SYNC_RECORD_EMPTY')
    if (pulled.id === MOVED_ID) {
      let to: TransportName
      try {
        to = readMoved(pulled.plaintext)
      } catch (error) {
        return skip(errorCode(error))
      }
      if (to !== via) {
        console.warn('W_SYNC_VAULT_MOVED', via, to)
        throw new Error(VAULT_MOVED)
      }
      return false
    }
    let remote: SyncRecord
    try {
      remote = decodeRecord(pulled.id, pulled.plaintext)
    } catch (error) {
      return skip(errorCode(error))
    }
    if ((remote.kind === 'file') !== (pulled.kind === 'file')) return skip('E_SYNC_RECORD_KIND')
    receiveStored(clock, stampsOf(remote))
    for (let tries = 1; ; tries += 1) {
      const [local] = await sync.syncRead([pulled.id])
      if (local?.entry && pulled.version <= local.entry.version) return false
      try {
        const applied = await applyRemote(local, remote, pulled.version, pulled.tag)
        if (skippedIds.delete(pulled.id)) set({ skipped: skippedIds.size })
        return applied
      } catch (error) {
        const code = errorCode(error)
        if (code === 'E_NOTE_BODY_STALE' && tries < WRITE_TRIES) continue
        // Still racing local writes: stop before `since` passes the record, so it is pulled again.
        if (code === 'E_NOTE_BODY_STALE' || storageFailure(code)) throw error
        return skip(code)
      }
    }
  }

  async function applyRemote(
    local: SyncLocal | undefined,
    remote: SyncRecord,
    version: number,
    tag: string,
  ): Promise<boolean> {
    if (remote.kind === 'file' && remote.purged) makeRoom()
    const stamped = local ? stamp(local) : { bodyHlc: '', bodyFp: '' }
    const mine = stateOf(local, stamped.bodyHlc)
    if (mine && mine.kind !== remote.kind) {
      console.warn('W_SYNC_RECORD_SKIPPED', remote.id, 'E_SYNC_RECORD_KIND')
      return false
    }
    const merged = mine
      ? keptBody(mine, remote, mergeRecord(mine, remote) as MergedNote)
      : { record: remote, localNews: false, remoteNews: !('purged' in remote && remote.purged) }
    if (merged.remoteNews) await write(local, merged.record, merged as MergedNote, remote)
    if (merged.remoteNews && mine?.kind === 'tag' && merged.record.kind === 'tag') {
      await followRename(mine, merged.record)
    }
    const [after] = merged.remoteNews ? await sync.syncRead([remote.id]) : [local]
    const bodyHlc = merged.record.kind === 'note' ? merged.record.bodyHlc : ''
    const state = stateOf(after, bodyHlc) ?? merged.record
    await sync.syncPut({
      id: remote.id,
      kind: remote.kind,
      version,
      tag,
      fingerprint: fingerprint(merged.localNews ? remote : state),
      bodyHlc,
      bodyFp: state.kind === 'note' ? bodyPrint(state.ydoc) : '',
      synced: after?.entry?.synced ?? 0,
    })
    return merged.remoteNews
  }

  /**
   * A rename pulled for a tag also renames it in the saved searches here, as a rename made here
   * does: one saved here by the old name before the rename came would otherwise name no tag. The
   * rewrites are ordinary edits, pushed with the rest.
   */
  async function followRename(before: TagState, after: TagState) {
    if (after.deletedAt !== null || sameName(before.name, after.name)) return
    const tags = await storage.listTags()
    for (const search of await storage.listSavedSearches()) {
      let rewritten: SavedSearchRecord[]
      try {
        rewritten = retargetSavedSearches([search], tags, before, after.name, clock, now())
      } catch (error) {
        console.warn('W_SYNC_SEARCH_NOT_RETARGETED', search.id, errorCode(error))
        continue
      }
      for (const record of rewritten) await storage.putSavedSearch(record)
    }
  }

  /** A body version taken in the last REVISION_EVERY_MS: changes that only came from other devices are kept no more often than typing here is (#216). */
  async function keptLately(noteId: string) {
    const at = now()
    return (await storage.listRevisions(noteId)).some(
      (r) => r.kind === 'body' && r.at <= at && at - r.at < REVISION_EVERY_MS,
    )
  }

  /** Keeps the local body as a version labelled a merge, so Revision History can restore it. */
  async function keepVersion(note: NoteRecord) {
    if (note.bodyMd === '' && note.ydoc.length === 0) return
    await storage.putRevision({
      id: newId(),
      noteId: note.id,
      kind: 'body',
      at: now(),
      ydoc: note.ydoc,
      length: textLength(note.bodyMd),
      value: MERGE,
      words: countWords(note.bodyMd),
    })
  }

  async function writeFile(local: SyncLocal | undefined, record: FileState, remote: FileState) {
    if (record.purged) {
      if (local?.file) await sync.syncFileDelete(record.id)
      return
    }
    await sync.syncFilePut(
      {
        id: record.id,
        noteId: record.noteId,
        noteHlc: record.noteHlc,
        name: record.name,
        mime: record.mime,
        size: record.size,
        createdAt: record.createdAt,
      },
      remote.data,
    )
  }

  async function write(
    local: SyncLocal | undefined,
    record: SyncRecord,
    merged: MergedNote,
    remote: SyncRecord,
  ) {
    if (record.kind === 'file') return writeFile(local, record, remote as FileState)
    if (record.kind === 'book') return storage.putBook(bookRecordOf(record))
    if (record.kind === 'tag') return storage.putTag(tagRecordOf(record))
    if (record.kind === 'search') return storage.putSavedSearch(searchRecordOf(record))
    const row = local?.note
    if (record.purged) {
      if (!row || row.purged) return
      await keepVersion(row.note)
      return sync.syncPurge(record.id, now(), record.deletedHlc || clock.tick())
    }
    if (row && merged.bodyChanged && (merged.bothEdited || !(await keptLately(row.note.id)))) {
      await keepVersion(row.note)
    }
    await storage.putNote(noteRecordOf(record, row?.note.bodyVersion ?? 0))
    const had = new Map((row?.tags ?? []).map((t) => [t.tagId, t.hlc]))
    for (const tag of record.tags) {
      if (had.get(tag.tagId) === tag.hlc) continue
      await storage.putNoteTag({ noteId: record.id, ...tag })
    }
  }

  const breaker = (id: string) => {
    const at = now()
    const recent = (pushTimes.get(id) ?? []).filter((t) => t > at - BREAKER_WINDOW_MS)
    recent.push(at)
    pushTimes.set(id, recent)
    if (recent.length > BREAKER_PUSHES) throw new Error('E_SYNC_CIRCUIT_OPEN')
  }

  const backoff = (attempt: number) => retryBaseMs * 2 ** attempt * (0.5 + random())

  const pending = async (each: (id: string, edits: number) => Promise<void>) => {
    let after = ''
    for (;;) {
      const rows = await sync.syncPending(after, PAGE)
      for (const row of rows) await each(row.id, row.edits)
      if (rows.length < PAGE) return
      after = rows.at(-1)!.id
    }
  }

  /** Counts the records sent while a large backlog goes out; `step` after each one, `show` to report now. */
  async function trackUpload() {
    // Records kept here (too large, refused, parked) stay pending but are not part of the backlog.
    const kept = new Set([...tooLarge.keys(), ...unsynced.keys(), ...parked])
    const remaining = Math.max(0, (await sync.syncPendingCount()) - kept.size)
    const stored = Number((await sync.syncState())[UPLOAD_TOTAL] ?? '0') || 0
    if (stored === 0 && remaining < uploadShownFrom) return undefined
    const total = Math.max(stored, remaining)
    if (total !== stored) await sync.syncSetState(UPLOAD_TOTAL, String(total))
    let sent = total - remaining
    let shown = now()
    const show = () => {
      shown = now()
      set({ upload: { sent, total } })
    }
    show()
    return {
      step() {
        sent = Math.min(total, sent + 1)
        if (now() - shown >= PROGRESS_EVERY_MS) show()
      },
      show,
    }
  }

  function forgetOldPushes() {
    const since = now() - BREAKER_WINDOW_MS
    for (const [id, times] of pushTimes) if ((times.at(-1) ?? 0) <= since) pushTimes.delete(id)
  }

  async function pushAll() {
    try {
      await pushEach()
    } finally {
      forgetOldPushes()
    }
  }

  const kept = (id: string) => tooLarge.has(id) || unsynced.has(id) || parked.has(id)

  async function pushEach() {
    const upload = await trackUpload()
    let full: Paused | undefined
    const refused = (paused: Paused | undefined) => {
      if (paused) full = paused
    }
    try {
      do {
        roomMade = false
        shownRefused = undefined
        if (upload) {
          await pushBatches(upload, refused)
        } else {
          await pending(async (id) => {
            if (!parked.has(id)) refused(await pushOne(id))
          })
        }
        full ??= shownRefused
        // A purge pushed in this pass made room: the attachments it passed over are tried again.
      } while (roomMade && !full)
      if (full) throw full
    } catch (error) {
      upload?.show()
      throw error
    }
    if (!upload) return
    await sync.syncSetState(UPLOAD_TOTAL, '0')
    set({ upload: null })
  }

  /** A backlog (a first upload, a new epoch) goes out in batches; each result is taken as a single push's. */
  async function pushBatches(
    upload: NonNullable<Awaited<ReturnType<typeof trackUpload>>>,
    refused: (paused: Paused | undefined) => void,
  ) {
    const batch: Ready[] = []
    const inBatch = new Set<string>()
    let bytes = 0
    const flush = async () => {
      if (batch.length === 0) return
      const sent = batch.splice(0)
      inBatch.clear()
      bytes = 0
      const results = await transport.pushMany(sent.map((ready) => ready.item))
      const again: string[] = []
      // A batch need not be atomic: items after one that ends the pass may still have been pushed.
      let ended: unknown
      for (const [at, ready] of sent.entries()) {
        let outcome: Awaited<ReturnType<typeof settle>>
        try {
          outcome = await settle(ready, results[at] ?? { type: 'failed', code: 'E_SYNC_PROTOCOL' })
        } catch (error) {
          ended ??= error
          continue
        }
        if (outcome === 'rejected') {
          again.push(ready.id)
          continue
        }
        refused(outcome)
        if (!kept(ready.id)) upload.step()
      }
      if (ended !== undefined) throw ended
      if (again.length === 0) return
      await sleep(backoff(0))
      await pullAll()
      for (const id of again) {
        const paused = await pushOne(id, 1)
        refused(paused)
        if (!paused && !kept(id)) upload.step()
      }
    }
    await pending(async (id) => {
      if (parked.has(id)) return
      let ready: Ready | null | 'again'
      do ready = await prepare(id, inBatch)
      while (ready === 'again')
      if (!ready) {
        if (!kept(id)) upload.step()
        return
      }
      batch.push(ready)
      inBatch.add(id)
      bytes += ready.item.plaintext.length
      if (batch.length >= BATCH_RECORDS || bytes >= BATCH_BYTES) await flush()
    })
    await flush()
  }

  /**
   * Offline: the stamps of bodies changed here are taken now, so the Trash orders them right
   * later. A record whose `edits` this engine stamped already is skipped without reading it:
   * every write while offline used to re-read and hash every pending record.
   */
  const stampedEdits = new Map<string, number>()

  async function stampAll() {
    await pending(async (id, edits) => {
      if (stampedEdits.get(id) === edits) return
      const [local] = await sync.syncRead([id])
      const entry = local?.entry
      if (!local || !entry || !local.note) return
      const stamped = stamp(local)
      if (stamped.bodyFp !== entry.bodyFp) await sync.syncPut({ ...entry, ...stamped })
      stampedEdits.set(id, edits)
    })
  }

  /**
   * Sends the attachments a note shows before the note: another device then rarely sees a link
   * before its image. One already in the batch the note goes in is sent before it there.
   */
  async function pushShownFiles(state: NoteState, bodyMd: string, inBatch?: ReadonlySet<string>) {
    if (state.purged) return
    const ids = fileLinks(bodyMd).slice(0, MAX_SHOWN_FILES)
    for (let at = 0; at < ids.length; at += MAX_SYNC_IDS) {
      const rows = await sync.syncRead(ids.slice(at, at + MAX_SYNC_IDS))
      for (const row of rows) {
        const entry = row.entry
        if (!row.file || !entry || entry.kind !== 'file' || entry.edits === entry.synced) continue
        if (inBatch?.has(row.id)) continue
        // A refused image stays here (pushOne kept it) and the note goes on: notes and purges still fit.
        shownRefused ??= await pushOne(row.id)
      }
    }
  }

  /** What the relay says to an attachment it cannot take, kept apart from a note's: notes still sync. */
  function keepLocal(id: string, print: string, code: string) {
    unsynced.set(id, { print, code })
    reportUnsynced()
  }

  interface Ready {
    id: string
    entry: SyncEntry
    stamped: { bodyHlc: string; bodyFp: string }
    print: string
    state: SyncRecord
    item: PushItem
  }

  /** The push a record needs now: null when it needs none (in step, or kept here), 'again' when it was purged under the read. */
  async function prepare(
    id: string,
    inBatch?: ReadonlySet<string>,
  ): Promise<Ready | null | 'again'> {
    // The socket closed between two pushes: the pass stops, so the upload keeps its place.
    if (!connected) throw new Error('E_SYNC_OFFLINE')
    const [local] = await sync.syncRead([id])
    const entry: SyncEntry | null | undefined = local?.entry
    if (!local || !entry) return null
    if (id === MOVED_ID) {
      console.warn('W_SYNC_RESERVED_ID', id)
      await sync.syncPut({ ...entry, synced: entry.edits })
      return null
    }
    const stamped = stamp(local)
    const state = stateOf(local, stamped.bodyHlc)
    if (!state) {
      await sync.syncPut({ ...entry, synced: entry.edits })
      return null
    }
    const print = fingerprint(state)
    if (print === entry.fingerprint) {
      if (unsynced.delete(id)) reportUnsynced()
      await sync.syncPut({ ...entry, ...stamped, synced: entry.edits })
      return null
    }
    if (stamped.bodyFp !== entry.bodyFp) await sync.syncPut({ ...entry, ...stamped })
    if (tooLarge.get(id) === print) return null
    const left = unsynced.get(id)
    if (left && left.print === print) return null
    if (left) unsynced.delete(id)
    if (state.kind === 'file' && !filesSupported) {
      console.warn('W_SYNC_RELAY_FILES_UNSUPPORTED', id)
      keepLocal(id, print, FILES_UNSUPPORTED)
      return null
    }
    if (state.kind === 'file' && !state.purged && fullAt !== undefined && state.size >= fullAt) {
      keepLocal(id, print, FILES_FULL)
      return null
    }
    if (state.kind === 'note' && local.note) {
      await pushShownFiles(state, local.note.note.bodyMd, inBatch)
    }
    breaker(id)
    let plaintext: Uint8Array
    if (state.kind === 'file' && !state.purged) {
      const data = await sync.syncFileData(id)
      // Purged between the read and now: the next look finds the tombstone.
      if (!data) return 'again'
      plaintext = encodeRecord({ ...state, data })
    } else {
      plaintext = encodeRecord(state)
    }
    const known = serverTags.get(id)
    const tag = known && known.version === entry.version ? known.tag : entry.tag
    const kind = state.kind === 'file' ? 'file' : 'record'
    return {
      id,
      entry,
      stamped,
      print,
      state,
      item: { id, base: entry.version, tag, plaintext, kind },
    }
  }

  /**
   * Takes in the transport's answer to one push. Returns the refusal when the storage is full (it
   * lasts past 00:00 UTC, and smaller records and purges still fit), and 'rejected' when another
   * device wrote first.
   */
  async function settle(
    ready: Ready,
    result: PushResult,
  ): Promise<Paused | undefined | 'rejected'> {
    const { id, entry, stamped, print, state } = ready
    if (result.type === 'failed') {
      if (!recordFailure(result.code, ready.item.kind)) throw new Error(result.code)
      if (result.code === 'E_SYNC_BAD_MESSAGE') {
        // A relay that does not know attachments: the image stays here and the owner is told to update.
        console.warn('W_SYNC_RELAY_FILES_UNSUPPORTED', id)
        keepLocal(id, print, FILES_UNSUPPORTED)
        set({ relayOutdated: true })
        return undefined
      }
      console.warn('W_SYNC_TOO_LARGE', id)
      tooLarge.set(id, print)
      set({ tooLarge: [...tooLarge.keys()] })
      return undefined
    }
    if (result.type === 'full') {
      console.warn('W_SYNC_ATTACHMENTS_FULL', id)
      if (state.kind === 'file') fullAt = Math.min(fullAt ?? state.size, state.size)
      keepLocal(id, print, FILES_FULL)
      return undefined
    }
    if (result.type === 'paused') {
      const paused = pausedBy(result)
      if (!pauseGoesOn(result)) throw paused
      // The relay's stored bytes: the image waits for room. A full iCloud: everything is tried again when it is looked at.
      if (paused.storageFull && state.kind === 'file' && !state.purged) {
        keepLocal(id, print, FILES_FULL)
      }
      return paused
    }
    if (result.type === 'rejected') {
      serverTags.set(id, { version: result.version, tag: result.tag })
      return 'rejected'
    }
    if (tooLarge.delete(id)) set({ tooLarge: [...tooLarge.keys()] })
    serverTags.delete(id)
    await sync.syncPut({
      id,
      kind: entry.kind,
      version: result.version,
      tag: result.tag,
      fingerprint: print,
      ...stamped,
      synced: entry.edits,
    })
    if (state.kind === 'file' && state.purged) makeRoom()
    return undefined
  }

  /** One record, pushed again after a pull and merge while another device keeps writing first, up to the retry cap. */
  async function pushOne(id: string, from = 0): Promise<Paused | undefined> {
    for (let attempt = from; ; attempt += 1) {
      const ready = await prepare(id)
      if (ready === 'again') continue
      if (!ready) return undefined
      const { item } = ready
      let result: PushResult
      try {
        result = await transport.push(item.id, item.base, item.plaintext, item.kind, item.tag)
      } catch (error) {
        result = { type: 'failed', code: errorCode(error, 'E_SYNC_FAILED') }
      }
      const outcome = await settle(ready, result)
      if (outcome !== 'rejected') return outcome
      if (attempt >= MAX_PUSH_RETRIES) {
        console.warn('W_SYNC_PUSH_PARKED', id)
        parked.add(id)
        return undefined
      }
      await sleep(backoff(attempt))
      await pullAll()
    }
  }

  return {
    start() {
      if (running) return
      running = true
      void sync
        .syncState()
        .then((state) => {
          const last = Number(state['lastSync'])
          if (Number.isFinite(last) && last > 0 && status.lastSync === null) set({ lastSync: last })
        })
        .catch(() => undefined)
      void enqueue(() => connect(true)).catch(() => undefined)
    },
    async stop() {
      running = false
      connected = false
      clearTimeout(reconnectTimer)
      clearTimeout(pushTimer)
      reconnectTimer = undefined
      pushTimer = undefined
      firstTouch = undefined
      passQueued = false
      await transport.close().catch(() => undefined)
      await queue
      unsynced.clear()
      fullAt = undefined
      set({ state: 'off', code: null, upload: null, relayOutdated: false, unsyncedFiles: null })
    },
    touch() {
      if (!running) return
      const at = now()
      firstTouch ??= at
      clearTimeout(pushTimer)
      const wait = Math.max(0, Math.min(idleMs, firstTouch + everyMs - at))
      pushTimer = setTimeout(() => {
        pushTimer = undefined
        firstTouch = undefined
        void enqueue(async () => {
          if (!connected) return stampAll()
          set({ state: 'syncing' })
          await pushAll()
          await finishPass()
        }).catch(() => undefined)
      }, wait)
    },
    received(event) {
      if (!running) return
      if (event.type === 'changed') {
        if (!connected) return
        parked.clear()
        if (passQueued) return
        passQueued = true
        void enqueue(async () => {
          passQueued = false
          // A failure before this pass (a stop, a drop) closed the connection it was queued on.
          if (connected) await syncAll()
        }).catch(() => undefined)
        return
      }
      if (!connected) return
      void failed(new Error(event.code))
    },
    status: () => status,
    afterRestore: (choice) =>
      enqueue(async () => {
        if (!(await sync.syncState())[RESTORED_AT]) return
        if (choice === 'keep') await keepRestored()
        await sync.syncSetState(RESTORED_AT, '')
        set({ code: null })
        await connect(true)
      }).catch(() => undefined),
    focused() {
      if (!running || status.state !== 'paused' || status.pausedUntil !== null) return
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      void enqueue(() => connect(true)).catch(() => undefined)
    },
    pushesRemembered: () => pushTimes.size,
    syncNow: () => enqueue(() => connect()).catch(() => undefined),
    async idle() {
      for (let seen: Promise<void> | undefined; seen !== queue;) {
        seen = queue
        await seen
      }
    },
  }
}
