// The sync engine (docs/adr/0002-sync-latest-state-per-record.md, Client): pulls what other devices
// wrote and merges it into storage, and pushes what changed here. The relay keeps one sealed copy of
// each record and takes a push only when it is based on the version it holds (compare-and-swap); a
// rejected push pulls, merges and pushes again. Storage marks every written record (schema v19), so
// the engine looks only at those, and pushes one only when its state differs from the one the relay
// holds (`fingerprint`).
//
// It runs one task at a time. Pushes wait for 3 s without writes, and go at least every 10 s while
// writes go on. It refuses to sync while this device's clock is more than 5 minutes off the relay's,
// and a new vault epoch (a relay that lost its data, or a new one) means every record is uploaded
// again. Revoked, unknown or refused devices stop until the user acts; anything else retries with
// backoff and jitter.

import { errorCode } from '../errors'
import { receiveStored, type Clock } from '../hlc'
import { clipTitle } from '../noteLimits'
import { isNotebookSymbol } from '../notebookIcons'
import { MERGE, REVISION_EVERY_MS, textLength } from '../revisions'
import type { BookRecord, NoteRecord, StorageAdapter, TagRecord } from '../storage'
import { isTagColor } from '../tags'
import {
  bodyPrint,
  decodeRecord,
  encodeRecord,
  fingerprint,
  mergeRecord,
  stampsOf,
  bodyFacts,
  tombstone,
  type BookState,
  type MergedNote,
  type NoteState,
  type SyncRecord,
  type TagState,
} from './records'
import type { SyncEntry, SyncLocal, SyncStore } from './store'
import type { PulledRecord, SyncEvent, SyncTransport } from './transport'

export const PUSH_IDLE_MS = 3_000
export const PUSH_EVERY_MS = 10_000
export const MAX_PUSH_RETRIES = 5
export const MAX_CLOCK_SKEW_MS = 5 * 60_000
const RETRY_BASE_MS = 250
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 5 * 60_000
const SKEW_RECHECK_MS = 5 * 60_000
/** Until the quota UI (#215) knows the relay's reset time. */
const QUOTA_RECHECK_MS = 60 * 60_000
/** One record pushed this often within a minute is a loop between devices, not typing (6 a minute at most). */
const BREAKER_PUSHES = 30
const BREAKER_WINDOW_MS = 60_000
const PAGE = 100
const WRITE_TRIES = 5

export type SyncState = 'off' | 'connecting' | 'syncing' | 'idle' | 'offline' | 'paused' | 'stopped'

export interface SyncStatus {
  state: SyncState
  lastSync: number | null
  /** Why sync is offline, paused or stopped. */
  code: string | null
  /** Records past the relay's size limit, kept on this device only. */
  tooLarge: string[]
}

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
  // The build gates sync and no valid licence is on this device (src-tauri/src/licence).
  'E_LICENCE_REQUIRED',
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

