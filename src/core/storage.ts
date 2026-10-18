// The core's view of storage. The app implements it with Tauri commands;
// devot-mcp and tests implement it with better-sqlite3. Every call is async.
//
// Metadata fields carry the HLC of their last write. Storage keeps the newer
// value per field when it writes a record (last-writer-wins), so writing a
// stale copy of a record never undoes a newer change to one of its fields.
// The body is a Yjs document, which a write replaces whole: storage writes a
// note only while its body is still at the version the writer last saw
// (see putNote), so a body written meanwhile is merged, never written over.

import type { FileCopy, FileMeta } from './files'

export interface NoteRecord {
  id: string
  title: string
  titleHlc: string
  /** Markdown snapshot, derived from `ydoc`. Never written on its own. */
  bodyMd: string
  /** Yjs document state: the source of truth for the body. */
  ydoc: Uint8Array
  /**
   * The version of the stored body this record's body is based on: getNote
   * gives the stored one, and a write is taken only while the stored body
   * is still at the version it gives, which the write moves on by one (see
   * putNote). 0 for a note not written yet, and for a body stored before
   * versions (schema v16).
   */
  bodyVersion: number
  /** The note's notebook; null for none. A deleted notebook counts as none. */
  bookId: string | null
  /** HLC of the last notebook change; '' when never set. */
  bookHlc: string
  status: NoteStatus
  statusHlc: string
  pinned: boolean
  pinnedHlc: string
  createdAt: number
  updatedAt: number
  /**
   * HLC of the last hand-set change to the dates (setDates); '' or absent
   * when never set. A write with a newer one sets both dates as written
   * (schema v17); any other keeps `createdAt` and moves `updatedAt` only on.
   */
  datesHlc?: string
  deletedAt: number | null
  deletedHlc: string | null
}

/** A note in the trash, as the trash list shows it. */
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
  bookId: string | null
  status: NoteStatus
  pinned: boolean
  /** Live tags on the note (deleted tags excluded), in no particular order. */
  tagIds: string[]
  /**
   * Search results only: a short stretch of the body around the first
   * searched word found there (starting with an ellipsis when it starts
   * mid-body), if any is.
   */
  excerpt?: string
}

/** Text a note must (or, with `negate`, must not) contain, case-insensitively. */
export interface TextCondition {
  /** Where: the title or the body ('any'), the title, or the body. */
  field: 'any' | 'title' | 'body'
  value: string
  negate: boolean
}

/** The note's notebook, tag or status must be one of `ids` (with `negate`: none of them). */
export interface SetCondition {
  kind: 'book' | 'tag' | 'status'
  /** Notebook IDs, tag IDs or status IDs; never empty. */
  ids: string[]
  negate: boolean
}

/** A search as storage runs it: live notes meeting every condition. */
export interface NoteQuery {
  text: TextCondition[]
  sets: SetCondition[]
  /** Pinned notes only. */
  pinned: boolean
}

/**
 * The tag colour palette: the IDs a tag's colour may be. Each theme gives an
 * ID its colour (design tokens `color.tag.<id>`). Rust validates against the
 * same list (`TAG_COLORS` in storage/mod.rs).
 */
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

export interface TagRecord {
  id: string
  name: string
  nameHlc: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  deletedHlc: string | null
  /**
   * A palette ID, or null for no colour. Storage reads an ID it does not
   * know (from a later palette, through sync) as null.
   */
  color: TagColor | null
  /** HLC of the last colour change; '' when never set. */
  colorHlc: string
}

/** Whether a tag is on a note; adding and removing write the same row. */
export interface NoteTagRecord {
  noteId: string
  tagId: string
  present: boolean
  hlc: string
}

