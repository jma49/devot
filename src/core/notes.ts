// Note service: owns each open note's Yjs document and persists whole records through the storage adapter.
//
// Writes of one note run one at a time, in order. A failed write keeps its changes in memory, is retried and reported (onSaveProblems).
// Every write is based on the stored body version (NoteRecord.bodyVersion); when another process wrote first, the note merges the stored copy in
// (Yjs merge, newer HLC per metadata field) and writes again (see put).
// Only the NOTES_IN_MEMORY most recently used notes stay loaded, and only when nothing would be lost (see trim).
// Writes of one note are serialised, each taken from the note as it is when it starts, so an older snapshot never lands after a newer one.
// Revision history lives in revisions.ts; compaction sweeps run on their own queue so no user action waits for them (see sweep).

import * as Y from 'yjs'
import { loadActivity, type ActivityHeatmap, type OffsetAt } from './activity'
import { TEMPLATES_BOOK_ID } from './books'
import { foldUnchanged, lineDiff, textEdits, type DiffBlock } from './diff'
import { errorCode } from './errors'
import { headline, listExcerpt, taskProgress } from './extract'
import { formatHlc, parseHlc, receiveStored, type Clock } from './hlc'
import { sha256Hex } from './sha256'
import {
  AI_EDIT,
  BASELINE,
  COMPACT_BATCH,
  COMPACT_EVERY_MS,
  COMPACT_PAGE,
  compactionWindows,
  historyEntries,
  REVISION_EVERY_MS,
  REVISION_PAUSE_MS,
  revisionsToDrop,
  textLength,
  type HistoryEntry,
} from './revisions'
import {
  excludeTemplates,
  parseSearch,
  resolveSearch,
  SEARCH_LIMIT,
  tidyExcerpt,
  type SearchClause,
  type SearchScope,
} from './search'
import {
  MAX_BODY_IDS,
  NOTE_STATUSES,
  type CompactableVersion,
  type NoteBody,
  type NoteRecord,
  type NoteStatus,
  type NoteSummary,
  type RevisionKind,
  type StorageAdapter,
  type TrashedNote,
} from './storage'
import { extractTitle } from './extract'
import { findBacklinks } from './links'
import type { NoteLinkTarget } from './preview/registry'
import { fileLinkSpans, newFileCopies, replaceFileLinks, type FileCopy } from './files'
import { clipTitle, MAX_TITLE_CHARS } from './noteLimits'
import type { NoteRelayMessage, TakenIn } from './noteRelay'
import { lineFeeds } from './text'

const MAX_LINK_TARGETS = 500

export const BODY = 'body'

/** Notes beyond this go once nothing of them can be lost (see trim); held and busy notes stay besides. */
export const NOTES_IN_MEMORY = 8

export type MetaChange = { bookId: string | null } | { status: NoteStatus } | { pinned: boolean }

export interface RowDetail {
  excerpt: string
  progress: string
}

export interface OpenedNote {
  id: string
  title: string
  /** Yjs state for the editor's replica: full, or what the replica with the given state vector lacks. */
  state: Uint8Array
}

export interface SaveProblem {
  id: string
  code: string
}

export interface NoteServiceOptions {
  storage: StorageAdapter
  clock: Clock
  newId: () => string
  now?: () => number
  saveDelayMs?: number
  /** Doubles with each failure in a row, up to 30 s. */
  retryDelayMs?: number
  /** Called with every note whose save failed, oldest first, whenever that list changes. */
  onSaveProblems?: (problems: SaveProblem[]) => void
  /** On by default. devot-mcp turns it off: its writes hold the database write lock and its time zone may differ from the app's. */
  compact?: boolean
  /** Tells the cores of the app's other windows of every change to a note in memory, every write, and every note read in (see noteRelay.ts and receive). */
  relay?: (message: NoteRelayMessage) => void
  /** A note in memory took in a change it did not make: another window's (relayed), or one stored meanwhile (merged), for the editor and title field showing it. */
  onTakenIn?: (change: TakenIn) => void
}

