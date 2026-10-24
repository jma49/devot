// Sync between the core worker and the page: the engine's store and its transport cross to the
// page, which alone reaches Tauri commands. A note's Yjs state and a record's plaintext cross as
// base64, coded here in the worker (as in wire.ts), so the page hands them on without reading them.
import type { SyncLocal, SyncStore } from '../../../core/sync/store'
import type { PullPage, PushResult, SyncTransport, Welcome } from '../../../core/sync/transport'
import type { RecordKind } from '../../../core/sync/protocol'
import { fromBase64, toBase64, type WireNote } from './wire'

export type WireSyncLocal = Omit<SyncLocal, 'note'> & {
  note: { note: WireNote; purged: boolean; tags: NonNullable<SyncLocal['note']>['tags'] } | null
}

export interface WireSync extends Omit<SyncStore, 'syncRead'> {
  syncRead(ids: readonly string[]): Promise<WireSyncLocal[]>
}

export interface WirePulled {
  id: string
  version: number
  seq: number
  kind: RecordKind
  data: string | null
  error: string | null
}

export interface WireTransport {
  connect(): Promise<Welcome>
  pull(since: number): Promise<{ records: WirePulled[]; next: number; more: boolean }>
  push(id: string, base: number, data: string): Promise<PushResult>
  close(): Promise<void>
}

export function fromWireSync(wire: WireSync): SyncStore {
  return {
    syncPending: (after, limit) => wire.syncPending(after, limit),
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
  }
}

export function fromWireTransport(wire: WireTransport): SyncTransport {
  return {
    connect: () => wire.connect(),
    async pull(since): Promise<PullPage> {
      const page = await wire.pull(since)
      return {
        ...page,
        records: page.records.map((r) => ({
          id: r.id,
          version: r.version,
          seq: r.seq,
          kind: r.kind,
          ...(r.data === null ? {} : { plaintext: fromBase64(r.data) }),
          ...(r.error === null ? {} : { error: r.error }),
        })),
      }
    },
    push: (id, base, plaintext) => wire.push(id, base, toBase64(plaintext)),
    close: () => wire.close(),
  }
}
