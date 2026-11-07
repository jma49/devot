import type { ActivityHeatmap, OffsetAt, StripDay, Writing } from '../activity'
import type { AgentEdit, Log, Reversal, WriterKind } from '../authorship'
import type { DiffBlock } from '../diff'
import type { Clock } from '../hlc'
import type { HistoryEntry } from '../revisions'
import type { SearchScope } from '../search'
import type {
  AgentWriteSummary,
  NoteStatus,
  NoteSummary,
  StorageAdapter,
  TrashedNote,
} from '../storage'
import type { NoteLinkTarget } from '../preview/registry'
import type { TaskProgress } from '../tasks'
import type { AppendOptions } from '../append'
import type { NoteRelayMessage, TakenIn } from '../noteRelay'

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
  /** How long after a pause a small note is saved (300 ms); a large one waits longer (see saveDelay). */
  saveDelayMs?: number
  /** Doubles with each failure in a row, up to 30 s. */
  retryDelayMs?: number
  /** Called with every note whose save failed, oldest first, whenever that list changes. */
  onSaveProblems?: (problems: SaveProblem[]) => void
  /** On by default. A service that writes from another process turns it off: its writes hold the database write lock and its time zone may differ from the app's. */
  compact?: boolean
  /** Tells the cores of the app's other windows of every change to a note in memory, every write, and every note read in (see noteRelay.ts and receive). */
  relay?: (message: NoteRelayMessage) => void
  /** A note in memory took in a change it did not make: another window's (relayed), or one stored meanwhile (merged), for the editor and title field showing it. */
  onTakenIn?: (change: TakenIn) => void
  /** Info lines (I_AUTHORSHIP_*): codes and IDs only. Never the console where stdout carries something else. */
  log?: Log
}

/** An agent's write (ADR 0007), timed by the service. */
export type AgentNoteWrite = Omit<AgentEdit, 'at' | 'maxRemovedBytes'>

/** Search hits, and whether more matched than the SEARCH_LIMIT returned. */
export interface SearchResult {
  found: NoteSummary[]
  capped: boolean
}

/** A status change that can be undone: the note before it, and the status clock and stored version it left. */
export interface StatusUndo {
  readonly status: NoteStatus
  readonly updatedAt: number
  readonly statusHlc: string
  readonly bodyVersion: number
}

