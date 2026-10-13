// Note service: owns each open note's Yjs document, derives the Markdown
// snapshot from it and persists whole records through the storage adapter.
//
// Editors keep their own Yjs replica and exchange updates with this service;
// the body is never written as plain text.
//
// Writes of one note go one at a time, in order, each with the note as it is
// when the write starts, so an older snapshot never lands after a newer one,
// and a flush waits for a write under way. A note whose write fails keeps
// its changes in memory: it is tried again later (sooner when anything saves
// it) and reported (onSaveProblems) until a write holds them.
//
// Every write compares before it overwrites: it is based on the version of
// the stored body the service last saw (NoteRecord.bodyVersion), and storage
// refuses it when another process wrote the note since. The note then takes
// the stored copy in (a Yjs merge, the newer HLC of each metadata field) and
// is written again, so neither side's change is lost (see put).
//
// Only the most recently used notes stay in memory once nothing uses them
// (NOTES_IN_MEMORY): a note leaves when nothing of it can be lost (see
// trim), and is read from storage again when it is next used.
//
// The service also keeps each note's revision history (see revisions.ts):
// it takes a version of the body once editing pauses or after ten minutes of
// continuous editing, records metadata changes as events, and compacts old
// versions of every note after saves, on a queue of its own that no user
// action waits for (see sweep). Restoring a version is an ordinary edit of
// the Yjs document.

import * as Y from 'yjs'
import { loadActivity, type ActivityHeatmap, type OffsetAt } from './activity'
import { TEMPLATES_BOOK_ID } from './books'
import { foldUnchanged, lineDiff, type DiffBlock } from './diff'
import { errorCode } from './errors'
import { headline } from './extract'
import { receiveStored, type Clock } from './hlc'
import {
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
  NOTE_STATUSES,
  type CompactableVersion,
  type NoteRecord,
  type NoteStatus,
  type NoteSummary,
  type RevisionKind,
  type StorageAdapter,
  type TrashedNote,
} from './storage'
import { extractTitle } from './extract'
import { fileLinkSpans, newFileCopies, replaceFileLinks, type FileCopy } from './files'
import { clipTitle } from './noteLimits'
import { lineFeeds, textDiff } from './text'

/** The Y.Text that holds a note's Markdown. */
export const BODY = 'body'

/**
 * How many notes stay in memory once nothing uses them: the most recently
 * used ones. Opening another lets the least recently used go, once nothing
 * of it can be lost (see trim). Notes an editor holds, and notes with work
 * under way, stay besides.
 */
export const NOTES_IN_MEMORY = 8

/** A metadata change `writeMeta` writes at once. */
export type MetaChange = { bookId: string | null } | { status: NoteStatus } | { pinned: boolean }

export interface OpenedNote {
  id: string
  title: string
  /**
   * Yjs state to apply to the editor's replica: the full state, or what a
   * replica with the state vector given to `open` lacks.
   */
  state: Uint8Array
}

/** A note whose changes could not be saved yet, with the error code of the last try. */
export interface SaveProblem {
  id: string
  code: string
}

export interface NoteServiceOptions {
  storage: StorageAdapter
  clock: Clock
  newId: () => string
  now?: () => number
  /** Delay between the last edit and the save. */
  saveDelayMs?: number
  /**
   * Delay before a failed save is tried again; it doubles with each failure
   * in a row, up to 30 s.
   */
  retryDelayMs?: number
  /**
   * Called with every note whose changes could not be saved (they stay in
   * memory and are tried again), oldest failure first, each time that list
   * changes: a note fails, fails with another code, or saves.
   */
  onSaveProblems?: (problems: SaveProblem[]) => void
  /**
   * Whether saves start compaction sweeps (see sweep); on by default.
   * devot-mcp turns it off: its writes run in a transaction that holds the
   * database's write lock, its process need not share the app's time zone,
   * and it may not see the notes it would thin.
   */
  compact?: boolean
}

