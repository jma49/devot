// Automatic updates in a window (see src-tauri/src/updates.rs): the status
// Rust holds, what the main window's notice and Settings > General show for
// it, and the commands that check, download and restart.
//
// Rust sends `devot://update-status` with the status and a revision to every
// window after each change, which the page re-sends as `devot:update-status`
// (the UI tests send that one). An older revision never replaces a newer one.
import { useSyncExternalStore } from 'react'
import { currentLocale, format, t, type MessageKey } from './i18n'
import { invoke } from './ipc'
import { isLicenceDate } from './licence'
import { licenceDate } from './licenceView'

export const UPDATE_STATUS = 'devot:update-status'
const TAURI_EVENT = 'devot://update-status'

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'upToDate' }
  | { state: 'available'; version: string }
  /** The licence ends before this update's release: Renew, Download Anyway or Skip This Version. */
  | { state: 'notCovered'; version: string; updatesUntil: string }
  | { state: 'downloading'; version: string; percent: number | null }
  | { state: 'ready'; version: string }
  | { state: 'failed'; code: string }

export type UpdateStatus = UpdateState & {
  revision: number
  current: string
  enabled: boolean
  askedBy: string | null
}

const UNKNOWN: UpdateStatus = {
  revision: -1,
  current: '',
  enabled: false,
  askedBy: null,
  state: 'idle',
}

const CODE = /^E_[A-Z0-9_]+$/
// A version as the feed and Cargo write it (semver, optionally with a
// prerelease and build part); shown in the UI, so nothing else gets through.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function readUpdateStatus(value: unknown): UpdateStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const revision = v['revision']
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return
  const version = (x: unknown): x is string => typeof x === 'string' && VERSION.test(x)
  const base = {
    revision,
    current: version(v['current']) ? v['current'] : '',
    enabled: v['enabled'] === true,
    askedBy: typeof v['askedBy'] === 'string' ? v['askedBy'] : null,
  }
  switch (v['state']) {
    case 'idle':
    case 'checking':
    case 'upToDate':
      return { ...base, state: v['state'] }
    case 'available':
    case 'ready':
      return version(v['version'])
        ? { ...base, state: v['state'], version: v['version'] }
        : undefined
    case 'notCovered':
      return version(v['version']) && isLicenceDate(v['updatesUntil'])
        ? {
            ...base,
            state: 'notCovered',
            version: v['version'],
            updatesUntil: v['updatesUntil'],
          }
        : undefined
    case 'downloading': {
      if (!version(v['version'])) return undefined
      const p = v['percent']
      const percent = typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 100 ? p : null
      return { ...base, state: 'downloading', version: v['version'], percent }
    }
    case 'failed':
      return typeof v['code'] === 'string' && CODE.test(v['code'])
        ? { ...base, state: 'failed', code: v['code'] }
        : undefined
    default:
      return undefined
  }
}

export interface UpdateNoticeModel {
  /** Changes with what the notice is about, so a dismissed one stays dismissed. */
  key: string
  text: string
  action: 'download' | 'restart' | 'notCovered' | null
}

const downloadingText = (version: string, percent: number | null) =>
  percent === null
    ? format(t('updates.downloading'), { version })
    : format(t('updates.downloadingPercent'), {
        version,
        percent: String(percent),
      })

const notCoveredText = (version: string, updatesUntil: string) =>
  format(t('updates.notCovered'), {
    version,
    date: licenceDate(updatesUntil, currentLocale()),
  })

const failureText = (code: string) =>
  code === 'E_UPDATE_UNAVAILABLE' ? t('updates.unavailable') : format(t('updates.failed'), { code })

/**
 * The notice the window labelled `window` shows for `status`, or null: an
 * update to download or restart into, and the progress and outcome of a
 * check the window asked for itself (downloading, up to date, or a failure).
 */
export function updateNotice(status: UpdateStatus, window: string): UpdateNoticeModel | null {
  const mine = status.askedBy === window
  switch (status.state) {
    case 'available':
      return {
        key: `available:${status.version}`,
        text: format(t('updates.available'), { version: status.version }),
        action: 'download',
      }
    case 'notCovered':
      return {
        key: `notCovered:${status.version}`,
        text: notCoveredText(status.version, status.updatesUntil),
        action: 'notCovered',
      }
    case 'downloading':
      return mine
        ? {
            key: `downloading:${status.version}`,
            text: downloadingText(status.version, status.percent),
            action: null,
          }
        : null
    case 'ready':
      return {
        key: `ready:${status.version}`,
        text: format(t('updates.ready'), { version: status.version }),
        action: 'restart',
      }
    case 'upToDate':
      return mine
        ? {
            key: `upToDate:${status.revision}`,
            text: format(t('updates.upToDate'), { version: status.current }),
            action: null,
          }
        : null
    case 'failed':
      return mine
        ? {
            key: `failed:${status.revision}`,
            text: failureText(status.code),
            action: null,
          }
        : null
    default:
      return null
  }
}

export function updateStatusText(status: UpdateStatus): string {
  const version = format(t('generalSettings.version'), {
    version: status.current,
  })
  const line = (key: MessageKey, values: Record<string, string> = {}) => format(t(key), values)
  switch (status.state) {
    case 'checking':
      return line('updates.checking')
    case 'upToDate':
      return line('updates.upToDate', { version: status.current })
    case 'available':
      return line('updates.available', { version: status.version })
    case 'notCovered':
      return notCoveredText(status.version, status.updatesUntil)
    case 'downloading':
      return downloadingText(status.version, status.percent)
    case 'ready':
      return line('updates.ready', { version: status.version })
    case 'failed':
      return failureText(status.code)
    default:
      return status.current ? version : ''
  }
}

let current: UpdateStatus = UNKNOWN
const listeners = new Set<() => void>()

/** Takes a status in unless it is the one shown or older. */
function take(next: UpdateStatus | undefined): void {
  if (!next || next.revision <= current.revision) return
  current = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let started = false

export function startUpdateStatus(): void {
  if (started) return
  started = true
  window.addEventListener(UPDATE_STATUS, (e) =>
    take(readUpdateStatus((e as CustomEvent<unknown>).detail)),
  )
  invoke<unknown>('update_status').then(
    (status) => take(readUpdateStatus(status)),
    () => console.warn('W_UPDATE_STATUS_READ_FAILED'),
  )
  if (!DEVOT_UI_TEST) {
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(TAURI_EVENT, (e) =>
          window.dispatchEvent(new CustomEvent(UPDATE_STATUS, { detail: e.payload })),
        ),
      )
      .catch(() => console.warn('W_UPDATE_STATUS_LISTEN_FAILED'))
  }
}

export function useUpdateStatus(): UpdateStatus {
  return useSyncExternalStore(subscribe, () => current)
}

/** Checks for an update now; the outcome comes as a status (a failure to ask is only logged). */
export const checkForUpdates = (): Promise<void> =>
  invoke<void>('update_check').catch(() => console.warn('W_UPDATE_CHECK_FAILED'))

export const downloadUpdate = (): Promise<void> => invoke('update_download')

export const skipUpdate = (): Promise<void> => invoke('update_skip')

export const restartToUpdate = (): Promise<void> => invoke('update_restart')
