// Sync in a window (src/core/sync, src-tauri/src/sync). Rust holds the settings, the keys, the
// device token and the socket; the main window's core worker runs the engine through the commands
// here. After every change Rust sends `devot://sync-changed` with its snapshot to every window,
// which re-sends it in the page as `devot:sync-changed` (the UI tests send that one).
import { useEffect, useState, useSyncExternalStore } from 'react'
import * as Comlink from 'comlink'
import type { SyncStatus } from '../../core/sync/engine'
import type { SyncEvent, Welcome, PushResult } from '../../core/sync/transport'
import type { Core } from './coreConnect'
import { DB_CHANGED } from './externalChanges'
import { invoke } from './ipc'
import { licenceEntitlements, startLicence, subscribeLicence } from './licence'
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
  status: {
    state: SyncStateName
    lastSync: number | null
    code: string | null
    tooLarge: number
    /** Paused by the relay's quota cap until then. */
    pausedUntil: number | null
    upload: { sent: number; total: number } | null
    /** The relay predates the quota cap or the attachment share. */
    relayOutdated: boolean
    /** Images kept on this device only, and why. */
    unsyncedFiles: { count: number; code: UnsyncedFilesCode } | null
  }
}

/** The relay's share for attachments is used up, or the relay cannot hold attachments at all. */
export const UNSYNCED_FILES_CODES = ['E_SYNC_ATTACHMENTS_FULL', 'E_SYNC_RELAY_OUTDATED'] as const
export type UnsyncedFilesCode = (typeof UNSYNCED_FILES_CODES)[number]

export const SYNC_OFF: SyncSnapshot = {
  relayUrl: '',
  enabled: false,
  vault: false,
  enrolled: false,
  status: {
    state: 'off',
    lastSync: null,
    code: null,
    tooLarge: 0,
    pausedUntil: null,
    upload: null,
    relayOutdated: false,
    unsyncedFiles: null,
  },
}

const CODE = /^[EWI]_[A-Z0-9_]+$/

const readCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

function readUpload(value: unknown): SyncSnapshot['status']['upload'] {
  if (typeof value !== 'object' || value === null) return null
  const sent = readCount((value as Record<string, unknown>)['sent'])
  const total = readCount((value as Record<string, unknown>)['total'])
  return sent !== null && total !== null && total > 0 && sent <= total ? { sent, total } : null
}

function readUnsyncedFiles(value: unknown): SyncSnapshot['status']['unsyncedFiles'] {
  if (typeof value !== 'object' || value === null) return null
  const count = readCount((value as Record<string, unknown>)['count'])
  const code = UNSYNCED_FILES_CODES.find((c) => c === (value as Record<string, unknown>)['code'])
  return count !== null && count > 0 && code ? { count, code } : null
}