export interface NoteService {
  /**
   * Live notes, templates left out (see templates.ts); with `limit`, only
   * the first that many.
   */
  list(limit?: number): Promise<NoteSummary[]>
  /**
   * A new note, in `bookId` when given (it must be a live notebook). The
   * title goes in as setTitle takes one.
   */
  create(title?: string, bookId?: string | null): Promise<string>
  /**
   * A note's title and Yjs state; with `known` (a replica's state vector),
   * only what that replica lacks.
   */
  open(id: string, known?: Uint8Array): Promise<OpenedNote>
  /**
   * A live note's title (pending edits included), loading the note for an
   * editor to open next. Throws E_NOTE_NOT_FOUND.
   */
  title(id: string): Promise<string>
  /**
   * An editor shows the note: it stays in memory until as many `unhold`
   * calls, however many other notes are used meanwhile, so the editor's
   * replica and this service never part.
   */
  hold(id: string): void
  /** An editor no longer shows the note (see hold). */
  unhold(id: string): void
  /**
   * A live note's title, Markdown (pending edits included) and notebook,
   * without keeping it in memory. Throws E_NOTE_NOT_FOUND.
   */
  read(id: string): Promise<{ id: string; title: string; bodyMd: string; bookId: string | null }>
  /**
   * What the lists call each of these notes while it has no title: the first
   * line of its body (see `headline`), pending edits included, for notes in
   * the Trash too. A note that does not exist is left out; one with no text
   * is empty. Notes are read without being kept in memory.
   */
  headlines(ids: readonly string[]): Promise<Record<string, string>>
  /**
   * A new note with the title, body, notebook and status of `id` (pending
   * edits included; a deleted notebook counts as none); it is never pinned.
   * With `suffix`, a titled note's copy is titled "<title> <suffix>" (cut to
   * the title limit); an untitled note's copy stays untitled. The body is the
   * source's Yjs state, never re-typed text. Images it shows become the
   * copy's own (see extract). Tags are the caller's (see duplicateNote).
   */
  duplicate(id: string, options?: { suffix?: string }): Promise<string>
  /**
   * A new note holding `markdown` (text selected in the note `sourceId`),
   * titled after its first line (`extractTitle`), in the source's notebook
   * (none when that was deleted). The body goes in as Yjs operations, and
   * the note is stored with it in one write. Images the text shows become
   * the note's own copies (their links take the copies' IDs, a size preset
   * stays), so purging the source keeps them; when they cannot be copied,
   * no note is left and the copy's error is thrown. Resolves to its ID and
   * title.
   */
  extract(sourceId: string, markdown: string): Promise<{ id: string; title: string }>
  /** Applies an editor update to the note and schedules a save. */
  applyUpdate(id: string, update: Uint8Array): Promise<void>
  /**
   * Inserts `markdown` into the body at `anchor`, a Yjs relative position
   * (`Y.encodeRelativePosition`, made by a replica of the note) that has
   * followed every edit since, so text that landed meanwhile stays where
   * the position was; at the end of the body when it is null or does not
   * name this body. As one Yjs update, then schedules a save. For an editor
   * that closed before its image was stored; throws E_NOTE_NOT_FOUND.
   */
  insertAt(id: string, anchor: Uint8Array | null, markdown: string): Promise<void>
  /**
   * Makes the body `markdown` by applying the text difference as Yjs
   * operations (never by writing the snapshot), then schedules a save.
   */
  setBody(id: string, markdown: string): Promise<void>
  /**
   * Saves a note's pending changes and drops it from memory until it is
   * opened again. When the save fails, the note is dropped all the same and
   * the error is thrown: the caller (an import, devot-mcp) undoes or reports
   * the note.
   */
  release(id: string): Promise<void>
  /**
   * Changes a note's title: each line break becomes a space and it is cut
   * to MAX_TITLE_CHARS (see clipTitle), so storage always takes it.
   */
  setTitle(id: string, title: string): Promise<void>
  /** Moves a note to a notebook, or to none (null). */
  setBook(id: string, bookId: string | null): Promise<void>
  setStatus(id: string, status: NoteStatus): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<void>
  /**
   * Changes a note's notebook, status or pin and writes it now (a batch
   * change writes each note before the next), with a new HLC for the
   * field. When the write fails it rejects and the field goes back to its
   * old value (unless it changed again meanwhile), so a later save does not
   * write the change after all; the note's other changes stay pending. A
   * note that is not in memory is not loaded: its stored record is written
   * back with the field changed, its body as stored (no Yjs document is
   * built, and the search index is left alone). With `bookChecked`, the
   * caller has checked the notebook (see checkBook): a batch checks it once
   * for all its notes.
   */
  writeMeta(id: string, change: MetaChange, options?: { bookChecked?: boolean }): Promise<void>
  /**
   * Throws E_BOOK_NOT_FOUND unless notes can go in `bookId`: a live
   * notebook or Templates; null (no notebook) always can.
   */
  checkBook(bookId: string | null): Promise<void>
  /**
   * Saves every note with pending changes now, after any write of it under
   * way. With `versions` (quitting), typing not kept as a version yet also
   * becomes one, so it is kept and counted on the day it was typed. A note
   * that cannot be saved keeps its changes (they are tried again later);
   * once the rest are saved, flush rejects with `E_NOTE_SAVE_FAILED` and
   * the IDs of those notes.
   */
  flush(options?: { versions?: boolean }): Promise<void>
  /**
   * Stops compaction sweeps from starting and resolves once the running
   * one, if any, has finished: before the database is replaced (a backup
   * restore), so no sweep deletes from it what it chose from the old data.
   */
  holdCompaction(): Promise<void>
  /** Lets compaction sweeps start again after holdCompaction. */
  resumeCompaction(): void
  /**
   * Live notes matching a search query (see search.ts), best matches first;
   * with `scope`, only those in that view (a notebook, a filter). Templates
   * are never found. Pending edits are saved first (a note that cannot be
   * saved is found as stored), unless `flush` is false: a lookup that runs
   * on every key (the `[[` popup) finds notes as stored and writes nothing.
   */
  search(query: string, scope?: SearchScope, options?: { flush?: boolean }): Promise<NoteSummary[]>
  /**
   * Moves a note to the trash (its pending edits are saved first). When a
   * write fails it rejects and the note stays where it was.
   */
  trash(id: string): Promise<void>
  /** Brings a note back from the trash with its metadata intact. */
  restore(id: string): Promise<void>
  listTrash(): Promise<TrashedNote[]>
  /** A trashed note's title and Markdown, for a read-only view. */
  peekTrashed(id: string): Promise<{ id: string; title: string; bodyMd: string }>
  /**
   * Deletes one trashed note permanently, with the attachments no other
   * note shows (see StorageAdapter.purgeNote). Pending edits are saved
   * first, so a link pasted a moment ago keeps its image.
   */
  purge(id: string): Promise<void>
  /** Deletes every trashed note permanently, as `purge` does; returns how many. */
  emptyTrash(): Promise<number>
  /** The note's versions and metadata events, newest first. */
  history(id: string): Promise<HistoryEntry[]>
  /**
   * How the note's text changed since a version: its lines, unchanged runs
   * folded. Throws E_REVISION_NOT_FOUND for anything but a body version of
   * this note.
   */
  compareRevision(id: string, revisionId: string): Promise<DiffBlock[]>
  /**
   * Makes the body the text of a version, as an edit (the text difference
   * applied as Yjs operations, never the version's state written back).
   * Unsaved edits are kept as a version first. Returns the Yjs update the
   * edit made, for the editor's replica to apply as one undoable step.
   */
  restoreRevision(id: string, revisionId: string): Promise<Uint8Array>
  /**
   * The activity heatmap ending on the local day of `now` (see activity.ts),
   * in the zone of `offsetAt` (the system's by default). Pending edits are
   * saved, and typing not kept as a version yet becomes one, so it counts.
   */
  activity(now: number, offsetAt?: OffsetAt): Promise<ActivityHeatmap>
  /**
   * Takes in what another process wrote (devot-mcp, or any writer on another
   * connection; the window hears of it as `devot://db-changed`), so the next
   * write of a note in memory keeps the other's changes instead of writing
   * its own copy over them. Every note in memory is read back: its Yjs
   * document takes the stored state in (Yjs merges, so neither side's text
   * is lost) and each metadata field keeps the newer HLC, as storage does.
   * A note whose stored copy lacks something it has (edits of its own the
   * other wrote over) is saved again; a note deleted for good meanwhile is
   * let go. The others stay in memory: letting one go here could lose an
   * edit that has just loaded it. Returns the notes whose title the other
   * process changed, with that title, counting a title a write took in when
   * storage refused it before this merge. A note that cannot be read is left
   * as it was.
   */
  mergeStored(): Promise<{ id: string; title: string }[]>
}

