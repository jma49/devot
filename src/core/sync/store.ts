// What the sync engine keeps in the database beside the notes (schema v19, migrations/0019_sync.sql),
// and the reads it needs that the rest of the core does not: raw rows, deleted notebooks and tags
// and purged notes included. The Rust store and the better-sqlite3 adapter implement it alike.

import type { BookRecord, NoteRecord, NoteTagRecord, TagRecord } from '../storage'
import type { SyncKind } from './records'

export interface SyncEntry {
  id: string
  kind: SyncKind
  /** The relay's version this device last saw; 0 for a record the relay does not hold yet. */
  version: number
  /** The state that version stands for here (see `fingerprint`); '' when none. */
  fingerprint: string
  bodyHlc: string
  /** The body `bodyHlc` was taken for (`bodyPrint`). */
  bodyFp: string
  /** Moved on by storage with every write of the record. */
  edits: number
  /** The `edits` the engine last looked at; the record is pending while they differ. */
  synced: number
}

export interface SyncNoteRow {
  /** Trashed notes too; a purged one is its tombstone (no title, no body). */
  note: NoteRecord
  purged: boolean
  /** Every membership row, removed ones included. */
  tags: NoteTagRecord[]
}

export interface SyncLocal {
  id: string
  entry: SyncEntry | null
  note: SyncNoteRow | null
  /** Deleted ones too, with their stored icon and colour as written. */
  book: BookRecord | null
  tag: TagRecord | null
}

export type SyncEntryWrite = Omit<SyncEntry, 'edits'>

/** The most IDs one `syncRead` takes (the Tauri command refuses more). */
export const MAX_SYNC_IDS = 100

export interface SyncStore {
  /** Records written since the engine last looked, by ID after `after`, at most `limit`. */
  syncPending(after: string, limit: number): Promise<string[]>
  syncRead(ids: readonly string[]): Promise<SyncLocal[]>
  /** Inserts or replaces an entry; the stored `edits` stays as it is. */
  syncPut(entry: SyncEntryWrite): Promise<void>
  syncState(): Promise<Record<string, string>>
  syncSetState(key: string, value: string): Promise<void>
  /** A new vault epoch: no record is on the relay (version 0, no fingerprint) and every one is pending. */
  syncReset(): Promise<void>
  /** A purge another device made: as `purgeNote`, but the note's revisions stay (the copy kept before it among them). */
  syncPurge(id: string, at: number, hlc: string): Promise<void>
}
