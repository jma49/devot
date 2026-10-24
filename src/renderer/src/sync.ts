// Sync in a window (src/core/sync, src-tauri/src/sync). Rust holds the settings, the keys, the
// device token and the socket; the main window's core worker runs the engine through the commands
// here. After every change Rust sends `devot://sync-changed` with its snapshot to every window,
// which re-sends it in the page as `devot:sync-changed` (the UI tests send that one).
import { useSyncExternalStore } from 'react'
import * as Comlink from 'comlink'
import type { SyncStatus } from '../../core/sync/engine'
import type { SyncEvent, Welcome, PushResult } from '../../core/sync/transport'
import type { Core } from './coreConnect'
import { DB_CHANGED } from './externalChanges'
import { invoke } from './ipc'
import type { WirePulled, WireSync, WireSyncLocal, WireTransport } from './storage/syncWire'

export const SYNC_CHANGED = 'devot:sync-changed'
const CHANGED_EVENT = 'devot://sync-changed'
const SOCKET_EVENT = 'devot://sync-event'

export const SYNC_STATES = [
  'off',
  'connecting',
  'syncing',
  'idle',
  'offline',
  'paused',
  'stopped',
] as const
export type SyncStateName = (typeof SYNC_STATES)[number]

export interface SyncSnapshot {
  relayUrl: string
  enabled: boolean
  /** The keychain holds a vault key. */
  vault: boolean
  /** This device has a token for the relay and the vault. */
  enrolled: boolean
  status: { state: SyncStateName; lastSync: number | null; code: string | null; tooLarge: number }
}

export const SYNC_OFF: SyncSnapshot = {
  relayUrl: '',
  enabled: false,
  vault: false,
  enrolled: false,
  status: { state: 'off', lastSync: null, code: null, tooLarge: 0 },
}

const CODE = /^[EWI]_[A-Z0-9_]+$/

export function readSnapshot(value: unknown): SyncSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const s = (typeof v['status'] === 'object' && v['status'] !== null ? v['status'] : {}) as Record<
    string,
    unknown
  >
  const state = SYNC_STATES.find((name) => name === s['state']) ?? 'off'
  const last = s['lastSync']
  const tooLarge = s['tooLarge']
  return {
    relayUrl: typeof v['relayUrl'] === 'string' ? v['relayUrl'] : '',
    enabled: v['enabled'] === true,
    vault: v['vault'] === true,
    enrolled: v['enrolled'] === true,
    status: {
      state,
      lastSync: typeof last === 'number' && Number.isSafeInteger(last) ? last : null,
      code: typeof s['code'] === 'string' && CODE.test(s['code']) ? s['code'] : null,
      tooLarge:
        typeof tooLarge === 'number' && Number.isSafeInteger(tooLarge) && tooLarge > 0
          ? tooLarge
          : 0,
    },
  }
}

let snapshot = SYNC_OFF
const listeners = new Set<() => void>()
const publish = (next: SyncSnapshot | undefined) => {
  if (!next) return
  snapshot = next
  for (const listener of listeners) listener()
}

let started = false

/** Reads the snapshot and follows Rust's changes; once per window. */
export function startSyncStatus(): void {
  if (started) return
  started = true
  window.addEventListener(SYNC_CHANGED, (e) => publish(readSnapshot((e as CustomEvent).detail)))
  invoke<unknown>('sync_get').then(
    (value) => publish(readSnapshot(value)),
    () => console.warn('W_SYNC_READ_FAILED'),
  )
  if (!DEVOT_UI_TEST) {
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(CHANGED_EVENT, (e) =>
          window.dispatchEvent(new CustomEvent(SYNC_CHANGED, { detail: e.payload })),
        ),
      )
      .catch(() => console.warn('W_SYNC_LISTEN_FAILED'))
  }
}

export const syncSnapshot = (): SyncSnapshot => snapshot

export function useSyncSnapshot(): SyncSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
}