export function readSnapshot(value: unknown): SyncSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const s = (typeof v['status'] === 'object' && v['status'] !== null ? v['status'] : {}) as Record<
    string,
    unknown
  >
  const state = SYNC_STATES.find((name) => name === s['state']) ?? 'off'
  const tooLarge = readCount(s['tooLarge']) ?? 0
  return {
    relayUrl: typeof v['relayUrl'] === 'string' ? v['relayUrl'] : '',
    enabled: v['enabled'] === true,
    vault: v['vault'] === true,
    enrolled: v['enrolled'] === true,
    status: {
      state,
      lastSync: readCount(s['lastSync']),
      code: typeof s['code'] === 'string' && CODE.test(s['code']) ? s['code'] : null,
      tooLarge,
      pausedUntil: state === 'paused' ? readCount(s['pausedUntil']) : null,
      upload: readUpload(s['upload']),
      relayOutdated: s['relayOutdated'] === true,
      unsyncedFiles: readUnsyncedFiles(s['unsyncedFiles']),
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

// A timer falls behind while the machine sleeps, so a pause is looked at again at least once a minute.
const PAUSE_RECHECK_MS = 60_000

/** Whether a quota pause's reset time has passed; turns true by itself once it does. */
export function usePauseOver(until: number | null): boolean {
  const passed = (at: number | null) => (at !== null && Date.now() >= at ? at : null)
  const [overAt, setOverAt] = useState(() => passed(until))
  useEffect(() => {
    if (until === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      const left = until - Date.now()
      if (left <= 0) setOverAt(until)
      else timer = setTimeout(check, Math.min(left, PAUSE_RECHECK_MS))
    }
    check()
    return () => clearTimeout(timer)
  }, [until])
  return until !== null && overAt === until
}

/** Rejects with Rust's code (E_SYNC_RELAY_URL_INVALID, ...); the snapshot stays as it was. */
export async function changeSync(patch: { relayUrl?: string; enabled?: boolean }) {
  const next = readSnapshot(await invoke<unknown>('sync_set', { patch }))
  publish(next)
  return next
}

const RECOVERY_KEY = /^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/

/**
 * The relay secret goes to Rust for the one request that creates the vault; it is never kept. The
 * recovery key comes back while this device has not said it was saved.
 */
export async function createSyncVault(
  relaySecret: string,
): Promise<{ snapshot: SyncSnapshot | undefined; recoveryKey: string | null }> {
  const value = await invoke<unknown>('sync_vault_create', { relaySecret })
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const next = readSnapshot(v['snapshot'])
  publish(next)
  const key = v['recoveryKey']
  return { snapshot: next, recoveryKey: readRecoveryKey(key) }
}

const readRecoveryKey = (key: unknown) =>
  typeof key === 'string' && RECOVERY_KEY.test(key) ? key : null

/** The recovery key until this device says it was saved (`recoverySaved`), else null. */
export async function pendingRecoveryKey(): Promise<string | null> {
  return readRecoveryKey(await invoke<unknown>('sync_recovery_key'))
}

export async function recoverySaved(): Promise<void> {
  await invoke('sync_recovery_saved')
}

/** A pairing code on show (docs/adr/0008-sync-device-pairing.md). */
export interface ShownPairing {
  code: string
  link: string
  qr: { size: number; modules: string }
  /** When the code stops working, in ms. */
  expires: number
}

const PAIRING_CODE = /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/

export function readPairing(value: unknown): ShownPairing | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const qr = (typeof v['qr'] === 'object' && v['qr'] !== null ? v['qr'] : {}) as Record<
    string,
    unknown
  >
  const size = qr['size']
  const modules = qr['modules']
  const { code, link, expires } = v
  const qrOk =
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    size <= 177 &&
    typeof modules === 'string' &&
    modules.length === size * size &&
    /^[01]*$/.test(modules)
  if (
    typeof code !== 'string' ||
    !PAIRING_CODE.test(code) ||
    typeof link !== 'string' ||
    !link.startsWith('devot://pair?') ||
    typeof expires !== 'number' ||
    !Number.isSafeInteger(expires) ||
    !qrOk
  ) {
    return undefined
  }
  return { code, link, qr: { size, modules }, expires }
}

/** Shows a new pairing code; the last one stops working. Rejects with Rust's code. */
export async function openPairing(): Promise<ShownPairing> {
  const shown = readPairing(await invoke<unknown>('sync_pairing_open'))
  if (!shown) throw new Error('E_SYNC_PAIRING_INVALID')
  return shown
}

export type PairingProgress =
  | { state: 'waiting' | 'taken' | 'expired' | 'unconfirmed' }
  | { state: 'paired'; device: string }

/**
 * How the code on show is going; `paired` once the new device confirmed it holds the vault, and
 * `unconfirmed` when a device took the code and never confirmed.
 */
export async function checkPairing(): Promise<PairingProgress> {
  const value = await invoke<unknown>('sync_pairing_check')
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const state = v['state']
  if (state === 'paired' && typeof v['device'] === 'string') return { state, device: v['device'] }
  if (state === 'waiting' || state === 'taken' || state === 'expired' || state === 'unconfirmed')
    return { state }
  throw new Error('E_SYNC_PAIRING_INVALID')
}

export async function cancelPairing(): Promise<void> {
  await invoke('sync_pairing_cancel')
}

/**
 * The relay a pasted pairing link names, or undefined for a bare code. Rust joins only the relay
 * set in Settings, so Settings asks before it sets one from a link.
 */
export function linkRelay(text: string): string | undefined {
  const trimmed = text.trim()
  if (!/^devot:\/\/pair\?/i.test(trimmed)) return undefined
  const relay = new URLSearchParams(trimmed.slice(trimmed.indexOf('?') + 1)).get('relay')
  if (!relay) return undefined
  try {
    const url = new URL(relay)
    return url.protocol === 'https:' || url.protocol === 'http:' ? relay : undefined
  } catch {
    return undefined
  }
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i

/** Whether Rust takes this as a relay: https, or http to this machine only (RelayUrl::parse). */
export function relayAllowed(relay: string): boolean {
  try {
    const url = new URL(relay)
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.test(url.hostname))
  } catch {
    return false
  }
}

/** Joins the vault a pairing code (or the link its QR code holds) hands over. */
export async function joinWithCode(code: string) {
  const next = readSnapshot(await invoke<unknown>('sync_join_code', { code }))
  publish(next)
  return next
}

/** Joins with the recovery key and the relay set in Settings. */
export async function joinWithRecoveryKey(recoveryKey: string) {
  const next = readSnapshot(await invoke<unknown>('sync_join_recovery', { recoveryKey }))
  publish(next)
  return next
}

export interface SyncDevice {
  id: string
  label: string
  created: number
  /** This device. */
  current: boolean
}

export function readDevices(value: unknown): SyncDevice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const d = item as Record<string, unknown>
    const { id, label, created } = d
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return []
    if (typeof label !== 'string' || typeof created !== 'number') return []
    return [{ id, label: label.slice(0, 256), created, current: d['current'] === true }]
  })
}

