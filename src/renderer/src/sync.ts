// Sync in a window (src/core/sync, src-tauri/src/sync). Rust holds the settings, the keys, the
// device token and the socket; the main window's core worker runs the engine through the commands
// here. After every change Rust sends `devot://sync-changed` with its snapshot to every window,
// which re-sends it in the page as `devot:sync-changed` (the UI tests send that one).
import { RESTORE_CHOICE } from '../../core/sync/restore'
import { useEffect, useState, useSyncExternalStore } from 'react'
import * as Comlink from 'comlink'
import { MAX_WALL } from '../../core/hlc'
import type { SyncStatus } from '../../core/sync/engine'
import type { SyncPending } from '../../core/sync/store'
import {
  STORAGE_FULL,
  VAULT_MOVED,
  type SyncEvent,
  type TransportName,
  type Welcome,
  type PushResult,
} from '../../core/sync/transport'
import type { Core } from './coreConnect'
import { DB_CHANGED } from './externalChanges'
import type { MessageKey } from './i18n'
import { invoke } from './ipc'
import { licenceEntitlements, startLicence, subscribeLicence } from './licence'
import type { WirePulled, WireSync, WireSyncLocal, WireTransport } from './storage/syncWire'
import { unlistenLater } from './windowEvents'

export const SYNC_CHANGED = 'devot:sync-changed'
const CHANGED_EVENT = 'devot://sync-changed'
const SOCKET_EVENT = 'devot://sync-event'

const SYNC_STATES = [
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
  /** What the vault syncs through. */
  transport: TransportName
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
    /** Records this run could not read or apply: a newer Devot may. */
    skipped: number
  }
  /** What the last look for the Apple ID's vault found, while the app runs. */
  icloudJoin: ICloudJoin | null
  /** This device started moving its relay vault to iCloud and has not switched yet. */
  moveStarted: boolean
  /** The vault's key was changed on another device: only its successor may be joined. */
  rotated: boolean
}

const ICLOUD_JOIN_STATES = ['unavailable', 'none', 'joined', 'ask', 'declined', 'fallback'] as const
const ICLOUD_FALLBACK_REASONS = ['missing', 'otherVault', 'unreadable'] as const

/**
 * Rust's ICloudJoinView: `ask` with the library's `notes`, `fallback` (a pairing code or the
 * recovery key) with its `reason`, `unavailable` with its `code`.
 */
export interface ICloudJoin {
  state: (typeof ICLOUD_JOIN_STATES)[number]
  notes: number | null
  reason: (typeof ICLOUD_FALLBACK_REASONS)[number] | null
  code: string | null
}

/** The relay's share for attachments is used up, or the relay cannot hold attachments at all. */
const UNSYNCED_FILES_CODES = ['E_SYNC_ATTACHMENTS_FULL', 'E_SYNC_RELAY_OUTDATED'] as const
export type UnsyncedFilesCode = (typeof UNSYNCED_FILES_CODES)[number]

export const SYNC_OFF: SyncSnapshot = {
  relayUrl: '',
  enabled: false,
  vault: false,
  enrolled: false,
  transport: 'relay',
  status: {
    state: 'off',
    lastSync: null,
    code: null,
    tooLarge: 0,
    pausedUntil: null,
    upload: null,
    relayOutdated: false,
    unsyncedFiles: null,
    skipped: 0,
  },
  icloudJoin: null,
  moveStarted: false,
  rotated: false,
}

const CODE = /^[EWI]_[A-Z0-9_]+$/

export { STORAGE_FULL }

/** What a person does about a sync that stopped for these codes. */
export const STOP_ADVICE: Readonly<Record<string, MessageKey>> = {
  E_SYNC_PROTOCOL: 'sync.advice.protocol',
  E_SYNC_CIRCUIT_OPEN: 'sync.advice.circuit',
  [RESTORE_CHOICE]: 'sync.advice.restoreChoice',
  [VAULT_MOVED]: 'sync.advice.moved',
  E_SYNC_VAULT_ROTATED: 'sync.advice.rotated',
}

const readCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** A time `Date` can format; the engine, the relay and the database are not trusted to stay in range. */
const readTime = (value: unknown): number | null => {
  const time = readCount(value)
  return time !== null && time <= MAX_WALL ? time : null
}

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

function readICloudJoin(value: unknown): ICloudJoin | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const state = ICLOUD_JOIN_STATES.find((name) => name === v['state'])
  if (!state) return null
  return {
    state,
    notes: readCount(v['notes']),
    reason: ICLOUD_FALLBACK_REASONS.find((reason) => reason === v['reason']) ?? null,
    code: typeof v['code'] === 'string' && CODE.test(v['code']) ? v['code'] : null,
  }
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
  const skipped = readCount(s['skipped']) ?? 0
  return {
    relayUrl: typeof v['relayUrl'] === 'string' ? v['relayUrl'] : '',
    enabled: v['enabled'] === true,
    vault: v['vault'] === true,
    enrolled: v['enrolled'] === true,
    transport: v['transport'] === 'icloud' ? 'icloud' : 'relay',
    status: {
      state,
      lastSync: readTime(s['lastSync']),
      code: typeof s['code'] === 'string' && CODE.test(s['code']) ? s['code'] : null,
      tooLarge,
      pausedUntil: state === 'paused' ? readTime(s['pausedUntil']) : null,
      upload: readUpload(s['upload']),
      relayOutdated: s['relayOutdated'] === true,
      unsyncedFiles: readUnsyncedFiles(s['unsyncedFiles']),
      skipped,
    },
    icloudJoin: readICloudJoin(v['icloudJoin']),
    moveStarted: v['moveStarted'] === true,
    rotated: v['rotated'] === true,
  }
}