export interface NoteService {
  list(limit?: number): Promise<NoteSummary[]>
  create(title?: string, bookId?: string | null): Promise<string>
  /** Makes note `id` holding `markdown` as a Yjs state every device builds byte for byte alike, so copies seeded on two devices merge as one (first-launch notes). */
  seed(id: string, title: string, bookId: string | null, markdown: string): Promise<void>
  open(id: string, known?: Uint8Array): Promise<OpenedNote>
  /** Pending edits included; loads the note for an editor to open next. Throws E_NOTE_NOT_FOUND. */
  title(id: string): Promise<string>
  /** Keeps the note in memory until as many `unhold` calls, so the editor's replica and this service never part. */
  hold(id: string): void
  unhold(id: string): void
  /** Read without keeping the note in memory. Throws E_NOTE_NOT_FOUND. */
  read(id: string): Promise<{ id: string; title: string; bodyMd: string; bookId: string | null }>
  /** Untitled notes' list names: the first line of the body (see `headline`). Missing notes are left out. */
  headlines(ids: readonly string[]): Promise<Record<string, string>>
  /** List excerpts (see `listExcerpt`), pending edits included. Missing notes are left out. */
  excerpts(ids: readonly string[]): Promise<Record<string, string>>
  /** What a list row shows under its title: the excerpt and "done/total" of its tasks ('' with none), from one read. Missing notes are left out. */
  rowDetails(ids: readonly string[]): Promise<Record<string, RowDetail>>
  /** Never pinned; a deleted notebook counts as none. `suffix` is kept by cutting the title to fit. Images become the copy's own (see extract); tags are the caller's (see duplicateNote). */
  duplicate(id: string, options?: { suffix?: string }): Promise<string>
  /** Images become the note's own copies so purging the source keeps them; if they cannot be copied no note is left and the copy's error is thrown. A given `title` (New Note from Link) names the note instead. */
  extract(
    sourceId: string,
    markdown: string,
    title?: string,
  ): Promise<{ id: string; title: string }>
  applyUpdate(id: string, update: Uint8Array): Promise<void>
  /** `anchor` is a Yjs relative position; the end of the body when null or foreign. For an editor that closed before its image was stored. Throws E_NOTE_NOT_FOUND. */
  insertAt(id: string, anchor: Uint8Array | null, markdown: string): Promise<void>
  /** Fills from a template on the live text so typing meanwhile stays: `title` only while none is set, `markdown` after the body. */
  fill(id: string, content: { title: string; markdown: string }): Promise<void>
  /** Applies the text difference as Yjs operations (see textEdits), never by writing the snapshot. */
  setBody(id: string, markdown: string): Promise<void>
  /** On a failed save the note is dropped anyway and the error thrown: the caller (import, devot-mcp) undoes or reports it. */
  release(id: string): Promise<void>
  /** Line breaks become spaces and the title is cut to MAX_TITLE_CHARS (see clipTitle), so storage always takes it. */
  setTitle(id: string, title: string): Promise<void>
  setBook(id: string, bookId: string | null): Promise<void>
  setStatus(id: string, status: NoteStatus): Promise<void>
  /** Both dates take one new HLC so the change wins over older writes (schema v17). */
  /** Throws E_NOTE_TIME_INVALID for a date that is not a whole, non-negative millisecond time, or an update before the creation. */
  setDates(id: string, dates: { createdAt?: number; updatedAt?: number }): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<void>
  /** Writes now (a batch writes each note before the next). On failure it rejects and the field reverts unless changed again meanwhile. A note not in memory is not loaded: its stored record is rewritten with the field changed. `bookChecked`: the caller already ran checkBook. */
  writeMeta(id: string, change: MetaChange, options?: { bookChecked?: boolean }): Promise<void>
  /** Templates count as a notebook; null always passes. */
  /** Throws E_BOOK_NOT_FOUND unless notes can go in `bookId`: a live notebook or Templates. */
  checkBook(bookId: string | null): Promise<void>
  /** With `versions` (quitting), unversioned typing also becomes a version. Rejects with E_NOTE_SAVE_FAILED and the IDs once the rest are saved. */
  flush(options?: { versions?: boolean }): Promise<void>
  /** Called before the database is replaced (backup restore), so no sweep deletes what it chose from the old data. */
  holdCompaction(): Promise<void>
  resumeCompaction(): void
  /** Templates are never found. `flush: false` (the `[[` popup runs on every key) searches as stored and writes nothing. */
  search(query: string, scope?: SearchScope, options?: { flush?: boolean }): Promise<NoteSummary[]>
  /** Pending edits are saved first; when the write fails it rejects and the note stays where it was. */
  trash(id: string): Promise<void>
  restore(id: string): Promise<void>
  listTrash(): Promise<TrashedNote[]>
  peekTrashed(id: string): Promise<{
    id: string
    title: string
    bodyMd: string
    createdAt: number
    updatedAt: number
  }>
  /** Live notes only (never the Trash), as stored. */
  backlinks(id: string): Promise<NoteSummary[]>
  /** Pending edits included; a missing or trashed note is left out. */
  linkTargets(ids: readonly string[]): Promise<Record<string, NoteLinkTarget>>
  /** Pending edits are saved first so a link pasted a moment ago keeps its image. */
  purge(id: string): Promise<void>
  /** Resolves to how many notes were deleted. */
  emptyTrash(): Promise<number>
  history(id: string): Promise<HistoryEntry[]>
  /** Throws E_REVISION_NOT_FOUND for anything but a body version of this note. */
  compareRevision(id: string, revisionId: string): Promise<DiffBlock[]>
  /** Returns the Yjs update the edit made, for the editor's replica to apply as one undoable step. */
  restoreRevision(id: string, revisionId: string): Promise<Uint8Array>
  /**
   * Puts an accepted AI edit proposal in place of the text it was asked for: `original` at `from`, or wherever it now is if edits since moved it and it
   * is there once (else E_AI_PROPOSAL_STALE). Returns the Yjs update, for the editor's replica to apply as one undoable step. The text before is kept as
   * a version and the result as a version marked AI_EDIT.
   */
  applyAiEdit(
    id: string,
    edit: { from: number; original: string; replacement: string },
  ): Promise<Uint8Array>
  /** Pending edits are saved and unversioned typing becomes a version, so it counts. */
  activity(now: number, offsetAt?: OffsetAt): Promise<ActivityHeatmap>
  /**
   * Takes in what another process wrote (devot-mcp, or a writer on another connection; see `devot://db-changed`), so the next write keeps the other's changes.
   * Every note in memory merges the stored state. Returns the notes whose title the other process changed.
   */
  /** A note deleted for good meanwhile is let go; the others stay in memory (letting one go could lose an edit that has just loaded it). A note that cannot be read is left as it was. */
  mergeStored(): Promise<{ id: string; title: string }[]>
  /**
   * Takes in what another window's core relayed. A note not in memory ignores it: it is read from storage when used, and asks then for what
   * the others hold beyond that. A change taken in is saved by the window that made it, which also keeps the versions of its own typing.
   */
  receive(message: NoteRelayMessage): Promise<void>
}

/** The end of the body when there is no position or it names another text. */
function anchoredIndex(doc: Y.Doc, text: Y.Text, anchor: Uint8Array | null): number {
  if (anchor) {
    try {
      const found = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(anchor),
        doc,
      )
      if (found?.type === text) return Math.min(found.index, text.length)
    } catch {}
  }
  return text.length
}

type Timer = ReturnType<typeof setTimeout>

interface Live {
  record: NoteRecord
  saved: NoteRecord
  doc: Y.Doc
  timer: Timer | undefined
  edits: number
  savedEdits: number
  queue: Promise<void>
  writes: number
  /** Service calls using the note now (see using): it stays in memory while any does. */
  users: number
  /** Set when a retried write took in a title another process gave the note; mergeStored reports it. */
  retitled: boolean
  failures: number
  retry: Timer | undefined
  rev: {
    checked: boolean
    lastText: string | undefined
    pending: boolean
    pause: Timer | undefined
    every: Timer | undefined
    title: { id: string; at: number; from: string } | undefined
  }
}

const notFound = () => new Error('E_REVISION_NOT_FOUND')
const MAX_RETRY_MS = 30_000
/** Attempts when storage keeps refusing because another process wrote first; then the write fails like any other (see failed). */
const WRITE_TRIES = 5

const isStale = (error: unknown) => errorCode(error) === 'E_NOTE_BODY_STALE'

/** The origin of a change another window's core relayed, which is not relayed again. */
const RELAYED = Symbol('relayed')

const asWritten = (record: NoteRecord): NoteRecord => ({
  ...record,
  bodyVersion: record.bodyVersion + 1,
})