/** A notebook. Notebooks nest through `parentId`. */
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
  /**
   * Allow AI Access: devot-mcp sees the live notes filed directly in this
   * notebook (a sub-notebook needs its own switch). Off by default.
   */
  aiAccess: boolean
  /** HLC of the last switch change; '' when never set. */
  aiAccessHlc: string
  /**
   * Its place among its siblings (a fractional index, see order.ts):
   * siblings show in key order, equal keys in ID order.
   */
  sortKey: string
  /** HLC of the last move among siblings; '' when never set. */
  sortKeyHlc: string
  /**
   * An SF Symbol from the notebook icon catalog (notebookIcons.ts), or null
   * for the default icon. Storage reads a name it does not know (from a
   * later catalog, through sync) as null.
   */
  icon: string | null
  /**
   * A palette ID the icon is drawn in, or null for the text colour. Storage
   * reads an ID it does not know as null.
   */
  iconColor: TagColor | null
  /** HLC of the last icon change (icon and colour together); '' when never set. */
  iconHlc: string
}

/**
 * What a revision records: the body (a version of the text) or a change to
 * one metadata field.
 */
export const REVISION_KINDS = ['body', 'title', 'book', 'status', 'pinned'] as const
export type RevisionKind = (typeof REVISION_KINDS)[number]

/**
 * One entry of a note's revision history, local to this device (not synced).
 * A body version holds the Yjs state; a metadata event holds the new value.
 */
export interface RevisionRecord {
  id: string
  noteId: string
  kind: RevisionKind
  /** When the version was taken or the change was made (ms since the epoch). */
  at: number
  /** body: the note's Yjs state (`Y.encodeStateAsUpdate`); null for an event. */
  ydoc: Uint8Array | null
  /** body: the text's length in characters; null for an event. */
  length: number | null
  /**
   * The new value of an event: the title, the notebook ID (null for none),
   * the status, or '1' / '0' for pinned. For a body version, BASELINE
   * (revisions.ts) when it keeps the text the note had when its history
   * began, otherwise null.
   */
  value: string | null
}

/** A revision without its Yjs state, as history lists show it. */
export type RevisionSummary = Omit<RevisionRecord, 'ydoc'>

/** A plain body version (never a baseline) a compaction sweep weighs, without its state. */
export interface CompactableVersion {
  noteId: string
  id: string
  at: number
}

/** A note's creation, as the activity heatmap counts it (see activity.ts). */
export interface ActivityNote {
  id: string
  createdAt: number
}

/**
 * A body version or a title change, as the activity heatmap counts it. A
 * baseline (BASELINE in revisions.ts) is not one: its text was not written
 * in this history; it only serves as the version before the next one.
 */
export interface ActivityRevision {
  noteId: string
  kind: 'body' | 'title'
  at: number
  /** body: the version's length in characters; null for a title change. */
  length: number | null
  /**
   * body: the length of the note's body version before this one (taken at
   * any time; the same time breaks ties by storage order), or null for its
   * first; null for a title change.
   */
  previous: number | null
}

/** What storage holds about writing from some time on (see listActivity). */
export interface ActivityData {
  notes: ActivityNote[]
  revisions: ActivityRevision[]
}

