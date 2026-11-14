// The core's view of storage: Tauri commands in the app, better-sqlite3 in tests. Every call is async.
//
// Metadata fields carry the HLC of their last write; storage keeps the newer value per field (last-writer-wins). The body is a Yjs document written whole, only
// while it is still at the version the writer last saw (see putNote), so a body written meanwhile is merged, never overwritten.

import type { AgentWriteRow } from './authorship'
import type { FileCopy, FileMeta } from './files'
import type { WelcomeSeed } from './welcome'

export interface NoteRecord {
  id: string
  title: string
  titleHlc: string
  /** Derived from `ydoc`; never written on its own. */
  bodyMd: string
  ydoc: Uint8Array
  /** Version of the stored body this body is based on (see putNote). 0 for a new note and for a body stored before versions (schema v16). */
  bodyVersion: number
  /** null for none; a deleted notebook counts as none. */
  bookId: string | null
  /** HLC fields are '' when never set. */
  bookHlc: string
  status: NoteStatus
  statusHlc: string
  pinned: boolean
  pinnedHlc: string
  createdAt: number
  updatedAt: number
  /** HLC of the last hand-set date change (setDates); a newer one sets both dates as written (schema v17), otherwise only `updatedAt` moves on. */
  datesHlc?: string
  deletedAt: number | null
  deletedHlc: string | null
  /** The note's rows of the agent_writes index, derived from `ydoc` (agentWriteRows) and written with it. Undefined leaves the stored rows as they are. */
  agentWrites?: readonly AgentWriteRow[]
}

/** A note's fields without its body, for a write that changed no text (putNoteMeta). */
export type NoteFields = Omit<NoteRecord, 'bodyMd' | 'ydoc'>

/** A row of the agent_writes index (ADR 0007): derived, never synced; `seen` is this device's. */
export interface AgentWriteSummary extends AgentWriteRow {
  noteId: string
  seen: boolean
}

/**
 * The newest rows one `listAgentWrites` call takes as its `limit` (the Tauri
 * command refuses more). Every unseen row older than those comes with them.
 */
export const MAX_AGENT_WRITES_LISTED = 1000

export interface TrashedNote {
  id: string
  title: string
  deletedAt: number
  bookId: string | null
}

export const NOTE_STATUSES = ['none', 'active', 'on_hold', 'completed', 'dropped'] as const
export type NoteStatus = (typeof NOTE_STATUSES)[number]

export interface NoteSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** The stored body's version (NoteRecord.bodyVersion): moves with every write of the note, whatever happens to its update time. */
  bodyVersion: number
  bookId: string | null
  status: NoteStatus
  pinned: boolean
  tagIds: string[]
  /** Search results only: the body around the first searched word, if any is found. */
  excerpt?: string
}

export interface TextCondition {
  field: 'any' | 'title' | 'body'
  value: string
  negate: boolean
}

export interface SetCondition {
  kind: 'book' | 'tag' | 'status'
  /** Never empty. */
  ids: string[]
  negate: boolean
}

export interface LinkGraph {
  notes: { id: string; title: string }[]
  /** `[source, target]`. */
  links: [string, string][]
}

export interface NoteQuery {
  text: TextCondition[]
  sets: SetCondition[]
  /** null: either. */
  pinned: boolean | null
}

/** Tag colour IDs; each theme colours them via `color.tag.<id>`. Rust validates against `TAG_COLORS` in storage/records.rs. */
export const TAG_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'gray',
] as const
export type TagColor = (typeof TAG_COLORS)[number]
/** What a tag's colour may be: a palette ID, or a custom colour as lowercase `#rrggbb`. A notebook icon stays palette only. */
export type TagColorValue = TagColor | `#${string}`

export interface TagRecord {
  id: string
  name: string
  nameHlc: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  deletedHlc: string | null
  /** An ID storage does not know (from a later palette, through sync) reads as null. */
  color: TagColorValue | null
  colorHlc: string
}

export interface NoteTagRecord {
  noteId: string
  tagId: string
  present: boolean
  hlc: string
}

/** A saved search (schema v25): a name and a query in the search field's syntax, kept as typed. */
export interface SavedSearchRecord {
  id: string
  name: string
  nameHlc: string
  query: string
  queryHlc: string
  /** Rows show in key order, equal keys in ID order (order.ts); '' for one never placed. */
  sortKey: string
  sortKeyHlc: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  deletedHlc: string | null
}