/**
 * Where a relative position (see NoteService.insertAt) is in the body now;
 * the end of the body when there is none or it names another text.
 */
function anchoredIndex(doc: Y.Doc, text: Y.Text, anchor: Uint8Array | null): number {
  if (anchor) {
    try {
      const found = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(anchor),
        doc,
      )
      if (found?.type === text) return Math.min(found.index, text.length)
    } catch {
      // Not a position: the end.
    }
  }
  return text.length
}

type Timer = ReturnType<typeof setTimeout>

interface Live {
  record: NoteRecord
  /** The record as last written, to tell which metadata fields changed. */
  saved: NoteRecord
  doc: Y.Doc
  /** The save after the last change (see schedule). */
  timer: Timer | undefined
  /** Changes made to the body so far, and how many the last write held. */
  edits: number
  savedEdits: number
  /** The note's writes, one after another (see exclusive), and how many are asked for or under way. */
  queue: Promise<void>
  writes: number
  /** Service calls using the note now (see using): it stays in memory while any does. */
  users: number
  /**
   * Whether a write made again after storage refused it took in a title
   * another process gave the note: mergeStored reports it, as a title it
   * takes in itself.
   */
  retitled: boolean
  /** Saves failed in a row, and the timer that tries again. */
  failures: number
  retry: Timer | undefined
  /** Revision history state, for this session only. */
  rev: {
    /** Whether the history was checked for the text before the first edit. */
    checked: boolean
    /** The text of the newest version, once known. */
    lastText: string | undefined
    /** Edits not in a version yet; both timers run while there are some. */
    pending: boolean
    pause: Timer | undefined
    every: Timer | undefined
    /** The title event that quick title edits update instead of adding one. */
    title: { id: string; at: number; from: string } | undefined
  }
}