const untilWritten = async <T>(attempt: (retry: boolean) => Promise<T>): Promise<T> => {
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

const stampsOf = (record: NoteRecord) => META_HLCS.map((key) => record[key])

type MetaField = 'book' | 'status' | 'pinned'

const hlcOf = (record: NoteRecord, field: MetaField) =>
  field === 'book' ? record.bookHlc : field === 'status' ? record.statusHlc : record.pinnedHlc

const withField = (record: NoteRecord, from: NoteRecord, field: MetaField): NoteRecord => {
  if (field === 'book') return { ...record, bookId: from.bookId, bookHlc: from.bookHlc }
  if (field === 'status') return { ...record, status: from.status, statusHlc: from.statusHlc }
  return { ...record, pinned: from.pinned, pinnedHlc: from.pinnedHlc }
}

/** Storage's merge: per field the newer HLC wins. A title past the limit is cut. */
const withNewer = (to: NoteRecord, from: NoteRecord): NoteRecord => ({
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
    ? { createdAt: from.createdAt, updatedAt: from.updatedAt, datesHlc: from.datesHlc ?? '' }
    : { updatedAt: Math.max(to.updatedAt, from.updatedAt) }),
})

const holdsMore = (doc: Y.Doc, stored: NoteRecord) => {
  if (doc.getText(BODY).toString() !== stored.bodyMd) return true
  const theirs = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(stored.ydoc))
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
    if (clock > (theirs.get(client) ?? 0)) return true
  }
  return false
}

const asBody = (version: CompactableVersion) => ({ ...version, kind: 'body' as const })

const byNote = (versions: readonly CompactableVersion[]) => {
  const notes = new Map<string, CompactableVersion[]>()
  for (const version of versions) {
    const listed = notes.get(version.noteId)
    if (listed) listed.push(version)
    else notes.set(version.noteId, [version])
  }
  return notes
}

const codeOf = (error: unknown) => errorCode(error, 'E_STORAGE_WRITE_FAILED')

/** The Yjs client a seeded body is written as: the same for the same note and text, so their states are equal; another text gets another client, so two seeds never give two changes one ID. */
export const seedClient = (id: string, markdown: string) =>
  Number.parseInt(sha256Hex(`${id}\n${lineFeeds(markdown)}`).slice(0, 8), 16)

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}

const eventValue = (kind: Exclude<RevisionKind, 'body'>, record: NoteRecord): string | null => {
  if (kind === 'title') return record.title
  if (kind === 'book') return record.bookId
  if (kind === 'status') return record.status
  return record.pinned ? '1' : '0'
}
const EVENT_KINDS = ['title', 'book', 'status', 'pinned'] as const

