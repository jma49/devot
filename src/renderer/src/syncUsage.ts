// What the relay holds and may hold, for Settings > Sync and the notice (docs/sync-relay.md,
// Quota). Rust asks the relay (`sync_usage`); the figures and bands are src/core/sync/usage.ts.
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  NOTHING_SEEN,
  noticeFor,
  viewStorage,
  type Fill,
  type RelayStorage,
  type Seen,
  type StorageView,
  type UsageNotice,
} from '../../core/sync/usage'
import { errorCode } from './backups'
import type { MessageKey } from './i18n'
import { invoke } from './ipc'
import type { SyncSnapshot } from './sync'
import { changeLogger } from './failure'

export const USAGE_NOTICE_TEXT: Readonly<Record<UsageNotice, MessageKey>> = {
  storageWarn: 'sync.notice.usage.storageWarn',
  storageFull: 'sync.notice.usage.storageFull',
  imagesWarn: 'sync.notice.usage.imagesWarn',
  imagesFull: 'sync.notice.usage.imagesFull',
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Rust's reading of a relay's `usage` answer, or undefined when it is not figures. */
export function readRelayUsage(value: unknown): RelayStorage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const storedBytes = count(v['storedBytes'])
  const fileBytes = count(v['fileBytes'])
  if (storedBytes === null || fileBytes === null) return undefined
  if (!('caps' in v)) return { storedBytes, fileBytes, caps: undefined }
  if (v['caps'] === null) return { storedBytes, fileBytes, caps: null }
  if (typeof v['caps'] !== 'object') return undefined
  const caps = v['caps'] as Record<string, unknown>
  const limit = count(caps['storedBytes'])
  if (limit === null || limit === 0) return undefined
  const files = caps['fileBytes'] === undefined ? undefined : count(caps['fileBytes'])
  if (files === null) return undefined
  return {
    storedBytes,
    fileBytes,
    caps: files === undefined ? { storedBytes: limit } : { storedBytes: limit, fileBytes: files },
  }
}

/** Why the figures cannot be shown: out of reach, a relay too old to report them, or another failure. */
export type UsageWhy = 'offline' | 'old' | 'failed'

export type UsageReading =
  | { state: 'ready'; view: StorageView }
  | { state: 'unavailable'; why: UsageWhy; code: string }

const OFFLINE = new Set(['E_SYNC_OFFLINE', 'E_SYNC_RELAY_FAILED'])

const logUsageFailure = changeLogger('W_SYNC_USAGE_FAILED')

export function readingFailure(code: string): UsageReading {
  // A relay from before `usage` does not know the message.
  const why: UsageWhy = OFFLINE.has(code)
    ? 'offline'
    : code === 'E_SYNC_BAD_MESSAGE'
      ? 'old'
      : 'failed'
  return { state: 'unavailable', why, code }
}

export async function readUsage(): Promise<UsageReading> {
  let failed: UsageReading
  try {
    const usage = readRelayUsage(await invoke<unknown>('sync_usage'))
    if (usage) {
      logUsageFailure(undefined)
      return { state: 'ready', view: viewStorage(usage) }
    }
    failed = readingFailure('E_SYNC_PROTOCOL')
  } catch (e) {
    failed = readingFailure(errorCode(e))
  }
  if (failed.state === 'unavailable') logUsageFailure(failed.code)
  return failed
}

/** Reads the usage while `active`, again whenever `again` changes; null until the first answer. */
export function useRelayUsage(active: boolean, again: string): UsageReading | null {
  const [reading, setReading] = useState<UsageReading | null>(null)
  useEffect(() => {
    if (!active) return
    let current = true
    void readUsage().then((next) => {
      if (current) setReading(next)
    })
    return () => {
      current = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each new `again` reads the usage again.
  }, [active, again])
  return active ? reading : null
}

const SEEN_KEY = 'devot.syncUsageSeen'
const FILLS: readonly Fill[] = ['ok', 'warn', 'full']

function seenByRelay(): Map<string, unknown> {
  const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(SEEN_KEY) ?? 'null')
  return typeof stored === 'object' && stored !== null
    ? new Map(Object.entries(stored))
    : new Map<string, unknown>()
}

/** The bands last told for this relay; nothing if none were, or storage is unreadable. */
function seenFor(relay: string): Seen {
  try {
    const entry = seenByRelay().get(relay)
    if (typeof entry !== 'object' || entry === null) return NOTHING_SEEN
    const s = entry as Record<string, unknown>
    const storage = FILLS.find((fill) => fill === s['storage'])
    const images = FILLS.find((fill) => fill === s['images'])
    return storage && images ? { storage, images } : NOTHING_SEEN
  } catch {
    return NOTHING_SEEN
  }
}

function remember(relay: string, seen: Seen) {
  try {
    const bands = seenByRelay().set(relay, seen)
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(bands)))
  } catch {
    console.warn('W_SYNC_USAGE_NOT_KEPT')
  }
}

const noticeListeners = new Set<() => void>()
let shownNotice: UsageNotice | null = null
const setNotice = (next: UsageNotice | null) => {
  if (next === shownNotice) return
  shownNotice = next
  for (const listener of noticeListeners) listener()
}

export const shownUsageNotice = (): UsageNotice | null => shownNotice

/** Between two readings for the notice; a relay is not asked for its storage on every sync pass. */
export const USAGE_RECHECK_MS = 15 * 60_000

let watchedRelay = ''
let watched = ''
let watchedAt = 0

/**
 * Reads the relay's storage after a sync pass settles, and sets the notice when a cap's band went
 * up from the one last told (`noticeFor`). Cheap to call on every snapshot.
 */
export function watchUsage(snapshot: SyncSnapshot, now = Date.now()): void {
  const { state, code, unsyncedFiles } = snapshot.status
  const relay = snapshot.enabled && snapshot.enrolled ? snapshot.relayUrl : ''
  if (relay !== watchedRelay) {
    watchedRelay = relay
    watched = ''
    watchedAt = 0
    setNotice(null)
  }
  if (relay === '') return
  if (state !== 'idle' && state !== 'paused') return
  const key = [snapshot.relayUrl, state, code, unsyncedFiles?.code].join('|')
  if (key === watched && now - watchedAt < USAGE_RECHECK_MS) return
  watched = key
  watchedAt = now
  void readUsage().then((reading) => {
    if (reading.state !== 'ready' || watched !== key) return
    const { notice, seen } = noticeFor(reading.view, seenFor(relay))
    remember(relay, seen)
    setNotice(notice)
  })
}

/** Forgets what was watched, for a new window or a test. */
export function resetUsageWatch(): void {
  watchedRelay = ''
  watched = ''
  watchedAt = 0
  setNotice(null)
}

/** The notice a settled sync pass called for; the caller keeps it until it is dismissed. */
export function useUsageNotice(snapshot: SyncSnapshot): UsageNotice | null {
  useEffect(() => watchUsage(snapshot), [snapshot])
  return useSyncExternalStore(
    (listener) => {
      noticeListeners.add(listener)
      return () => noticeListeners.delete(listener)
    },
    () => shownNotice,
  )
}