const notFound = () => new Error('E_REVISION_NOT_FOUND')
/** The longest wait before a failed save is tried again. */
const MAX_RETRY_MS = 30_000
/**
 * How many times one write of a note is made when storage refuses it because
 * another process wrote the note first, each after taking that write in.
 * When the other wins every time, the write fails like any other, keeping
 * the changes, and is tried again later (see failed).
 */
const WRITE_TRIES = 5

/** Whether storage refused a write because the stored body moved on from the one it is based on. */
const isStale = (error: unknown) => errorCode(error) === 'E_NOTE_BODY_STALE'

/** `record` as storage holds it once written: its body at the next version. */
const asWritten = (record: NoteRecord): NoteRecord => ({
  ...record,
  bodyVersion: record.bodyVersion + 1,
})

/**
 * Runs `attempt`, which reads a note and writes it, again (`retry` true)
 * while storage refuses the write because another process wrote the note
 * since the read: WRITE_TRIES times in all at most, then the refusal is
 * thrown like any other failure.
 */
const untilWritten = async <T>(attempt: (retry: boolean) => Promise<T>): Promise<T> => {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt(tries > 1)
    } catch (error) {
      if (!isStale(error) || tries >= WRITE_TRIES) throw error
    }
  }
}

/**
 * The HLC of each metadata field: a change to the field gives it a new one,
 * so a record whose HLCs differ from the saved one's has changes to write.
 */
const META_HLCS = ['titleHlc', 'bookHlc', 'statusHlc', 'pinnedHlc', 'deletedHlc'] as const

/** The HLCs of a note's metadata fields. */
const stampsOf = (record: NoteRecord) => META_HLCS.map((key) => record[key])

/** The metadata fields writeMeta changes. */
type MetaField = 'book' | 'status' | 'pinned'

/** The HLC of one metadata field. */
const hlcOf = (record: NoteRecord, field: MetaField) =>
  field === 'book' ? record.bookHlc : field === 'status' ? record.statusHlc : record.pinnedHlc

/** `record` with one metadata field, and its HLC, as in `from`. */
const withField = (record: NoteRecord, from: NoteRecord, field: MetaField): NoteRecord => {
  if (field === 'book') return { ...record, bookId: from.bookId, bookHlc: from.bookHlc }
  if (field === 'status') return { ...record, status: from.status, statusHlc: from.statusHlc }
  return { ...record, pinned: from.pinned, pinnedHlc: from.pinnedHlc }
}

/**
 * `to` with each metadata field of `from` (and its HLC) whose HLC is newer,
 * as storage merges a write, and the later update time. A title stored past
 * the limit is cut, as when a note is loaded.
 */