export interface StorageAdapter {
  /** Notes not in the trash, most recently updated first. */
  listNotes(): Promise<NoteSummary[]>
  /** A note not in the trash, or null; with `trashed`, a note in the trash too (never a purged one). */
  getNote(id: string, options?: { trashed?: boolean }): Promise<NoteRecord | null>
  /**
   * Live notes meeting every condition of `query`, best matches first, each
   * with its excerpt. At most `limit` results.
   */
  searchNotes(query: NoteQuery, limit: number): Promise<NoteSummary[]>
  /** Notes in the trash (not purged), most recently deleted first. */
  listTrash(): Promise<TrashedNote[]>
  /**
   * Deletes a note permanently: wipes its content, keeps its ID and clocks,
   * and marks it purged; its revisions are deleted. Final: no later write
   * restores it. Its attachments are deleted too, except each one another
   * note that is not purged still shows (its Markdown holds the address
   * `devot://file/<id>`): that passes to such a note, a live one before one
   * in the Trash, then the smallest ID.
   */
  purgeNote(id: string, at: number, hlc: string): Promise<void>
  /**
   * Inserts a record, or merges it field by field (newer HLC wins). The body
   * always takes the written snapshot, and the note's link index rows become
   * `noteLinks(note.bodyMd)` (see links.ts). A purged note is left alone. A
   * record outside the limits is refused with the app's code (checkNote in
   * noteLimits.ts).
   *
   * A compare-and-set on the body: the record is written only while the
   * stored body is still at `note.bodyVersion`, the version its writer last
   * saw, and the body moves on to the next version (a new note is stored at
   * the next one too). A write based on another version would go over a
   * body another process wrote since: it is refused with E_NOTE_BODY_STALE
   * and changes nothing, and its writer takes the stored body in (a Yjs
   * merge) and writes again. A purged note is left alone whatever the
   * version.
   */
  putNote(note: NoteRecord): Promise<void>
  /**
   * Stores an attachment for a note that is not in the trash. Throws an
   * error code for an unknown note, a refused format or a size out of range.
   */
  putFile(meta: FileMeta, data: Uint8Array): Promise<void>
  /**
   * Gives a note that is not in the trash copies of attachments, in one
   * write: each `from` file's name, type and bytes under the new ID `to`.
   * A file that does not exist is skipped. Throws E_NOTE_NOT_FOUND for an
   * unknown or trashed note.
   */
  copyFiles(noteId: string, copies: readonly FileCopy[]): Promise<void>
  /** Notebooks that are not deleted. */
  listBooks(): Promise<BookRecord[]>
  /** Inserts a notebook, or merges it field by field (newer HLC wins). */
  putBook(book: BookRecord): Promise<void>
  /** Tags that are not deleted. */
  listTags(): Promise<TagRecord[]>
  /** Inserts a tag, or merges it field by field (newer HLC wins). */
  putTag(tag: TagRecord): Promise<void>
  /** Writes a note's tag membership; the newer HLC wins. */
  putNoteTag(link: NoteTagRecord): Promise<void>
  /**
   * A note's membership row for a tag, on or off, with its HLC; null when
   * none was ever written.
   */
  getNoteTag(noteId: string, tagId: string): Promise<NoteTagRecord | null>
  /**
   * Inserts a revision, or replaces the time, state and value of the one
   * with its ID (same note and kind). Ignored for a purged or unknown note.
   */
  putRevision(revision: RevisionRecord): Promise<void>
  /** A note's revisions without their state, newest first. */
  listRevisions(noteId: string): Promise<RevisionSummary[]>
  /** One revision with its state, or null. */
  getRevision(id: string): Promise<RevisionRecord | null>
  /** Deletes these revisions of a note (a title event quick edits took back). */
  deleteRevisions(noteId: string, ids: readonly string[]): Promise<void>
  /**
   * The plain body versions (baselines left out: compaction keeps them) of
   * the notes with more than one taken before `to`, one of them taken at or
   * after `from`: what a compaction sweep weighs (see compactionWindows). A
   * page at a time: the first `limit` such notes by ID after `after` ('' for
   * the first page), each with all its plain versions, by note, newest
   * first. Read from indexes, never a version's state, and only the window's
   * versions are scanned, besides each such note's.
   */
  listCompactable(
    from: number,
    to: number,
    after: string,
    limit: number,
  ): Promise<CompactableVersion[]>
  /**
   * Deletes these plain body versions (an event, a baseline or an unknown
   * ID is left alone) and, with `sweptAt`, records it as the time of the
   * last compaction sweep, in one write.
   */
  compactRevisions(ids: readonly string[], sweptAt: number | null): Promise<void>
  /** When the last compaction sweep ran (see compactRevisions); null before the first. */
  lastCompaction(): Promise<number | null>
  /**
   * What the activity heatmap counts from `since` on, over the notes on
   * this device (live or in the Trash; a purged note and its revisions are
   * gone): the notes created at or after `since`, and the body versions
   * (baselines left out) and title changes taken at or after it, in no
   * particular order.
   */
  listActivity(since: number): Promise<ActivityData>
}
