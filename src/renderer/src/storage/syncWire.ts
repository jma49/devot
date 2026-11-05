// Sync between the core worker and the page: the engine's store and its transport cross to the
// page, which alone reaches Tauri commands. A note's Yjs state and a record's plaintext cross as
// base64, coded here in the worker (as in wire.ts), so the page hands them on without reading them.
import type { SyncFileMeta, SyncLocal, SyncStore } from '../../../core/sync/store'
import {
  pushOneByOne,
  type Cursor,
  type PullPage,
  type PushResult,
  type SyncTransport,
  type TransportName,
  type Welcome,
} from '../../../core/sync/transport'
import type { RecordKind } from '../../../core/sync/protocol'
import { fromBase64, toBase64, type WireNote } from './wire'

export type WireSyncLocal = Omit<SyncLocal, 'note'> & {
  note: { note: WireNote; purged: boolean; tags: NonNullable<SyncLocal['note']>['tags'] } | null
}

export interface WireSync extends Omit<SyncStore, 'syncRead' | 'syncFileData' | 'syncFilePut'> {
  syncRead(ids: readonly string[]): Promise<WireSyncLocal[]>
  /** The bytes as base64. */
  syncFileData(id: string): Promise<string | null>
  syncFilePut(file: SyncFileMeta, data: string): Promise<void>
}

export interface WirePulled {
  id: string
  name: string
  version: number
  seq?: number
  tag: string
  kind: RecordKind
  data: string | null
  error: string | null
}

export interface WirePushItem {
  id: string
  base: number
  /** The plaintext, base64. */
  data: string
  kind: RecordKind
  tag: string
}

export interface WireTransport {
  connect(): Promise<Welcome>
  pull(since: Cursor): Promise<{ records: WirePulled[]; next: Cursor; more: boolean }>
  push(id: string, base: number, data: string, kind: RecordKind, tag: string): Promise<PushResult>
  /** One upload for the batch; only iCloud takes it. */
  pushMany(items: WirePushItem[]): Promise<PushResult[]>
  close(): Promise<void>
}

export function fromWireSync(wire: WireSync): SyncStore {
  return {
    syncPending: (after, limit) => wire.syncPending(after, limit),
    syncPendingCount: () => wire.syncPendingCount(),
    async syncRead(ids) {
      const rows = await wire.syncRead(ids)
      return rows.map((row) => ({
        ...row,
        note: row.note && {
          ...row.note,
          note: { ...row.note.note, ydoc: fromBase64(row.note.note.ydoc) },
        },
      }))
    },
    syncPut: (entry) => wire.syncPut(entry),
    syncState: () => wire.syncState(),
    syncSetState: (key, value) => wire.syncSetState(key, value),
    syncReset: () => wire.syncReset(),
    syncPurge: (id, at, hlc) => wire.syncPurge(id, at, hlc),
    async syncFileData(id) {
      const data = await wire.syncFileData(id)
      return data === null ? null : fromBase64(data)
    },
    syncFilePut: (file, data) => wire.syncFilePut(file, toBase64(data)),
    syncFileDelete: (id) => wire.syncFileDelete(id),
  }
}

/** The relay takes one push at a time (`pushOneByOne`); iCloud takes a batch in one upload. */
export function fromWireTransport(
  wire: WireTransport,
  via: TransportName = 'relay',
): SyncTransport {
  const push: SyncTransport['push'] = (id, base, plaintext, kind = 'record', tag = '') =>
    wire.push(id, base, toBase64(plaintext), kind, tag)
  return {
    connect: () => wire.connect(),
    async pull(since): Promise<PullPage> {
      const page = await wire.pull(since)
      return {
        ...page,
        records: page.records.map((r) => ({
          id: r.id,
          name: r.name,
          version: r.version,
          ...(r.seq === undefined ? {} : { seq: r.seq }),
          tag: r.tag,
          kind: r.kind,
          ...(r.data === null ? {} : { plaintext: fromBase64(r.data) }),
          ...(r.error === null ? {} : { error: r.error }),
        })),
      }
    },
    push,
    pushMany: (items) =>
      via === 'icloud'
        ? wire.pushMany(
            items.map((item) => ({
              id: item.id,
              base: item.base,
              data: toBase64(item.plaintext),
              kind: item.kind,
              tag: item.tag,
            })),
          )
        : pushOneByOne(push, items),
    close: () => wire.close(),
  }
}