const withNewer = (to: NoteRecord, from: NoteRecord): NoteRecord => ({
  ...to,
  ...(from.titleHlc > to.titleHlc ? { title: clipTitle(from.title), titleHlc: from.titleHlc } : {}),
  ...(from.bookHlc > to.bookHlc ? { bookId: from.bookId, bookHlc: from.bookHlc } : {}),
  ...(from.statusHlc > to.statusHlc ? { status: from.status, statusHlc: from.statusHlc } : {}),
  ...(from.pinnedHlc > to.pinnedHlc ? { pinned: from.pinned, pinnedHlc: from.pinnedHlc } : {}),
  ...((from.deletedHlc ?? '') > (to.deletedHlc ?? '')
    ? { deletedAt: from.deletedAt, deletedHlc: from.deletedHlc }
    : {}),
  updatedAt: Math.max(to.updatedAt, from.updatedAt),
})

/**
 * Takes a note's stored copy into the note in memory: its Yjs document takes
 * the stored state in (Yjs merges, so neither side's text is lost), each
 * metadata field keeps the newer HLC, as storage does, and the next write is
 * based on the stored body's version.
 */
const takeIn = (note: Live, stored: NoteRecord) => {
  note.record = { ...withNewer(note.record, stored), bodyVersion: stored.bodyVersion }
  note.saved = { ...withNewer(note.saved, stored), bodyVersion: stored.bodyVersion }
  Y.applyUpdate(note.doc, stored.ydoc)
}

/**
 * Whether `doc`, which has taken the stored state in, holds something that
 * state lacks: other text than the stored Markdown, or edits of its own.
 */
const holdsMore = (doc: Y.Doc, stored: NoteRecord) => {
  if (doc.getText(BODY).toString() !== stored.bodyMd) return true
  const theirs = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(stored.ydoc))
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
    if (clock > (theirs.get(client) ?? 0)) return true
  }
  return false
}

/** A version a sweep weighs, as revisionsToDrop takes it. */
const asBody = (version: CompactableVersion) => ({ ...version, kind: 'body' as const })

/** A page of a sweep's listing, by note, in the order listed. */
const byNote = (versions: readonly CompactableVersion[]) => {
  const notes = new Map<string, CompactableVersion[]>()
  for (const version of versions) {
    const listed = notes.get(version.noteId)
    if (listed) listed.push(version)
    else notes.set(version.noteId, [version])
  }
  return notes
}

/** The code a failed write gives (anything without one gets a generic one). */
const codeOf = (error: unknown) => errorCode(error, 'E_STORAGE_WRITE_FAILED')

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}