/** Rejects with Rust's code (E_SYNC_RELAY_URL_INVALID, ...); the snapshot stays as it was. */
export async function changeSync(patch: { relayUrl?: string; enabled?: boolean }) {
  const next = readSnapshot(await invoke<unknown>('sync_set', { patch }))
  publish(next)
  return next
}

/** The relay secret goes to Rust for the one request that creates the vault; it is never kept. */
export async function createSyncVault(relaySecret: string) {
  const next = readSnapshot(await invoke<unknown>('sync_vault_create', { relaySecret }))
  publish(next)
  return next
}

export const tauriSync: WireSync = {
  syncPending: (after, limit) => invoke<string[]>('sync_pending', { after, limit }),
  syncRead: (ids) => invoke<WireSyncLocal[]>('sync_read', { ids }),
  syncPut: (entry) => invoke('sync_entry_put', { entry: { ...entry, edits: 0 } }),
  syncState: () => invoke<Record<string, string>>('sync_state_get'),
  syncSetState: (key, value) => invoke('sync_state_put', { key, value }),
  syncReset: () => invoke('sync_reset'),
  syncPurge: (id, at, hlc) => invoke('sync_note_purge', { id, at, hlc }),
}

export const tauriTransport: WireTransport = {
  connect: () => invoke<Welcome>('sync_connect'),
  pull: (since) =>
    invoke<{ records: WirePulled[]; next: number; more: boolean }>('sync_pull', { since }),
  push: (id, base, data) => invoke<PushResult>('sync_push', { id, base, data }),
  close: () => invoke('sync_disconnect'),
}

const reported = (status: SyncStatus) => ({
  state: status.state,
  lastSync: status.lastSync,
  code: status.code,
  tooLarge: status.tooLarge.length,
})

/**
 * The main window: runs the engine in the core worker while sync is on (Settings > Sync), again
 * from the start when the relay or the enrollment changes; tells it of the relay's events and of
 * writes other processes made, and reports its status to Rust. Returns the stop.
 */
export function runSync(core: Core): () => void {
  let running = ''
  let stopped = false
  let chain: Promise<void> = Promise.resolve()
  const report = (status: SyncStatus) =>
    void invoke('sync_status_report', { status: reported(status) }).catch(() =>
      console.warn('W_SYNC_STATUS_REPORT_FAILED'),
    )
  const follow = (next: SyncSnapshot) => {
    const wanted = !stopped && next.enabled ? `${next.relayUrl}|${next.enrolled}` : ''
    if (wanted === running) return
    const was = running
    running = wanted
    chain = chain
      .then(async () => {
        if (was) await core.stopSync()
        if (!wanted) return
        await core.startSync(
          Comlink.proxy(tauriSync),
          Comlink.proxy(tauriTransport),
          Comlink.proxy(report),
          // Another device changed notes here: merged and reloaded as another process's writes.
          Comlink.proxy(() => window.dispatchEvent(new CustomEvent(DB_CHANGED))),
        )
      })
      .catch(() => console.warn('W_SYNC_START_FAILED'))
  }
  const listener = () => follow(snapshot)
  listeners.add(listener)
  startSyncStatus()
  follow(snapshot)
  const touched = () => void core.syncTouch().catch(() => undefined)
  window.addEventListener(DB_CHANGED, touched)
  let unlisten: (() => void) | undefined
  void import('@tauri-apps/api/event')
    .then(async ({ listen }) => {
      const stop = await listen<SyncEvent>(SOCKET_EVENT, (e) => {
        void core.syncReceived(e.payload).catch(() => undefined)
      })
      if (stopped) stop()
      else unlisten = stop
    })
    .catch(() => console.warn('W_SYNC_LISTEN_FAILED'))
  return () => {
    stopped = true
    listeners.delete(listener)
    window.removeEventListener(DB_CHANGED, touched)
    unlisten?.()
    follow(snapshot)
  }
}