export interface BookRecord {
  id: string
  name: string
  nameHlc: string
  /** null: top level. */
  parentId: string | null
  parentHlc: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  deletedHlc: string | null
  /** Allow AI Access: AI tools see live notes filed directly in this notebook (not its sub-notebooks). */
  aiAccess: boolean
  aiAccessHlc: string
  /** Siblings show in key order, equal keys in ID order (order.ts). */
  sortKey: string
  sortKeyHlc: string
  /** An unknown name (from a later catalog, through sync) reads as null. */
  icon: string | null
  iconColor: TagColor | null
  iconHlc: string
}

const REVISION_KINDS = ['body', 'title', 'book', 'status', 'pinned'] as const
export type RevisionKind = (typeof REVISION_KINDS)[number]

export interface RevisionRecord {
  id: string
  noteId: string
  kind: RevisionKind
  at: number
  ydoc: Uint8Array | null
  length: number | null
  /** Event: the new value ('1' / '0' for pinned). Body: BASELINE (revisions.ts) when it keeps the text the history began with, else null. */
  value: string | null
  /** The words the note shows (noteCounts); null for an event and for a version taken before schema v24. */
  words: number | null
}

export type RevisionSummary = Omit<RevisionRecord, 'ydoc' | 'words'>

export interface CompactableVersion {
  noteId: string
  id: string
  at: number
}

export interface ActivityNote {
  id: string
  createdAt: number
}

/** A baseline (BASELINE in revisions.ts) is not counted: its text was not written in this history. */
export interface ActivityRevision {
  noteId: string
  kind: 'body' | 'title'
  at: number
  length: number | null
  words: number | null
  /** The length of the previous body version (equal times and lengths break ties by word count, which the covering index holds, then storage order); null for the first. */
  previous: number | null
  /** That version's word count; null for the first too, and when it predates schema v24. */
  previousWords: number | null
}

export interface ActivityData {
  notes: ActivityNote[]
  revisions: ActivityRevision[]
}

/** A note's title and Markdown body, read without its Yjs state (list rows). */
export interface NoteBody {
  id: string
  title: string
  bodyMd: string
}

/** The most notebooks one `putBooks` call takes (the Tauri command refuses more). */
export const MAX_PUT_BOOKS = 5_000

export interface ListPage {
  excludeBookId?: string
  limit?: number
}

/** The most IDs one `getBodies` call takes (the Tauri command refuses more). */
export const MAX_BODY_IDS = 500

/** A note as its editor opens it: the body is left out, as the Yjs state holds it. */
export type OpenedRecord = Omit<NoteRecord, 'bodyMd' | 'agentWrites'>