export interface NoteService {
  list(limit?: number): Promise<NoteSummary[]>
  create(title?: string, bookId?: string | null): Promise<string>
  /** Makes note `id` holding `markdown` as a Yjs state every device builds byte for byte alike, so copies seeded on two devices merge as one (first-launch notes). One write, so its dates stay equal until the owner changes it (Rust's `own_note_count`). */
  seed(
    id: string,
    title: string,
    bookId: string | null,
    markdown: string,
    pinned?: boolean,
  ): Promise<void>
  open(id: string, known?: Uint8Array): Promise<OpenedNote>
  /** Pending edits included; loads the note for an editor to open next. Throws E_NOTE_NOT_FOUND. */
  title(id: string): Promise<string>
  /** Keeps the note in memory until as many `unhold` calls, so the editor's replica and this service never part. */
  hold(id: string): void
  unhold(id: string): void
  /** Read without keeping the note in memory. Throws E_NOTE_NOT_FOUND. */
  read(id: string): Promise<{
    id: string
    title: string
    bodyMd: string
    bookId: string | null
  }>
  /** Untitled notes' list names: the first line of the body (see `headline`). Missing notes are left out. */
  headlines(ids: readonly string[]): Promise<Record<string, string>>
  /** List excerpts (see `listExcerpt`), pending edits included. Missing notes are left out. */
  excerpts(ids: readonly string[]): Promise<Record<string, string>>
  /** What a list row shows under its title: the excerpt and "done/total" of its tasks ('' with none), from one read. Missing notes are left out. */
  rowDetails(ids: readonly string[]): Promise<Record<string, RowDetail>>
  /** Each note's task items, done and in all (see `taskProgress`), pending edits included; a board card and a gallery caption show them. Missing notes are left out. */
  taskCounts(ids: readonly string[]): Promise<Record<string, TaskProgress>>
  /** The Markdown each gallery card shows (see `cardExcerpt`), pending edits included. Missing notes are left out. */
  cardExcerpts(ids: readonly string[]): Promise<Record<string, string>>
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
  /** `setBody` only while the body is still `expected`, checked and changed in one step; false when it was not. */
  setBodyFrom(id: string, expected: string, markdown: string): Promise<boolean>
  /** On a failed save the note is dropped anyway and the error thrown: the caller (import, the AI service) undoes or reports it. */
  release(id: string): Promise<void>
  /** Line breaks become spaces and the title is cut to MAX_TITLE_CHARS (see clipTitle), so storage always takes it. */
  setTitle(id: string, title: string): Promise<void>
  setBook(id: string, bookId: string | null): Promise<void>
  setStatus(id: string, status: NoteStatus): Promise<void>
  /** Writes now, like setStatus otherwise, and returns what `undoStatus` needs. */
  setStatusUndoable(id: string, status: NoteStatus): Promise<StatusUndo>
  /** Puts the status back only while it is still the one that change set, and the update time only when the note has not been written since: anything newer stays. */
  undoStatus(id: string, undo: StatusUndo): Promise<void>
  /** Both dates take one new HLC so the change wins over older writes (schema v17). Throws E_NOTE_TIME_INVALID for a date that is not a whole, non-negative millisecond time, or an update before the creation. */
  setDates(id: string, dates: { createdAt?: number; updatedAt?: number }): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<void>
  /** Writes now (a batch writes each note before the next). On failure it rejects and the field reverts unless changed again meanwhile. A note not in memory is not loaded: its stored record is rewritten with the field changed. `bookChecked`: the caller already ran checkBook. */
  writeMeta(id: string, change: MetaChange, options?: { bookChecked?: boolean }): Promise<void>
  /** Throws E_BOOK_NOT_FOUND unless notes can go in `bookId`: a live notebook or Templates (which count as one); null always passes. */
  checkBook(bookId: string | null): Promise<void>
  /** With `versions` (quitting), unversioned typing also becomes a version. Rejects with E_NOTE_SAVE_FAILED and the IDs once the rest are saved. */
  flush(options?: { versions?: boolean }): Promise<void>
  /** Called before the database is replaced (backup restore), so no sweep deletes what it chose from the old data. */
  holdCompaction(): Promise<void>
  resumeCompaction(): void
  /**
   * Templates are never found. `flush: false` (the `[[` popup runs on every key) searches as stored and writes nothing.
   * `shortInTitles` looks for text too short for the search index in titles only, which reads no body.
   */
  search(
    query: string,
    scope?: SearchScope,
    options?: { flush?: boolean; shortInTitles?: boolean },
  ): Promise<SearchResult>
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
  /**
   * Deletes a live note that has no title and no body for good, without the Trash. Storage
   * refuses one with either (`E_NOTE_NOT_TRASHED`), its pending edits saved first.
   */
  discardEmpty(id: string): Promise<void>
  /** Resolves to how many notes were deleted. */
  emptyTrash(): Promise<number>
  history(id: string): Promise<HistoryEntry[]>
  /** Throws E_REVISION_NOT_FOUND for anything but a body version of this note. */
  compareRevision(id: string, revisionId: string): Promise<DiffBlock[]>
  /** Returns the Yjs update the edit made, for the editor's replica to apply as one undoable step. */
  restoreRevision(id: string, revisionId: string): Promise<Uint8Array>
  /** By body version ID, the characters it changed from the version kept before it (see charsChanged); the oldest kept has none. */
  versionChanges(id: string): Promise<Record<string, number>>
  /** The text of a body version of this note. Throws E_REVISION_NOT_FOUND for anything else. */
  revisionText(id: string, revisionId: string): Promise<string>
  /**
   * Puts back what the note no longer has of version `revisionId`'s text between `from` and `to` (offsets in that text), where it stood (see
   * passageInserts), as one edit; the text before and after it are kept as versions. Throws E_PASSAGE_NOT_REMOVED when the note still has all of it.
   * Returns the Yjs update, for the editor's replica to apply as one undoable step.
   */
  restorePassage(
    id: string,
    revisionId: string,
    range: { from: number; to: number },
  ): Promise<Uint8Array>
  /**
   * Puts an accepted AI edit proposal in place of the text it was asked for: `original` at `from`, or wherever it now is if edits since moved it and it
   * is there once (else E_AI_PROPOSAL_STALE). Returns the Yjs update, for the editor's replica to apply as one undoable step. The text before is kept as
   * a version and the result as a version marked AI_EDIT.
   */
  applyAiEdit(
    id: string,
    edit: { from: number; original: string; replacement: string },
  ): Promise<Uint8Array>
  /**
   * A plugin's edit of the note (ADR 0005): `markdown` replaces the body, applied as Yjs operations (see textEdits), when the body is still
   * `base`, the text the plugin read (else E_PLUGIN_NOTE_CHANGED). The text before is kept as a version. Returns the Yjs update, for the
   * editor's replica to apply as one undoable step.
   */
  applyPluginEdit(id: string, edit: { base: string; markdown: string }): Promise<Uint8Array>
  /**
   * Puts `text` at the end (or the start) of the section under `options.heading`, or of the note (see appendInsertion), as one Yjs
   * transaction, with the text before kept as a version as a plugin edit keeps it. Returns the Yjs update, for the editor's replica to
   * apply as one undoable step. Throws E_HEADING_NOT_FOUND, E_APPEND_TEXT_EMPTY, E_NOTE_BODY_TOO_LARGE and E_NOTE_NOT_FOUND.
   */
  appendToNote(id: string, text: string, options: AppendOptions): Promise<Uint8Array>
  /** Records an agent's write (ADR 0007): its body edit, applied as Yjs operations (see textEdits), and its record go in as one Yjs transaction. Resolves to the write's ID, or null when it changed nothing. */
  agentWrite(id: string, write: AgentNoteWrite): Promise<string | null>
  /** Undo All for one writer (its kind and every name it has gone by) as an owner edit; the text before is kept as a version. `update` is for the editor's replica to apply as one undoable step. */
  undoAgentWrites(
    id: string,
    writer: { kind: WriterKind; names: readonly string[] },
  ): Promise<Reversal & { update: Uint8Array }>
  /** Clear Authorship: drops every authorship record of the note. Returns the Yjs update, for the editor's replica. */
  clearAuthorship(id: string): Promise<Uint8Array>
  /** The agent_writes rows of notes not in the Trash, newest first (StorageAdapter.listAgentWrites). */
  agentWrites(limit: number): Promise<AgentWriteSummary[]>
  /** IDs of the notes with any agent_writes row, seen or not (StorageAdapter.authoredNotes). */
  authoredNotes(): Promise<string[]>
  /** Marks writes of the note seen on this device, once its pending edits are saved, so a write it holds has its row. */
  markWritesSeen(id: string, writeIds: readonly string[]): Promise<void>
  /** Pending edits are saved and unversioned typing becomes a version, so it counts. */
  activity(now: number, offsetAt?: OffsetAt): Promise<ActivityHeatmap>
  /** The phone's Activity screen, typing kept as a version first as for `activity`. */
  writing(now: number, offsetAt?: OffsetAt): Promise<Writing>
  /** The list's activity strips of `ids` (at most MAX_BODY_IDS; see buildStrips), typing not kept as a version yet counted today. Reads only: nothing is saved. */
  noteActivity(
    ids: readonly string[],
    now: number,
    offsetAt?: OffsetAt,
  ): Promise<Record<string, StripDay[]>>
  /**
   * Takes in what another process wrote (a writer on another connection; see `devot://db-changed`), so the next write keeps the other's changes.
   * Every note in memory merges the stored state, and another window that may hold a note this core does not is relayed its stored state. Returns the notes whose title the other process changed.
   * A note deleted for good meanwhile is let go; the others stay in memory (letting one go could lose an edit that has just loaded it). A note that cannot be read is left as it was.
   */
  mergeStored(): Promise<{ id: string; title: string }[]>
  /**
   * Takes in what another window's core relayed. A note not in memory ignores it: it is read from storage when used, and asks then for what
   * the others hold beyond that. A change taken in is saved by the window that made it, which also keeps the versions of its own typing.
   */
  receive(message: NoteRelayMessage): Promise<void>
}