export async function listDevices(): Promise<SyncDevice[]> {
  return readDevices(await invoke<unknown>('sync_devices'))
}

/** Removes a device from the vault: the relay revokes its token. Returns the devices left. */
export async function removeDevice(device: string): Promise<SyncDevice[]> {
  return readDevices(await invoke<unknown>('sync_device_remove', { device }))
}

export const tauriSync: WireSync = {
  syncPending: (after, limit) => invoke<string[]>('sync_pending', { after, limit }),
  syncPendingCount: () => invoke<number>('sync_pending_count'),
  syncRead: (ids) => invoke<WireSyncLocal[]>('sync_read', { ids }),
  syncPut: (entry) => invoke('sync_entry_put', { entry: { ...entry, edits: 0 } }),
  syncState: () => invoke<Record<string, string>>('sync_state_get'),
  syncSetState: (key, value) => invoke('sync_state_put', { key, value }),
  syncReset: () => invoke('sync_reset'),
  syncPurge: (id, at, hlc) => invoke('sync_note_purge', { id, at, hlc }),
  syncFileData: (id) => invoke<string | null>('sync_file_data', { id }),
  syncFilePut: (file, data) => invoke('sync_file_put', { file, data }),
  syncFileDelete: (id) => invoke('sync_file_delete', { id }),
}

export const tauriTransport: WireTransport = {
  connect: () => invoke<Welcome>('sync_connect'),
  pull: (since) =>
    invoke<{ records: WirePulled[]; next: number; more: boolean }>('sync_pull', { since }),
  push: (id, base, data, kind) => invoke<PushResult>('sync_push', { id, base, data, kind }),
  close: () => invoke('sync_disconnect'),
}

const reported = (status: SyncStatus) => ({
  state: status.state,
  lastSync: status.lastSync,
  code: status.code,
  tooLarge: status.tooLarge.length,
  pausedUntil: status.pausedUntil,
  upload: status.upload,
  relayOutdated: status.relayOutdated,
  unsyncedFiles: status.unsyncedFiles,
})

/**
 * Only `main` runs the engine: one engine per app on Rust's one socket, and `main` hides rather
 * than closes while the app runs.
 */
export const runsSync = (label: string) => label === 'main'

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
    // A licence added or removed starts the engine again: it connects, or stops as Rust refuses.
    const licensed = licenceEntitlements.has('sync')
    const wanted =
      !stopped && next.enabled ? `${next.relayUrl}|${next.enrolled}|${String(licensed)}` : ''
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
  const unsubscribeLicence = subscribeLicence(listener)
  startLicence()
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
    unsubscribeLicence()
    window.removeEventListener(DB_CHANGED, touched)
    unlisten?.()
    follow(snapshot)
  }
}