export interface StorageAdapter {
  /** Notes not in the trash, most recently updated first; outside `excludeBookId` and at most `limit` when given. */
  listNotes(page?: ListPage): Promise<NoteSummary[]>
  /** `listNotes` rows for `ids` (at most MAX_BODY_IDS) in list order; trashed, purged and unknown IDs are left out. */
  getSummaries(ids: readonly string[]): Promise<NoteSummary[]>
  /** Null for a purged note; a note in the trash is returned only with `trashed`. */
  getNote(id: string, options?: { trashed?: boolean }): Promise<NoteRecord | null>
  /** `getNote` for a note to load: its record without the body. Null for a note not stored or in the trash. */
  openNote(id: string): Promise<OpenedRecord | null>
  /** One read for many notes (at most MAX_BODY_IDS), trashed ones included; purged and unknown IDs are left out. */
  getBodies(ids: readonly string[]): Promise<NoteBody[]>
  /** Live notes meeting every condition, best matches first, each with its excerpt; at most `limit`. */
  searchNotes(query: NoteQuery, limit: number): Promise<NoteSummary[]>
  /** Live notes outside `excludeBookId` whose body links to `id` (the link index), the note itself left out, most recently updated first (then by ID, descending); at most `limit` (MAX_BACKLINKS), without excerpts. */
  listBacklinks(id: string, excludeBookId: string, limit: number): Promise<NoteSummary[]>
  /** The link index between two different live notes outside `excludeBookId`, at most `limit` links in index order, with the title of each note they name. */
  listLinkGraph(excludeBookId: string, limit: number): Promise<LinkGraph>
  /** Not purged, most recently deleted first. */
  listTrash(): Promise<TrashedNote[]>
  /** Final: no later write restores it. An attachment another non-purged note still shows passes to that note, a live one before one in the Trash, then the smallest ID. */
  purgeNote(id: string, at: number, hlc: string): Promise<void>
  /** A compare-and-set on the body: written only while the stored body is at `note.bodyVersion`, then moved to the next version. Otherwise refused with E_NOTE_BODY_STALE; the writer merges the stored body (Yjs) and writes again. Metadata merges per field (newer HLC wins). Records outside the limits are refused (checkNote in noteLimits.ts). A purged note is left alone. */
  putNote(note: NoteRecord): Promise<void>
  /** putNote for a note whose body and Yjs state are the ones stored at `note.bodyVersion`: the fields alone are written, merged and compared as putNote does, and the version moves on (another process reads a moved version as a write to take in). The body, its state and its links stay as stored. E_NOTE_NOT_FOUND for a note storage does not have. */
  putNoteMeta(note: NoteFields): Promise<void>
  /** For a note not in the trash. Throws an error code for an unknown note, a refused format or a size out of range. */
  putFile(meta: FileMeta, data: Uint8Array): Promise<void>
  /** A file that does not exist is skipped. Throws E_NOTE_NOT_FOUND for an unknown or trashed note. */
  copyFiles(noteId: string, copies: readonly FileCopy[]): Promise<void>
  listBooks(): Promise<BookRecord[]>
  /** Whether `listBooks` holds it, without reading every notebook. */
  isLiveBook(id: string): Promise<boolean>
  putBook(book: BookRecord): Promise<void>
  /** Each as `putBook`, in order, in one transaction: all of them or none. At most MAX_PUT_BOOKS. */
  putBooks(books: readonly BookRecord[]): Promise<void>
  /** Writes the first-launch notes into a library that has never held anything (see welcome.ts) and answers whether it did. The app's store takes only the seed's stamps and writes its own bundled copy, whatever the licence: a caller can write no other content through it. */
  seedWelcome(seed: WelcomeSeed): Promise<boolean>
  listTags(): Promise<TagRecord[]>
  putTag(tag: TagRecord): Promise<void>
  /** Writes the tag and the saved searches rewritten for its new name in one transaction: all of them or none. */
  renameTag(tag: TagRecord, searches: readonly SavedSearchRecord[]): Promise<void>
  /** Live ones, in key order (then by ID). */
  listSavedSearches(): Promise<SavedSearchRecord[]>
  putSavedSearch(search: SavedSearchRecord): Promise<void>
  putNoteTag(link: NoteTagRecord): Promise<void>
  /** On or off, with its HLC; null when never written. */
  getNoteTag(noteId: string, tagId: string): Promise<NoteTagRecord | null>
  /** Replaces the time, state and value of the revision with its ID. Ignored for a purged or unknown note. */
  putRevision(revision: RevisionRecord): Promise<void>
  /** Without state, newest first. */
  listRevisions(noteId: string): Promise<RevisionSummary[]>
  /** With its state, or null. */
  getRevision(id: string): Promise<RevisionRecord | null>
  deleteRevisions(noteId: string, ids: readonly string[]): Promise<void>
  /** Weighed by a compaction sweep (see compactionWindows), a page of notes at a time. Read from indexes, never a version's state. */
  listCompactable(
    from: number,
    to: number,
    after: string,
    limit: number,
  ): Promise<CompactableVersion[]>
  /** An event, a baseline or an unknown ID is left alone. With `sweptAt`, records the sweep time in the same write. */
  compactRevisions(ids: readonly string[], sweptAt: number | null): Promise<void>
  /** Null before the first sweep. */
  lastCompaction(): Promise<number | null>
  /** Purged notes and their revisions are gone. */
  listActivity(since: number): Promise<ActivityData>
  /** What listActivity reads of the body versions and title changes, for `ids` only (at most MAX_BODY_IDS; unknown and purged IDs have none): the list's activity strips. */
  listNoteActivity(ids: readonly string[], since: number): Promise<ActivityRevision[]>
  /**
   * Rows of notes not in the Trash, newest first: the newest `limit` (up to
   * MAX_AGENT_WRITES_LISTED), and every unseen row older than those. A row
   * starts unseen, an `aiEdit` row seen.
   */
  listAgentWrites(limit: number): Promise<AgentWriteSummary[]>
  /** IDs of the notes not in the Trash with any agent_writes row, seen or not. */
  authoredNotes(): Promise<string[]>
  /** IDs the note has no row for are skipped. Answers how many rows it changed. */
  markAgentWritesSeen(noteId: string, writeIds: readonly string[]): Promise<number>
}