export function createNoteService(options: NoteServiceOptions): NoteService {
  const { storage, clock, newId } = options
  const now = options.now ?? Date.now
  const saveDelayMs = options.saveDelayMs ?? 300
  const retryDelayMs = options.retryDelayMs ?? 1000
  // Notes in memory, the least recently used first (see load and trim).
  const live = new Map<string, Live>()
  const loading = new Map<string, { note: Promise<Live>; users: number }>()
  const holds = new Map<string, number>()
  const coldWrites = new Map<string, Promise<void>>()
  const failing = new Map<string, string>()
  const report = () => {
    try {
      options.onSaveProblems?.(Array.from(failing, ([id, code]) => ({ id, code })))
    } catch {
      // A listener that throws must not make a write that went through
      // look like one that failed.
    }
  }
  // Revision writes and sweeps run on separate queues so no user action waits for a sweep.
  const compacting = options.compact ?? true
  let held = false
  let sweptAt: number | undefined
  let sweeping: Promise<void> = Promise.resolve()
  // Revision writes, one after another; a failure is logged and skipped.
  let revisionWork: Promise<void> = Promise.resolve()
  const enqueue = (work: () => Promise<void>) => {
    revisionWork = revisionWork.then(work).catch((e: unknown) => {
      console.warn('W_REVISION_FAILED', errorCode(e))
    })
  }

  const relay = (message: NoteRelayMessage) => {
    try {
      options.relay?.(message)
    } catch {
      console.warn('W_NOTE_RELAY_FAILED', message.noteId)
    }
  }

  const relayChanges = (id: string, doc: Y.Doc) => {
    if (!options.relay) return
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAYED) relay({ kind: 'update', noteId: id, data: update })
    })
  }

  const tell = (change: TakenIn) => {
    try {
      options.onTakenIn?.(change)
    } catch {
      console.warn('W_NOTE_RELAY_FAILED', change.noteId)
    }
  }

  const liveNote = (record: NoteRecord, doc: Y.Doc, fresh: boolean): Live => {
    relayChanges(record.id, doc)
    return {
      record,
      saved: record,
      doc,
      timer: undefined,
      edits: 0,
      savedEdits: 0,
      queue: Promise.resolve(),
      writes: 0,
      users: 0,
      retitled: false,
      failures: 0,
      retry: undefined,
      rev: {
        checked: fresh,
        lastText: fresh ? '' : undefined,
        pending: false,
        pause: undefined,
        every: undefined,
        title: undefined,
      },
    }
  }

  const stopTimers = (note: Live) => {
    clearTimeout(note.rev.pause)
    clearTimeout(note.rev.every)
    note.rev.pause = undefined
    note.rev.every = undefined
    note.rev.pending = false
  }

  /** Thins old versions of notes that may have some to drop (see revisionsToDrop). Resumes where the last sweep ended (recorded in storage); an interrupted sweep is done again. */
  const compactAll = async (at: number) => {
    const stored = await storage.lastCompaction()
    // A last sweep after `at`: the clock was set back since.
    const last = stored !== null && stored <= at ? stored : undefined
    const weighed = new Set<string>()
    const drop: string[] = []
    for (const [from, to] of compactionWindows(last, at)) {
      let after = ''
      let more = from < to
      while (more) {
        const page = byNote(await storage.listCompactable(from, to, after, COMPACT_PAGE))
        for (const [noteId, versions] of page) {
          if (!weighed.has(noteId)) drop.push(...revisionsToDrop(versions.map(asBody), at))
          weighed.add(noteId)
          after = noteId
        }
        more = page.size === COMPACT_PAGE
        while (drop.length >= COMPACT_BATCH) {
          await storage.compactRevisions(drop.splice(0, COMPACT_BATCH), null)
        }
      }
    }
    await storage.compactRevisions(drop, at)
  }

  /** After a save, at most once per COMPACT_EVERY_MS, on its own queue (see compactAll). */
  const sweep = () => {
    if (!compacting || held) return
    const at = now()
    if (sweptAt !== undefined && at - sweptAt < COMPACT_EVERY_MS) return
    sweptAt = at
    sweeping = sweeping
      .then(() => compactAll(at))
      .catch((e: unknown) => console.warn('W_REVISION_COMPACT_FAILED', errorCode(e)))
  }

  const takeVersion = (note: Live, value: string | null = null) => {
    if (!note.rev.pending) return
    stopTimers(note)
    const { id } = note.record
    const text = note.doc.getText(BODY).toString()
    const ydoc = Y.encodeStateAsUpdate(note.doc)
    const at = now()
    enqueue(async () => {
      if (text === note.rev.lastText) return
      await storage.putRevision({
        id: newId(),
        noteId: id,
        kind: 'body',
        at,
        ydoc,
        length: textLength(text),
        value,
      })
      note.rev.lastText = text
    })
  }

  /** Keeps the text from before this session's first change when the history does not end with it: a note's baseline (see BASELINE), or typing a version missed (a crash). */
  const keepBaseline = (
    id: string,
    before: { ydoc: Uint8Array; text: string; at: number },
    rev?: Live['rev'],
  ) => {
    enqueue(async () => {
      const latest = (await storage.listRevisions(id)).find((r) => r.kind === 'body')
      let same = latest === undefined && before.text === ''
      if (latest && latest.length === textLength(before.text)) {
        const stored = await storage.getRevision(latest.id)
        same = stored?.ydoc != null && textOf(stored.ydoc) === before.text
      }
      if (!same) {
        await storage.putRevision({
          id: newId(),
          noteId: id,
          kind: 'body',
          at: before.at,
          ydoc: before.ydoc,
          length: textLength(before.text),
          value: latest === undefined ? BASELINE : null,
        })
      }
      // A version taken meanwhile is newer.
      if (rev) rev.lastText ??= before.text
    })
  }

  /** Body as stored before this session's first change; undefined once kept. */
  const unchecked = (note: Live) =>
    note.rev.checked
      ? undefined
      : {
          ydoc: Y.encodeStateAsUpdate(note.doc),
          text: note.doc.getText(BODY).toString(),
          at: note.saved.updatedAt,
        }

  /** The first change this session keeps the text it replaces (see keepBaseline). */
  const editBody = (note: Live, change: () => void): boolean => {
    const before = unchecked(note)
    let changed = false
    const seen = () => (changed = true)
    note.doc.on('update', seen)
    try {
      change()
    } finally {
      note.doc.off('update', seen)
    }
    if (!changed) return false
    note.edits += 1
    if (before) {
      note.rev.checked = true
      keepBaseline(note.record.id, before, note.rev)
    }
    if (!note.rev.pending) {
      note.rev.pending = true
      note.rev.every = setTimeout(() => takeVersion(note), REVISION_EVERY_MS)
    }
    clearTimeout(note.rev.pause)
    note.rev.pause = setTimeout(() => takeVersion(note), REVISION_PAUSE_MS)
    return true
  }

  const recordEvents = (rev: Live['rev'] | undefined, before: NoteRecord, after: NoteRecord) => {
    const at = now()
    for (const kind of EVENT_KINDS) {
      const value = eventValue(kind, after)
      if (eventValue(kind, before) === value) continue
      let id = newId()
      const noteId = after.id
      if (kind === 'title' && rev) {
        // Typing a title saves every few keys: one event per burst, and
        // none when the burst ends where it started.
        const last = rev.title
        const burst = last && at - last.at < REVISION_PAUSE_MS ? last : undefined
        const from = burst?.from ?? before.title
        if (burst) id = burst.id
        rev.title = { id, at, from }
        if (value === from) {
          enqueue(() => storage.deleteRevisions(noteId, [id]))
          continue
        }
      }
      enqueue(() => storage.putRevision({ id, noteId, kind, at, ydoc: null, length: null, value }))
    }
  }

  const dirty = (note: Live) =>
    note.edits !== note.savedEdits || META_HLCS.some((key) => note.record[key] !== note.saved[key])

  /** Serialises writes of a note so they never overlap and land in order. */
  // Serialises the note's writes: they never overlap and land in the order asked for.
  const exclusive = <T>(note: Live, work: () => Promise<T>): Promise<T> => {
    note.writes += 1
    const run = note.queue.then(work)
    note.queue = run.then(
      () => undefined,
      () => undefined,
    )
    void note.queue.then(() => {
      note.writes -= 1
      trim()
    })
    return run
  }

  const settle = (note: Live) => {
    note.failures = 0
    clearTimeout(note.retry)
    note.retry = undefined
    if (failing.delete(note.record.id)) report()
  }

  // The changes stay pending: retried after a delay that doubles with each failure in a row, and reported.
  const failed = (note: Live, error: unknown) => {
    const { id } = note.record
    // A note let go meanwhile is not tried again.
    if (live.get(id) !== note) return
    note.failures += 1
    clearTimeout(note.retry)
    note.retry = setTimeout(
      () => {
        note.retry = undefined
        save(note).catch(() => {})
      },
      Math.min(retryDelayMs * 2 ** (note.failures - 1), MAX_RETRY_MS),
    )
    const code = codeOf(error)
    if (failing.get(id) === code) return
    failing.set(id, code)
    report()
  }

  /** Retries up to WRITE_TRIES times after taking in the stored copy when another process wrote first. Returns undefined when the note was deleted for good meanwhile (it is let go). Runs only through exclusive. */
  const put = (note: Live, make: () => NoteRecord): Promise<NoteRecord | undefined> =>
    untilWritten(async (retry) => {
      if (retry) {
        const stored = await getStored(note.record.id, { trashed: true })
        if (!stored) {
          drop(note)
          return undefined
        }
        const title = note.record.title
        takeIn(note, stored)
        if (note.record.title !== title) note.retitled = true
      }
      const record = make()
      await storage.putNote(record)
      return record
    })

  const write = async (note: Live) => {
    if (!dirty(note) || live.get(note.record.id) !== note) return
    // A title, notebook, status or pin change before any body edit moves
    // `updatedAt`: keep the body as a version first, dated by its own save.
    const body = unchecked(note)
    if (body) {
      note.rev.checked = true
      keepBaseline(note.record.id, body, note.rev)
    }
    let edits = note.edits
    const record = await put(note, () => {
      edits = note.edits
      const datesSet = (note.record.datesHlc ?? '') > (note.saved.datesHlc ?? '')
      note.record = {
        ...note.record,
        bodyMd: note.doc.getText(BODY).toString(),
        ydoc: Y.encodeStateAsUpdate(note.doc),
        updatedAt: datesSet ? note.record.updatedAt : Math.max(now(), note.record.createdAt),
      }
      return note.record
    })
    if (!record) return
    relay({ kind: 'saved', noteId: record.id, updatedAt: record.updatedAt })
    const written = asWritten(record)
    note.record = { ...note.record, bodyVersion: written.bodyVersion }
    const before = note.saved
    note.saved = written
    note.savedEdits = edits
    settle(note)
    recordEvents(note.rev, before, written)
    sweep()
  }

  const save = (note: Live): Promise<void> => {
    clearTimeout(note.timer)
    note.timer = undefined
    return exclusive(note, async () => {
      try {
        await write(note)
      } catch (error) {
        failed(note, error)
        throw error
      }
    })
  }

  const saveAll = () => Promise.allSettled([...live.values()].map(save))

  const schedule = (note: Live) => {
    clearTimeout(note.timer)
    note.timer = setTimeout(() => {
      note.timer = undefined
      save(note).catch(() => {})
    }, saveDelayMs)
  }

  const drop = (note: Live) => {
    clearTimeout(note.timer)
    note.timer = undefined
    stopTimers(note)
    if (live.get(note.record.id) === note) live.delete(note.record.id)
    settle(note)
  }

  /** Pending edits included: a note in memory is read from its document, the rest in batched storage reads. */
  const bodies = async (ids: readonly string[]): Promise<NoteBody[]> => {
    const found: NoteBody[] = []
    const stored: string[] = []
    for (const id of new Set(ids)) {
      const note = live.get(id)
      if (note)
        found.push({ id, title: note.record.title, bodyMd: note.doc.getText(BODY).toString() })
      else stored.push(id)
    }
    const batches: Promise<NoteBody[]>[] = []
    for (let i = 0; i < stored.length; i += MAX_BODY_IDS) {
      batches.push(storage.getBodies(stored.slice(i, i + MAX_BODY_IDS)))
    }
    for (const batch of await Promise.all(batches)) found.push(...batch)
    return found
  }

  const getStored = async (id: string, which?: { trashed: boolean }) => {
    const record = await storage.getNote(id, which)
    if (record) receiveStored(clock, stampsOf(record))
    return record
  }

  /** Calls that ask for a note while it is being read share that read: one note in memory, never two. */
  const load = (id: string): Promise<Live> => {
    const cached = live.get(id)
    if (cached) {
      live.delete(id)
      live.set(id, cached)
      cached.users += 1
      return Promise.resolve(cached)
    }
    let reading = loading.get(id)
    if (!reading) {
      const pending = { note: Promise.resolve() as unknown as Promise<Live>, users: 0 }
      pending.note = (async () => {
        try {
          await coldWrites.get(id)
          const stored = await getStored(id)
          if (!stored) throw new Error('E_NOTE_NOT_FOUND')
          // A title stored past the limit (by an older build) is cut here, so
          // the note's writes are taken. The stored one stays until a rename:
          // a write with the same HLC never replaces it.
          const title = clipTitle(stored.title)
          const record = title === stored.title ? stored : { ...stored, title }
          const doc = new Y.Doc()
          Y.applyUpdate(doc, record.ydoc)
          const note = liveNote(record, doc, false)
          note.users = pending.users
          live.set(id, note)
          if (options.relay) relay({ kind: 'want', noteId: id, data: Y.encodeStateVector(doc) })
          return note
        } finally {
          loading.delete(id)
        }
      })()
      loading.set(id, pending)
      reading = pending
    }
    reading.users += 1
    return reading.note
  }

  const using = async <T>(id: string, work: (note: Live) => T | Promise<T>): Promise<T> => {
    const note = await load(id)
    try {
      return await work(note)
    } finally {
      note.users -= 1
      trim()
    }
  }

  // Nothing of the note would be lost if it left memory: no user, no editor hold, no write pending or failed, title not being typed.
  const idle = (note: Live) =>
    note.users === 0 &&
    note.writes === 0 &&
    note.timer === undefined &&
    note.retry === undefined &&
    !dirty(note) &&
    !holds.has(note.record.id) &&
    !failing.has(note.record.id) &&
    !(note.rev.title && now() - note.rev.title.at < REVISION_PAUSE_MS)

  // Lets the least recently used idle notes go beyond NOTES_IN_MEMORY; unversioned typing becomes a version first.
  const trim = () => {
    let over = live.size - NOTES_IN_MEMORY
    for (const note of live.values()) {
      if (over <= 0) return
      if (!idle(note)) continue
      takeVersion(note)
      drop(note)
      over -= 1
    }
  }

  const retitle = (note: Live, title: string) => {
    note.record = { ...note.record, title: clipTitle(title), titleHlc: clock.tick() }
    schedule(note)
    const { id, title: clipped, titleHlc } = note.record
    relay({ kind: 'title', noteId: id, title: clipped, hlc: titleHlc })
  }

  /** A note in memory, or one being read in once it is; undefined when neither. */
  const inMemory = async (id: string) => {
    const note = live.get(id) ?? (await loading.get(id)?.note.catch(() => undefined))
    return note && live.get(id) === note ? note : undefined
  }

  /** Applies a change this core did not make and tells the window what it changed; whether it changed anything. */
  const takeOutside = (note: Live, update: Uint8Array, origin?: typeof RELAYED): boolean => {
    const taken: Uint8Array[] = []
    const collect = (change: Uint8Array) => taken.push(change)
    note.doc.on('update', collect)
    try {
      Y.applyUpdate(note.doc, update, origin)
    } finally {
      note.doc.off('update', collect)
    }
    if (taken.length === 0) return false
    const noteId = note.record.id
    tell({ kind: 'update', noteId, update: taken.length === 1 ? taken[0]! : Y.mergeUpdates(taken) })
    return true
  }

  /** Merges the stored copy in: a Yjs merge, and the newer HLC of each metadata field. */
  const takeIn = (note: Live, stored: NoteRecord) => {
    const title = note.record.title
    note.record = { ...withNewer(note.record, stored), bodyVersion: stored.bodyVersion }
    note.saved = { ...withNewer(note.saved, stored), bodyVersion: stored.bodyVersion }
    takeOutside(note, stored.ydoc)
    if (note.record.title !== title) {
      tell({ kind: 'title', noteId: note.record.id, title: note.record.title })
    }
  }

  const replaceBody = (note: Live, markdown: string) => {
    const text = note.doc.getText(BODY)
    const edits = textEdits(text.toString(), markdown)
    if (edits.length === 0) return
    editBody(note, () =>
      note.doc.transact(() => {
        // From the end, so the offsets still ahead stay right.
        for (const edit of edits.reverse()) {
          if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start)
          if (edit.text) text.insert(edit.start, edit.text)
        }
      }),
    )
    schedule(note)
  }

  const bodyVersion = async (id: string, revisionId: string) => {
    const revision = await storage.getRevision(revisionId)
    if (!revision || revision.noteId !== id || revision.kind !== 'body' || !revision.ydoc) {
      throw notFound()
    }
    return textOf(revision.ydoc)
  }

  const trashed = async (id: string): Promise<NoteRecord> => {
    const record = await getStored(id, { trashed: true })
    if (!record || record.deletedAt === null) throw new Error('E_NOTE_NOT_IN_TRASH')
    return record
  }

  /** Templates' row may be missing (another device deleted it in a Devot from before templates). */
  const isLiveBook = async (bookId: string) =>
    bookId === TEMPLATES_BOOK_ID || (await storage.listBooks()).some((b) => b.id === bookId)

  const requireBook = async (bookId: string | null) => {
    if (bookId !== null && !(await isLiveBook(bookId))) throw new Error('E_BOOK_NOT_FOUND')
  }

  const liveBook = async (bookId: string | null) =>
    bookId !== null && (await isLiveBook(bookId)) ? bookId : null

  /** writeMeta for a note not in memory: the stored record is rewritten with the field changed and its body as stored, so no Yjs document is built and the search index is left alone (schema v15). */
  // Writes of one note made this way go one at a time, and a load of it waits for them.
  const writeStored = (id: string, change: MetaChange): Promise<void> => {
    const run = (coldWrites.get(id) ?? Promise.resolve()).then(() =>
      untilWritten(async () => {
        const stored = await getStored(id)
        if (!stored) throw new Error('E_NOTE_NOT_FOUND')
        const title = clipTitle(stored.title)
        const before = title === stored.title ? stored : { ...stored, title }
        const at = clock.tick()
        const record: NoteRecord = {
          ...before,
          ...('bookId' in change ? { bookId: change.bookId, bookHlc: at } : {}),
          ...('status' in change ? { status: change.status, statusHlc: at } : {}),
          ...('pinned' in change ? { pinned: change.pinned, pinnedHlc: at } : {}),
          updatedAt: Math.max(now(), before.createdAt),
        }
        keepBaseline(id, { ydoc: stored.ydoc, text: stored.bodyMd, at: stored.updatedAt })
        await storage.putNote(record)
        recordEvents(undefined, before, record)
        sweep()
      }),
    )
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    coldWrites.set(id, settled)
    void settled.then(() => {
      if (coldWrites.get(id) === settled) coldWrites.delete(id)
    })
    return run
  }

  /** Writes a new note holding `doc`, a body taken from another note, in one write so it is never stored empty. Attachments belong to one note: `doc` must already show `copies` (see newFileCopies), made in the same write; if that fails the new note is purged and the copy's error thrown. */
  const insertNote = async (
    title: string,
    bookId: string | null,
    doc: Y.Doc,
    copies: readonly FileCopy[],
    status: NoteStatus = 'none',
    id = newId(),
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
      pinned: false,
      pinnedHlc: '',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      deletedHlc: null,
    }
    await storage.putNote(record)
    relay({ kind: 'saved', noteId: id, updatedAt: at })
    live.set(id, liveNote(asWritten(record), doc, false))
    trim()
    if (copies.length === 0) return id
    try {
      await storage.copyFiles(id, copies)
    } catch (error) {
      live.delete(id)
      await storage
        .purgeNote(id, now(), clock.tick())
        .catch(() => console.warn('W_NOTE_COPY_CLEANUP_FAILED', id))
      throw error
    }
    return id
  }

  const service: NoteService = {
    list: async (limit) => {
      const notes = (await storage.listNotes()).filter((n) => n.bookId !== TEMPLATES_BOOK_ID)
      return limit === undefined ? notes : notes.slice(0, limit)
    },

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

    async seed(id, title, bookId, markdown) {
      const seeded = new Y.Doc()
      seeded.clientID = seedClient(id, markdown)
      seeded.getText(BODY).insert(0, lineFeeds(markdown))
      // Edits go on under a client of this device's own: two devices writing as the seed's client would give two changes one ID.
      const doc = new Y.Doc()
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded))
      await insertNote(title, await liveBook(bookId), doc, [], 'none', id)
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

    open: (id, known) =>
      using(id, (note) => ({
        id,
        title: note.record.title,
        state: Y.encodeStateAsUpdate(note.doc, known),
      })),

    title: (id) => using(id, (note) => note.record.title),

    hold(id) {
      holds.set(id, (holds.get(id) ?? 0) + 1)
    },

    unhold(id) {
      const left = (holds.get(id) ?? 0) - 1
      if (left > 0) holds.set(id, left)
      else holds.delete(id)
      trim()
    },

    async read(id) {
      const note = live.get(id)
      const record = note?.record ?? (await getStored(id))
      if (!record) throw new Error('E_NOTE_NOT_FOUND')
      const bodyMd = note ? note.doc.getText(BODY).toString() : record.bodyMd
      return { id, title: record.title, bodyMd, bookId: record.bookId }
    },

    async headlines(ids) {
      const found: Record<string, string> = {}
      for (const note of await bodies(ids)) found[note.id] = headline(note.bodyMd)
      return found
    },

    async excerpts(ids) {
      const found: Record<string, string> = {}
      for (const note of await bodies(ids)) found[note.id] = listExcerpt(note.bodyMd, note.title)
      return found
    },

    async rowDetails(ids) {
      const found: Record<string, RowDetail> = {}
      for (const note of await bodies(ids)) {
        const { done, total } = taskProgress(note.bodyMd)
        found[note.id] = {
          excerpt: listExcerpt(note.bodyMd, note.title),
          progress: total > 0 ? `${done}/${total}` : '',
        }
      }
      return found
    },

    applyUpdate: (id, update) =>
      using(id, (note) => {
        editBody(note, () => Y.applyUpdate(note.doc, update))
        schedule(note)
      }),

    setBody: (id, markdown) => using(id, (note) => replaceBody(note, markdown)),

    fill: (id, { title, markdown }) =>
      using(id, (note) => {
        if (note.record.title === '' && title !== '') retitle(note, title)
        const text = note.doc.getText(BODY)
        const own = text.toString()
        if (own.trim() === '') return replaceBody(note, markdown)
        const breaks = /\n*$/.exec(own)?.[0].length ?? 0
        editBody(note, () =>
          text.insert(text.length, `${'\n'.repeat(Math.max(0, 2 - breaks))}${markdown}`),
        )
        schedule(note)
      }),

    insertAt: (id, anchor, markdown) =>
      using(id, (note) => {
        const text = note.doc.getText(BODY)
        const index = anchoredIndex(note.doc, text, anchor)
        if (!markdown) return
        editBody(note, () => text.insert(index, markdown))
        schedule(note)
      }),

    // Released notes (import, devot-mcp) take no version here: the saved
    // body is the latest text, and the next edit keeps it (keepBaseline).
    async release(id) {
      const note = live.get(id)
      if (!note) return
      stopTimers(note)
      try {
        await exclusive(note, () => write(note))
      } finally {
        // Let go even when the write failed: the caller undoes or reports
        // the note, and a later retry must not write it after all.
        drop(note)
      }
      await revisionWork
    },

    setTitle: (id, title) => using(id, (note) => retitle(note, title)),

    async setBook(id, bookId) {
      await requireBook(bookId)
      await using(id, (note) => {
        note.record = { ...note.record, bookId, bookHlc: clock.tick() }
        schedule(note)
      })
    },

    async setStatus(id, status) {
      if (!NOTE_STATUSES.includes(status)) throw new Error('E_NOTE_STATUS_INVALID')
      await using(id, (note) => {
        note.record = { ...note.record, status, statusHlc: clock.tick() }
        schedule(note)
      })
    },

    async setDates(id, dates) {
      const valid = (at: number | undefined) =>
        at === undefined || (Number.isSafeInteger(at) && at >= 0)
      if (!valid(dates.createdAt) || !valid(dates.updatedAt)) {
        throw new Error('E_NOTE_TIME_INVALID')
      }
      await using(id, async (note) => {
        const createdAt = dates.createdAt ?? note.record.createdAt
        const updatedAt = dates.updatedAt ?? note.record.updatedAt
        if (updatedAt < createdAt) throw new Error('E_NOTE_TIME_INVALID')
        note.record = { ...note.record, createdAt, updatedAt, datesHlc: clock.tick() }
        await save(note)
      })
    },

    setPinned: (id, pinned) =>
      using(id, (note) => {
        note.record = { ...note.record, pinned, pinnedHlc: clock.tick() }
        schedule(note)
      }),

    async writeMeta(id, change, options) {
      if ('bookId' in change && !options?.bookChecked) await requireBook(change.bookId)
      if ('status' in change && !NOTE_STATUSES.includes(change.status)) {
        throw new Error('E_NOTE_STATUS_INVALID')
      }
      if (!live.has(id) && !loading.has(id)) return writeStored(id, change)
      await using(id, async (note) => {
        const before = note.record
        const at = clock.tick()
        const field: MetaField =
          'bookId' in change ? 'book' : 'status' in change ? 'status' : 'pinned'
        note.record = {
          ...note.record,
          ...('bookId' in change ? { bookId: change.bookId, bookHlc: at } : {}),
          ...('status' in change ? { status: change.status, statusHlc: at } : {}),
          ...('pinned' in change ? { pinned: change.pinned, pinnedHlc: at } : {}),
        }
        try {
          await exclusive(note, () => write(note))
        } catch (error) {
          // Not written: the field goes back, unless it changed again since.
          if (hlcOf(note.record, field) === at) note.record = withField(note.record, before, field)
          // The note's other changes stay pending, and are tried again.
          if (dirty(note)) failed(note, error)
          else settle(note)
          throw error
        }
      })
    },

    checkBook: (bookId) => requireBook(bookId),

    async flush(quitting) {
      const notes = [...live.values()]
      const saved = await Promise.allSettled(notes.map(save))
      if (quitting?.versions) for (const note of live.values()) takeVersion(note)
      await revisionWork
      const unsaved = notes.filter((_, i) => saved[i]?.status === 'rejected')
      if (unsaved.length > 0) {
        throw new Error(`E_NOTE_SAVE_FAILED ${unsaved.map((n) => n.record.id).join(' ')}`)
      }
    },

    async holdCompaction() {
      held = true
      await sweeping
    },

    resumeCompaction() {
      held = false
    },

    async search(query, scope, lookup) {
      const clauses = parseSearch(query)
      if (clauses.length === 0) return []
      if (lookup?.flush !== false) await saveAll()
      const needs = (...fields: SearchClause['field'][]) =>
        clauses.some((c) => fields.includes(c.field))
      const [books, tags] = await Promise.all([
        scope?.bookId || needs('book', 'bookId') ? storage.listBooks() : [],
        needs('tag', 'tagId') ? storage.listTags() : [],
      ])
      // `book:` and `bookId:` never name Templates.
      const nameable = books.filter((b) => b.id !== TEMPLATES_BOOK_ID)
      const resolved = resolveSearch(clauses, { books, tags, scope, nameable })
      if (!resolved) return []
      const found = await storage.searchNotes(excludeTemplates(resolved), SEARCH_LIMIT)
      return found.map(({ excerpt, ...note }) => {
        const tidy = excerpt ? tidyExcerpt(excerpt) : ''
        return tidy ? { ...note, excerpt: tidy } : note
      })
    },

    async trash(id) {
      await using(id, async (note) => {
        clearTimeout(note.timer)
        note.timer = undefined
        await exclusive(note, async () => {
          try {
            await write(note)
          } catch (error) {
            failed(note, error)
            throw error
          }
          if (live.get(id) !== note) return
          takeVersion(note)
          // Written apart: when it fails, the note stays as it was. With the
          // body as the document holds it, which may have taken in what
          // another process wrote since the last write (see mergeStored).
          await put(note, () => ({
            ...note.record,
            bodyMd: note.doc.getText(BODY).toString(),
            ydoc: Y.encodeStateAsUpdate(note.doc),
            deletedAt: now(),
            deletedHlc: clock.tick(),
          }))
          drop(note)
        })
      })
      await revisionWork
    },

    restore: (id) =>
      untilWritten(async () => {
        const record = await trashed(id)
        // A title stored past what storage takes now (by an older build) is
        // cut for the write, as when a note is loaded; the stored one stays.
        await storage.putNote({
          ...record,
          title: clipTitle(record.title),
          deletedAt: null,
          deletedHlc: clock.tick(),
        })
      }),

    listTrash: () => storage.listTrash(),

    async peekTrashed(id) {
      const record = await trashed(id)
      const { title, bodyMd, createdAt, updatedAt } = record
      return { id, title, bodyMd, createdAt, updatedAt }
    },

    backlinks: (id) => findBacklinks(storage, id),

    async linkTargets(ids) {
      const want = new Set(ids.slice(0, MAX_LINK_TARGETS))
      if (want.size === 0) return {}
      const [list, tags] = await Promise.all([storage.listNotes(), storage.listTags()])
      const tagById = new Map(tags.filter((t) => t.deletedAt === null).map((t) => [t.id, t]))
      const found: Record<string, NoteLinkTarget> = {}
      await Promise.all(
        list
          .filter((summary) => want.has(summary.id))
          .map(async (summary) => {
            const note = live.get(summary.id)
            const bodyMd = note
              ? note.doc.getText(BODY).toString()
              : ((await storage.getNote(summary.id))?.bodyMd ?? '')
            const title = note ? note.record.title : summary.title
            found[summary.id] = {
              title: title || headline(bodyMd),
              status: note ? note.record.status : summary.status,
              tasks: taskProgress(bodyMd),
              tags: summary.tagIds
                .flatMap((tagId) => {
                  const tag = tagById.get(tagId)
                  return tag ? [{ name: tag.name, color: tag.color }] : []
                })
                .sort((a, b) => a.name.localeCompare(b.name)),
            }
          }),
      )
      return found
    },

    async purge(id) {
      await trashed(id)
      // Storage keeps the attachments other notes show: a link pasted a
      // moment ago, its save still waiting, counts too.
      await Promise.all([...live.values()].map(save))
      await storage.purgeNote(id, now(), clock.tick())
      const note = live.get(id)
      if (note) drop(note)
    },

    async emptyTrash() {
      await Promise.all([...live.values()].map(save))
      const all = await storage.listTrash()
      for (const note of all) await storage.purgeNote(note.id, now(), clock.tick())
      return all.length
    },

    async history(id) {
      await saveAll()
      await revisionWork
      return historyEntries(await storage.listRevisions(id))
    },

    compareRevision: (id, revisionId) =>
      using(id, async (note) => {
        const old = await bodyVersion(id, revisionId)
        return foldUnchanged(lineDiff(old, note.doc.getText(BODY).toString()))
      }),

    restoreRevision: (id, revisionId) =>
      using(id, async (note) => {
        const old = await bodyVersion(id, revisionId)
        takeVersion(note)
        const updates: Uint8Array[] = []
        const collect = (update: Uint8Array) => updates.push(update)
        note.doc.on('update', collect)
        try {
          replaceBody(note, old)
        } finally {
          note.doc.off('update', collect)
        }
        await revisionWork
        return Y.mergeUpdates(updates)
      }),

    applyAiEdit: (id, { from, original, replacement }) =>
      using(id, async (note) => {
        const body = note.doc.getText(BODY).toString()
        const moved = body.indexOf(original)
        const at = body.startsWith(original, from) ? from : moved
        if (at !== from && (moved < 0 || body.includes(original, moved + 1))) {
          throw new Error('E_AI_PROPOSAL_STALE')
        }
        takeVersion(note)
        const updates: Uint8Array[] = []
        const collect = (update: Uint8Array) => updates.push(update)
        note.doc.on('update', collect)
        try {
          const next = lineFeeds(replacement)
          replaceBody(note, body.slice(0, at) + next + body.slice(at + original.length))
        } finally {
          note.doc.off('update', collect)
        }
        takeVersion(note, AI_EDIT)
        await revisionWork
        return Y.mergeUpdates(updates)
      }),

    async activity(day, offsetAt) {
      await saveAll()
      for (const note of live.values()) takeVersion(note)
      await revisionWork
      return loadActivity(storage, day, offsetAt)
    },

    async mergeStored() {
      const retitled: { id: string; title: string }[] = []
      // After any write of the note under way, so none lands in between.
      const merge = (note: Live) =>
        exclusive(note, async () => {
          const { id } = note.record
          if (live.get(id) !== note) return
          const stored = await getStored(id, { trashed: true })
          if (live.get(id) !== note) return
          if (!stored) {
            drop(note)
            return
          }
          const title = note.record.title
          takeIn(note, stored)
          if (holdsMore(note.doc, stored)) {
            note.edits += 1
            schedule(note)
          }
          if (note.record.title !== title || note.retitled) {
            retitled.push({ id, title: note.record.title })
          }
          note.retitled = false
        })
      const merged = await Promise.allSettled([...live.values()].map(merge))
      for (const result of merged) {
        if (result.status === 'rejected') {
          console.warn('W_NOTE_MERGE_FAILED', errorCode(result.reason))
        }
      }
      return retitled
    },

    async receive(message) {
      if (message.kind === 'saved') return
      const { noteId: id } = message
      const note = await inMemory(id)
      if (!note) return
      try {
        if (message.kind === 'want') {
          relay({ kind: 'update', noteId: id, data: Y.encodeStateAsUpdate(note.doc, message.data) })
        } else if (message.kind === 'update') {
          // The window that made the change keeps the text from before it (see keepBaseline).
          if (takeOutside(note, message.data, RELAYED)) note.rev.checked = true
        } else if (formatHlc(parseHlc(message.hlc)) > note.record.titleHlc) {
          receiveStored(clock, [message.hlc])
          const title = clipTitle(message.title)
          const titled = { title, titleHlc: message.hlc }
          note.record = { ...note.record, ...titled }
          note.saved = { ...note.saved, ...titled }
          tell({ kind: 'title', noteId: id, title })
        }
      } catch {
        console.warn('W_NOTE_RELAY_INVALID', id)
      }
    },
  }
  return service
}
