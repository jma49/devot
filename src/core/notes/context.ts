import type * as Y from 'yjs'
import type { AgentWriteRow } from '../authorship'
import type { Clock } from '../hlc'
import type { NoteRecord, StorageAdapter } from '../storage'
import type { NoteServiceOptions } from './types'

export type Timer = ReturnType<typeof setTimeout>

export interface Live {
  record: NoteRecord
  saved: NoteRecord
  doc: Y.Doc
  /** `doc` encoded, as read or last saved, until anything changes it: an open sends it as it is. */
  state: Uint8Array | undefined
  timer: Timer | undefined
  edits: number
  savedEdits: number
  queue: Promise<void>
  writes: number
  /** Service calls using the note now (see using): it stays in memory while any does. */
  users: number
  /** Set when a retried write took in a title another process gave the note; mergeStored reports it. */
  retitled: boolean
  /** The agent_writes rows storage holds of the note, as last written; undefined until the note's first write here, which derives them again, and none for a note made here. */
  rows: readonly AgentWriteRow[] | undefined
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

/** What the parts of one note service share: its options and the notes it knows of. */
export interface NoteContext {
  readonly options: NoteServiceOptions
  readonly storage: StorageAdapter
  readonly clock: Clock
  readonly newId: () => string
  readonly now: () => number
  /** Notes in memory, the least recently used first (see load and trim). */
  readonly live: Map<string, Live>
  readonly loading: Map<string, { note: Promise<Live>; users: number }>
  readonly holds: Map<string, number>
  /**
   * Notes another window may hold: the stored write last relayed to it, its body version, and when it last said so (see relayStored).
   * A `want` or `saved` only says the window has the note; its stored state is relayed when that write moves, checked by body version before any record read.
   */
  readonly heard: Map<string, { seen: string | undefined; version: number | undefined; at: number }>
  readonly coldWrites: Map<string, Promise<void>>
  readonly failing: Map<string, string>
}

export function createContext(options: NoteServiceOptions): NoteContext {
  const { storage, clock, newId } = options
  return {
    options,
    storage,
    clock,
    newId,
    now: options.now ?? Date.now,
    live: new Map(),
    loading: new Map(),
    holds: new Map(),
    heard: new Map(),
    coldWrites: new Map(),
    failing: new Map(),
  }
}