/** The value a metadata event records for a field. */
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
  // Notes being read from storage (see load), with how many calls wait for
  // each; and how many editors hold each note, by ID (see hold).
  const loading = new Map<string, { note: Promise<Live>; users: number }>()
  const holds = new Map<string, number>()
  // Notes being written without being loaded (see writeStored), by ID: a
  // load of one waits for its writes.
  const coldWrites = new Map<string, Promise<void>>()
  // Notes whose changes could not be saved, by ID, with the code of the
  // last try, oldest failure first.
  const failing = new Map<string, string>()
  const report = () => {
    try {
      options.onSaveProblems?.(Array.from(failing, ([id, code]) => ({ id, code })))
    } catch {
      // A listener that throws must not make a write that went through
      // look like one that failed.
    }
  }
  // Whether saves start compaction sweeps, whether they are held (see
  // holdCompaction), when the last one of this session started, and the
  // sweeps, one after another: apart from the revision writes below, so no
  // user action waits for one.
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

  const liveNote = (record: NoteRecord, doc: Y.Doc, fresh: boolean): Live => ({
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
    // A note made this session has no earlier text to keep.
    rev: {
      checked: fresh,
      lastText: fresh ? '' : undefined,
      pending: false,
      pause: undefined,
      every: undefined,
      title: undefined,
    },
  })

  const stopTimers = (note: Live) => {
    clearTimeout(note.rev.pause)
    clearTimeout(note.rev.every)
    note.rev.pause = undefined
    note.rev.every = undefined
    note.rev.pending = false
  }

  /**
   * Thins the old versions of every note that may have some to drop, as of
   * `at` (see revisionsToDrop). It starts where the last sweep left off, by
   * the time storage recorded, in an earlier session too: only notes with a
   * version that turned a day or a week old since are weighed (see
   * compactionWindows); every one when none ran yet, or the clock was set
   * back past it. Storage lists their versions a page of notes at a time,
   * from indexes, and the dropped ones are deleted as the pages come, a
   * batch at a time; the last call records `at`, so an interrupted sweep is
   * done again.
   */
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
        // Deleted as the pages come, a batch at a time.
        while (drop.length >= COMPACT_BATCH) {
          await storage.compactRevisions(drop.splice(0, COMPACT_BATCH), null)
        }
      }
    }
    // The rest, and the sweep's time.
    await storage.compactRevisions(drop, at)
  }

  /**
   * Compacts the old versions of every note that may have some to drop,
   * whether it is edited again or not (see compactAll). Starts after a save,
   * at most once per COMPACT_EVERY_MS, on its own queue: switching notes,
   * the Trash, History, Activity and quitting never wait for it.
   */
  const sweep = () => {
    if (!compacting || held) return
    const at = now()
    if (sweptAt !== undefined && at - sweptAt < COMPACT_EVERY_MS) return
    sweptAt = at
    sweeping = sweeping
      .then(() => compactAll(at))
      .catch((e: unknown) => console.warn('W_REVISION_COMPACT_FAILED', errorCode(e)))
  }

  /** Takes a version of the body now, unless the newest one has this text. */
  const takeVersion = (note: Live) => {
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
        value: null,
      })
      note.rev.lastText = text
    })
  }

  /**
   * Keeps the text from before this session's first change as a version
   * when the history does not already end with it, dated when it was saved.
   * A note without history keeps it as its baseline (see BASELINE): text it
   * arrived with (an import, devot-mcp, a duplicate) or had from before
   * history existed. Otherwise it is typing a version missed (a crash).
   */
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

  /**
   * The body as stored, for keepBaseline, before this session's first
   * change to the note; undefined once that is done. `updatedAt` is the
   * time of the body's last save: a save that does not change the body
   * keeps the baseline first (see save).
   */
  const unchecked = (note: Live) =>
    note.rev.checked
      ? undefined
      : {
          ydoc: Y.encodeStateAsUpdate(note.doc),
          text: note.doc.getText(BODY).toString(),
          at: note.saved.updatedAt,
        }

  /**
   * Runs a change to the body: the first one this session keeps the text it
   * replaces (see keepBaseline); every one restarts the pause timer, and the
   * first since the last version starts the ten-minute one.
   */
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

  /**
   * Records the metadata fields that changed between two writes of a note;
   * `rev` is its history state in memory (none for a note written without
   * being loaded, whose title does not change).
   */
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

  /** Whether the note has changes its last write did not hold. */
  const dirty = (note: Live) =>
    note.edits !== note.savedEdits || META_HLCS.some((key) => note.record[key] !== note.saved[key])

  /**
   * Runs `work` once the note's earlier writes have settled, so writes of a
   * note never overlap and land in the order they were asked for.
   */
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

  /** Nothing failed is left to save for the note: no retry, no report. */
  const settle = (note: Live) => {
    note.failures = 0
    clearTimeout(note.retry)
    note.retry = undefined
    if (failing.delete(note.record.id)) report()
  }

  /**
   * A write of the note failed: its changes stay pending, it is tried
   * again later (each failure in a row waits twice as long) and reported.
   */
  const failed = (note: Live, error: unknown) => {
    const { id } = note.record
    // A note let go meanwhile is not tried again.
    if (live.get(id) !== note) return
    note.failures += 1
    clearTimeout(note.retry)
    note.retry = setTimeout(
      () => {
        note.retry = undefined
        // A failure is kept and reported here, and tried again.
        save(note).catch(() => {})
      },
      Math.min(retryDelayMs * 2 ** (note.failures - 1), MAX_RETRY_MS),
    )
    const code = codeOf(error)
    if (failing.get(id) === code) return
    failing.set(id, code)
    report()
  }

  /**
   * Writes `make()`, a record of the note as it is now, based on the body
   * version the note holds. When storage refuses it because another process
   * wrote the note since, the note takes the stored copy in and the record
   * is made and written again, WRITE_TRIES times in all at most. Returns the
   * record written, or undefined when the note was deleted for good
   * meanwhile (it is let go: storage would take no write of it). Throws the
   * storage's error. Runs only through exclusive.
   */
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

  /**
   * Writes the note as it is now, if it has changes and is still in memory,
   * then records what the write changed. Throws the storage's error. Runs
   * only through exclusive.
   */
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
      note.record = {
        ...note.record,
        bodyMd: note.doc.getText(BODY).toString(),
        ydoc: Y.encodeStateAsUpdate(note.doc),
        updatedAt: Math.max(now(), note.record.createdAt),
      }
      return note.record
    })
    if (!record) return
    const written = asWritten(record)
    note.record = { ...note.record, bodyVersion: written.bodyVersion }
    const before = note.saved
    note.saved = written
    note.savedEdits = edits
    settle(note)
    recordEvents(note.rev, before, written)
    sweep()
  }

  /**
   * Saves the note's changes, after any write of it under way. When the
   * write fails, the changes stay pending: the note is tried again later
   * and reported (see failed), and the error is thrown.
   */
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

  /** Saves every note in memory; one that fails is reported and tried again later. */
  const saveAll = () => Promise.allSettled([...live.values()].map(save))

  /** Saves the note shortly after its last change. */
  const schedule = (note: Live) => {
    clearTimeout(note.timer)
    note.timer = setTimeout(() => {
      note.timer = undefined
      // A failure is kept and reported by save, and tried again.
      save(note).catch(() => {})
    }, saveDelayMs)
  }

  /** Lets the note go from memory: nothing of it is saved or tried again. */
  const drop = (note: Live) => {
    clearTimeout(note.timer)
    note.timer = undefined
    stopTimers(note)
    if (live.get(note.record.id) === note) live.delete(note.record.id)
    settle(note)
  }

  /**
   * A stored note (with `trashed`, one in the Trash too), its stamps taken
   * in by the clock first, so a write based on it always wins over them
   * (see receiveStored).
   */
  const getStored = async (id: string, which?: { trashed: boolean }) => {
    const record = await storage.getNote(id, which)
    if (record) receiveStored(clock, stampsOf(record))
    return record
  }

  /**
   * The note, read from storage unless it is in memory, for a service call
   * that uses it: it counts among the note's users at once (see using), so
   * it stays in memory until the call is done. Calls that ask for a note
   * while it is being read share that read: one note in memory, never two.
   */
  const load = (id: string): Promise<Live> => {
    const cached = live.get(id)
    if (cached) {
      // The most recently used last.
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
          // After any write of the note made without loading it.
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

  /** Runs `work` on the note (see load); the note stays in memory until it is done. */
  const using = async <T>(id: string, work: (note: Live) => T | Promise<T>): Promise<T> => {
    const note = await load(id)
    try {
      return await work(note)
    } finally {
      note.users -= 1
      trim()
    }
  }

  /**
   * Whether nothing of the note would be lost if it left memory: no call
   * uses it, no editor holds it, no write is asked for or under way, no
   * change is waiting for its save or failed to save, and its title is not
   * being typed (a burst of title edits is one event, see recordEvents).
   */
  const idle = (note: Live) =>
    note.users === 0 &&
    note.writes === 0 &&
    note.timer === undefined &&
    note.retry === undefined &&
    !dirty(note) &&
    !holds.has(note.record.id) &&
    !failing.has(note.record.id) &&
    !(note.rev.title && now() - note.rev.title.at < REVISION_PAUSE_MS)

  /**
   * Lets the least recently used notes go until NOTES_IN_MEMORY are left,
   * those with anything to lose excepted (see idle): typing not kept as a
   * version yet becomes one first, as when quitting.
   */
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

  /** Replaces the body with `markdown` as one Yjs transaction (the text difference). */
  const replaceBody = (note: Live, markdown: string) => {
    const text = note.doc.getText(BODY)
    const diff = textDiff(text.toString(), markdown)
    if (diff.remove === 0 && diff.insert === '') return
    editBody(note, () =>
      note.doc.transact(() => {
        if (diff.remove > 0) text.delete(diff.index, diff.remove)
        if (diff.insert) text.insert(diff.index, diff.insert)
      }),
    )
    schedule(note)
  }

  /** A body version of this note, or E_REVISION_NOT_FOUND. */
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

  /**
   * Whether notes can go in this notebook: a live one, or Templates, whose
   * row may be missing (another device deleted it in a Devot from before
   * templates, when it showed as a plain notebook).
   */
  /** Whether `bookId` names a live notebook (the reserved Templates one always is). */
  const isLiveBook = async (bookId: string) =>
    bookId === TEMPLATES_BOOK_ID || (await storage.listBooks()).some((b) => b.id === bookId)

  const requireBook = async (bookId: string | null) => {
    if (bookId !== null && !(await isLiveBook(bookId))) throw new Error('E_BOOK_NOT_FOUND')
  }

  /** `bookId` when it names a live notebook: a deleted notebook counts as none. */
  const liveBook = async (bookId: string | null) =>
    bookId !== null && (await isLiveBook(bookId)) ? bookId : null

  /**
   * writeMeta for a note that is not in memory, without loading it: the
   * stored record is written back with the field changed and its body
   * (Markdown and Yjs state) as stored, so no Yjs document is built and the
   * search index is left alone (schema v15). Its history gets what a write
   * of the note in memory gives: the body first, when the history does not
   * end with it (see keepBaseline), then the event. Writes of one note made
   * this way go one at a time, and a load of it waits for them. When another
   * process wrote the note between the read and the write (storage refuses
   * the write), it is read and written again (see untilWritten).
   */
  const writeStored = (id: string, change: MetaChange): Promise<void> => {
    const run = (coldWrites.get(id) ?? Promise.resolve()).then(() =>
      untilWritten(async () => {
        const stored = await getStored(id)
        if (!stored) throw new Error('E_NOTE_NOT_FOUND')
        // A title stored past the limit is cut, as when a note is loaded.
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

  /**
   * Writes a new note holding `doc`, a body taken from another note
   * (Duplicate, New Note from Selection): its title, body and snapshot in one
   * write, so it is never stored empty, and keeps it open. Its text counts as
   * the text it arrived with, not as typing (see revisions).
   *
   * Attachments belong to one note, so the new note shows copies of its own:
   * `doc` must already show `copies` (see newFileCopies), which are then made
   * in one write. If that fails, the new note is purged and the copy's error
   * is thrown. The source keeps its files.
   */
  const insertNote = async (
    title: string,
    bookId: string | null,
    doc: Y.Doc,
    copies: readonly FileCopy[],
    status: NoteStatus = 'none',
  ) => {
    const at = now()
    const record: NoteRecord = {
      id: newId(),
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
    const { id } = record
    await storage.putNote(record)
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
      live.set(record.id, liveNote(asWritten(record), doc, true))
      trim()
      return record.id
    },

    duplicate: (id, options) =>
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
        return insertNote(
          title !== '' && options?.suffix ? `${title} ${options.suffix}` : title,
          await liveBook(source.record.bookId),
          doc,
          copies,
          source.record.status,
        )
      }),

    async extract(sourceId, markdown) {
      const bookId = await using(sourceId, (source) => source.record.bookId)
      const title = extractTitle(markdown)
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
      await Promise.all(
        ids.map(async (id) => {
          const note = live.get(id)
          const bodyMd = note
            ? note.doc.getText(BODY).toString()
            : (await storage.getNote(id, { trashed: true }))?.bodyMd
          if (bodyMd !== undefined) found[id] = headline(bodyMd)
        }),
      )
      return found
    },

    applyUpdate: (id, update) =>
      using(id, (note) => {
        editBody(note, () => Y.applyUpdate(note.doc, update))
        schedule(note)
      }),

    setBody: (id, markdown) => using(id, (note) => replaceBody(note, markdown)),

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

    setTitle: (id, title) =>
      using(id, (note) => {
        note.record = { ...note.record, title: clipTitle(title), titleHlc: clock.tick() }
        schedule(note)
      }),

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
      // Search what the user sees: edits still waiting for their save first.
      if (lookup?.flush !== false) await saveAll()
      // Names and sub-notebooks need the lists; most queries do not.
      const needs = (field: SearchClause['field']) => clauses.some((c) => c.field === field)
      const [books, tags] = await Promise.all([
        scope?.bookId || needs('book') ? storage.listBooks() : [],
        needs('tag') ? storage.listTags() : [],
      ])
      // `book:` never names Templates.
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
          // Deleted for good by another process meanwhile.
          if (live.get(id) !== note) return
          // The Trash keeps the history, last edits included.
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

    // Read again and written again when another process wrote the note
    // between the read and the write (see untilWritten).
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
      return { id, title: record.title, bodyMd: record.bodyMd }
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
      // Changes waiting for their save record their events first.
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
          // Deleted for good: storage would take no write of it.
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
          // Or a write made again before this merge took it in (see put).
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
  }
  return service
}