let snapshot = SYNC_OFF
const listeners = new Set<() => void>()
const publish = (next: SyncSnapshot | undefined) => {
  if (!next) return
  snapshot = next
  for (const listener of listeners) listener()
}

/** Reads and shows a snapshot a command answered with. */
export function adoptSnapshot(value: unknown): SyncSnapshot | undefined {
  const next = readSnapshot(value)
  publish(next)
  return next
}

let started = false

/** This build's version, so records an older one could not read are pulled again; none outside the app. */
const appBuild = (): Promise<string | undefined> =>
  import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).catch(() => undefined)

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

/**
 * Changes the vault key: the relay secret makes the new vault on the relay and is never kept. The
 * new recovery key comes back to show until it is saved.
 */
export async function rotateSyncVault(
  relaySecret: string,
): Promise<{ snapshot: SyncSnapshot | undefined; recoveryKey: string | null }> {
  const value = await invoke<unknown>('sync_vault_rotate', { relaySecret })
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const next = readSnapshot(v['snapshot'])
  publish(next)
  return { snapshot: next, recoveryKey: readRecoveryKey(v['recoveryKey']) }
}

/** Leaves the relay vault this device holds: its key and token go here, and its notes stay. */
export const leaveSyncVault = async () => adoptSnapshot(await invoke<unknown>('sync_vault_leave'))

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

/**
 * Joins the vault a pairing code (or the link its QR code holds) hands over; a bare code goes
 * `via` iCloud when the device joins the Apple ID's vault.
 */
export async function joinWithCode(code: string, via?: 'icloud') {
  const next = readSnapshot(await invoke<unknown>('sync_join_code', via ? { code, via } : { code }))
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
  /** On iCloud: a relay device not seen there since this device moved the vault; `created` is the day it was added to the relay. */
  unseen: boolean
}

export function readDevices(value: unknown): SyncDevice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const d = item as Record<string, unknown>
    const { id, label, created } = d
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return []
    if (typeof label !== 'string' || readTime(created) === null) return []
    return [
      {
        id,
        label: label.slice(0, 256),
        created: created as number,
        current: d['current'] === true,
        unseen: d['unseen'] === true,
      },
    ]
  })
}

export async function listDevices(): Promise<SyncDevice[]> {
  return readDevices(await invoke<unknown>('sync_devices'))
}

/** Removes a device from the vault: the relay revokes its token. Returns the devices left. */
export async function removeDevice(device: string): Promise<SyncDevice[]> {
  return readDevices(await invoke<unknown>('sync_device_remove', { device }))
}

const tauriSync: WireSync = {
  syncPending: (after, limit) => invoke<SyncPending[]>('sync_pending', { after, limit }),
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

const tauriTransport: WireTransport = {
  connect: () => invoke<Welcome>('sync_connect'),
  pull: (since) =>
    invoke<{ records: WirePulled[]; next: string; more: boolean }>('sync_pull', { since }),
  push: (id, base, data, kind, tag) =>
    invoke<PushResult>('sync_push', { id, base, data, kind, tag }),
  pushMany: (items) => invoke<PushResult[]>('sync_push_many', { items }),
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
  skipped: status.skipped,
})

/**
 * Only `main` runs the engine: one engine per app on Rust's one socket, and `main` hides rather
 * than closes while the app runs.
 */
export const runsSync = (label: string) => label === 'main'

/** `runSync` in the window that runs the engine, once its core is up; never in the UI tests' build, which has no Rust storage or socket. */
export function useSyncEngine(core: Core | null | undefined, label: string): void {
  useEffect(
    () => (core && runsSync(label) && !DEVOT_UI_TEST ? runSync(core) : undefined),
    [core, label],
  )
}

/**
 * The main window (the Mac's, or the iPhone app's one window): runs the engine in the core worker
 * while sync is on (Settings > Sync), again from the start when the transport, the relay or the
 * enrollment changes; tells it of the relay's events, of writes other processes made and of the
 * app coming to the front, and reports its status to Rust. Returns the stop.
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
      !stopped && next.enabled
        ? `${next.transport}|${next.relayUrl}|${next.enrolled}|${String(licensed)}`
        : ''
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
          await appBuild(),
          next.transport,
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
  const focused = () => void core.syncFocused().catch(() => undefined)
  window.addEventListener('focus', focused)
  // The iPhone's web view gets no focus event when the app comes back from the background.
  const shown = () => {
    if (document.visibilityState === 'visible') focused()
  }
  document.addEventListener('visibilitychange', shown)
  const unlisten = unlistenLater(
    import('@tauri-apps/api/event').then(({ listen }) =>
      listen<SyncEvent>(SOCKET_EVENT, (e) => {
        void core.syncReceived(e.payload).catch(() => undefined)
      }),
    ),
    () => console.warn('W_SYNC_LISTEN_FAILED'),
  )
  return () => {
    stopped = true
    listeners.delete(listener)
    unsubscribeLicence()
    window.removeEventListener(DB_CHANGED, touched)
    window.removeEventListener('focus', focused)
    document.removeEventListener('visibilitychange', shown)
    unlisten()
    follow(snapshot)
  }
}