function stateOf(local: SyncLocal | undefined, bodyHlc: string): SyncRecord | null {
  if (local?.note) return noteStateOf(local.note, bodyHlc)
  if (local?.book) return bookStateOf(local.book)
  if (local?.tag) return tagStateOf(local.tag)
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
  icon: isNotebookSymbol(state.icon) ? state.icon : null,
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
  color: isTagColor(state.color) ? state.color : null,
  colorHlc: state.colorHlc,
})

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { storage, sync, transport, clock, newId } = options
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const idleMs = options.idleMs ?? PUSH_IDLE_MS
  const everyMs = options.everyMs ?? PUSH_EVERY_MS
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS

  let running = false
  let connected = false
  let status: SyncStatus = { state: 'off', lastSync: null, code: null, tooLarge: [] }
  let queue: Promise<void> = Promise.resolve()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = RECONNECT_MIN_MS
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  let firstTouch: number | undefined
  /** Record ID to the fingerprint the relay refused as too large; a changed record is tried again. */
  const tooLarge = new Map<string, string>()
  /** Past the retry cap: left until the next `changed`. */
  const parked = new Set<string>()
  const pushTimes = new Map<string, number[]>()

  const set = (patch: Partial<SyncStatus>) => {
    status = { ...status, ...patch }
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

  async function failed(error: unknown) {
    if (!running) return
    const code = errorCode(error, 'E_SYNC_FAILED')
    console.warn('W_SYNC_FAILED', code)
    connected = false
    await transport.close().catch(() => undefined)
    // A request cut off by the close that stopped sync must not turn the stop into a retry.
    const stoppedFor = status.state === 'stopped' ? status.code : null
    if (stoppedFor && stoppedFor !== 'E_SYNC_CLOCK_SKEW' && !STOPPING.has(code)) return
    if (STOPPING.has(code)) {
      set({ state: 'stopped', code })
      if (code === 'E_SYNC_CLOCK_SKEW') reconnect(SKEW_RECHECK_MS)
    } else if (code === 'E_SYNC_QUOTA') {
      set({ state: 'paused', code })
      reconnect(QUOTA_RECHECK_MS)
    } else {
      set({ state: 'offline', code })
      reconnect()
    }
  }

  /** A device that was stopped (revoked, refused) stays so until sync is turned off and on, or a recheck (`again`). */
  async function connect(again = false) {
    if (connected) return syncAll()
    if (status.state === 'stopped' && !again) return
    set({ state: 'connecting' })
    const welcome = await transport.connect()
    if (Math.abs(welcome.time - now()) > MAX_CLOCK_SKEW_MS) throw new Error('E_SYNC_CLOCK_SKEW')
    const state = await sync.syncState()
    if (state['epoch'] !== welcome.epoch) {
      await sync.syncReset()
      await sync.syncSetState('since', '0')
      await sync.syncSetState('epoch', welcome.epoch)
      tooLarge.clear()
      parked.clear()
    }
    connected = true
    reconnectDelay = RECONNECT_MIN_MS
    await syncAll()
  }

  async function syncAll() {
    set({ state: 'syncing' })
    await pullAll()
    await pushAll()
    const at = now()
    await sync.syncSetState('lastSync', String(at))
    set({ state: 'idle', code: null, lastSync: at })
  }

  async function pullAll() {
    let since = Number((await sync.syncState())['since'] ?? '0') || 0
    for (;;) {
      const page = await transport.pull(since)
      const applied: string[] = []
      try {
        for (const record of page.records) {
          if (await applyPulled(record)) applied.push(record.id)
        }
      } finally {
        if (applied.length > 0) options.onApplied?.(applied)
      }
      const advanced = page.next > since
      since = Math.max(since, page.next)
      await sync.syncSetState('since', String(since))
      if (!page.more || !advanced) return
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
    if (pulled.kind !== 'record') return false
    if (!pulled.plaintext) {
      console.warn('W_SYNC_RECORD_SKIPPED', pulled.id, pulled.error ?? 'E_SYNC_RECORD_EMPTY')
      return false
    }
    let remote: SyncRecord
    try {
      remote = decodeRecord(pulled.id, pulled.plaintext)
    } catch (error) {
      console.warn('W_SYNC_RECORD_SKIPPED', pulled.id, errorCode(error))
      return false
    }
    receiveStored(clock, stampsOf(remote))
    for (let tries = 1; ; tries += 1) {
      const [local] = await sync.syncRead([pulled.id])
      if (local?.entry && pulled.version <= local.entry.version) return false
      try {
        return await applyRemote(local, remote, pulled.version)
      } catch (error) {
        const code = errorCode(error)
        if (code === 'E_NOTE_BODY_STALE' && tries < WRITE_TRIES) continue
        // Still racing local writes: stop before `since` passes the record, so it is pulled again.
        if (code === 'E_NOTE_BODY_STALE' || storageFailure(code)) throw error
        console.warn('W_SYNC_RECORD_SKIPPED', pulled.id, code)
        return false
      }
    }
  }

  async function applyRemote(
    local: SyncLocal | undefined,
    remote: SyncRecord,
    version: number,
  ): Promise<boolean> {
    const stamped = local ? stamp(local) : { bodyHlc: '', bodyFp: '' }
    const mine = stateOf(local, stamped.bodyHlc)
    if (mine && mine.kind !== remote.kind) {
      console.warn('W_SYNC_RECORD_SKIPPED', remote.id, 'E_SYNC_RECORD_KIND')
      return false
    }
    const merged = mine
      ? mergeRecord(mine, remote)
      : { record: remote, localNews: false, remoteNews: !(remote.kind === 'note' && remote.purged) }
    if (merged.remoteNews) await write(local, merged.record, merged as MergedNote)
    const [after] = merged.remoteNews ? await sync.syncRead([remote.id]) : [local]
    const bodyHlc = merged.record.kind === 'note' ? merged.record.bodyHlc : ''
    const state = stateOf(after, bodyHlc) ?? merged.record
    await sync.syncPut({
      id: remote.id,
      kind: remote.kind,
      version,
      fingerprint: fingerprint(merged.localNews ? remote : state),
      bodyHlc,
      bodyFp: state.kind === 'note' ? bodyPrint(state.ydoc) : '',
      synced: after?.entry?.synced ?? 0,
    })
    return merged.remoteNews
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
    })
  }

  async function write(local: SyncLocal | undefined, record: SyncRecord, merged: MergedNote) {
    if (record.kind === 'book') return storage.putBook(bookRecordOf(record))
    if (record.kind === 'tag') return storage.putTag(tagRecordOf(record))
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

  const pending = async (each: (id: string) => Promise<void>) => {
    let after = ''
    for (;;) {
      const ids = await sync.syncPending(after, PAGE)
      for (const id of ids) await each(id)
      if (ids.length < PAGE) return
      after = ids.at(-1)!
    }
  }

  async function pushAll() {
    await pending(async (id) => {
      if (!parked.has(id)) await pushOne(id)
    })
  }

  /** Offline: the stamps of bodies changed here are taken now, so the Trash orders them right later. */
  async function stampAll() {
    await pending(async (id) => {
      const [local] = await sync.syncRead([id])
      const entry = local?.entry
      if (!local || !entry || !local.note) return
      const stamped = stamp(local)
      if (stamped.bodyFp !== entry.bodyFp) await sync.syncPut({ ...entry, ...stamped })
    })
  }

  async function pushOne(id: string) {
    for (let attempt = 0; ; attempt += 1) {
      if (!connected) return
      const [local] = await sync.syncRead([id])
      const entry: SyncEntry | null | undefined = local?.entry
      if (!local || !entry) return
      const stamped = stamp(local)
      const state = stateOf(local, stamped.bodyHlc)
      if (!state) return sync.syncPut({ ...entry, synced: entry.edits })
      const print = fingerprint(state)
      if (print === entry.fingerprint) {
        return sync.syncPut({ ...entry, ...stamped, synced: entry.edits })
      }
      if (stamped.bodyFp !== entry.bodyFp) await sync.syncPut({ ...entry, ...stamped })
      if (tooLarge.get(id) === print) return
      breaker(id)
      let result
      try {
        result = await transport.push(id, entry.version, encodeRecord(state))
      } catch (error) {
        if (errorCode(error) !== 'E_SYNC_TOO_LARGE') throw error
        console.warn('W_SYNC_TOO_LARGE', id)
        tooLarge.set(id, print)
        set({ tooLarge: [...tooLarge.keys()] })
        return
      }
      if (result.type === 'pushed') {
        if (tooLarge.delete(id)) set({ tooLarge: [...tooLarge.keys()] })
        return sync.syncPut({
          id,
          kind: entry.kind,
          version: result.version,
          fingerprint: print,
          ...stamped,
          synced: entry.edits,
        })
      }
      if (attempt >= MAX_PUSH_RETRIES) {
        console.warn('W_SYNC_PUSH_PARKED', id)
        parked.add(id)
        return
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
      await transport.close().catch(() => undefined)
      await queue
      set({ state: 'off', code: null })
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
          set({ state: 'idle', code: null })
        }).catch(() => undefined)
      }, wait)
    },
    received(event) {
      if (!running) return
      if (event.type === 'changed') {
        if (!connected) return
        parked.clear()
        void enqueue(syncAll).catch(() => undefined)
        return
      }
      if (!connected) return
      void failed(new Error(event.code))
    },
    status: () => status,
    syncNow: () => enqueue(() => connect()).catch(() => undefined),
    async idle() {
      for (let seen: Promise<void> | undefined; seen !== queue;) {
        seen = queue
        await seen
      }
    },
  }
}
