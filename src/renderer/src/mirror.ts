// The Markdown mirror in a window (see src/core/mirror.ts and
// src-tauri/src/mirror): what it shows (folder, size, a pause, files kept
// because they were edited outside Devot), its setting, choosing a folder,
// and Rust's side of it for the core worker's passes (main window).
//
// Rust holds the status; after every change it sends `devot://mirror-changed`
// with it and a revision to every window, which re-sends it in the page as
// `devot:mirror-changed` (the UI tests send that one). A window applies its
// own changes at once and keeps them on top until Rust answers (syncedStore.ts).
import { useSyncExternalStore } from 'react'
import type { MirrorHost } from '../../core'
import { countOf } from './format'
import { format, t, type MessageKey } from './i18n'
import { invoke } from './ipc'
import { createSyncedStore, type Revision } from './syncedStore'

export const MIRROR_CHANGED = 'devot:mirror-changed'
const TAURI_EVENT = 'devot://mirror-changed'

export interface MirrorStatus {
  generation: number
  folder: string | null
  includeAttachments: boolean
  paused: string | null
  size: number | null
  /** Files kept under a new name because they were edited outside Devot: the first few... */
  kept: string[]
  /** ...and how many there are. */
  keptCount: number
}

export interface MirrorPatch {
  includeAttachments?: boolean
  turnOff?: true
  dismissKept?: true
}

export const MIRROR_OFF: MirrorStatus = {
  generation: 0,
  folder: null,
  includeAttachments: true,
  paused: null,
  size: null,
  kept: [],
  keptCount: 0,
}

const CODE = /^E_[A-Z0-9_]+$/

export function readStatus(value: unknown): Revision<MirrorStatus> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!count(v['revision']) || !count(v['generation'])) return undefined
  if (v['size'] !== null && !count(v['size'])) return undefined
  const kept = Array.isArray(v['kept']) ? v['kept'].filter((k) => typeof k === 'string') : []
  const keptCount = count(v['keptCount'])
    ? Math.max(v['keptCount'] as number, kept.length)
    : kept.length
  return {
    revision: v['revision'] as number,
    value: {
      generation: v['generation'] as number,
      folder: typeof v['folder'] === 'string' ? v['folder'] : null,
      includeAttachments: v['includeAttachments'] !== false,
      paused: typeof v['paused'] === 'string' && CODE.test(v['paused']) ? v['paused'] : null,
      size: v['size'] as number | null,
      kept,
      keptCount,
    },
  }
}

const store = createSyncedStore<MirrorStatus, MirrorPatch>({
  initial: { revision: -1, value: MIRROR_OFF },
  apply: (status, patch) => ({
    ...status,
    ...(patch.includeAttachments === undefined
      ? {}
      : { includeAttachments: patch.includeAttachments }),
    ...(patch.turnOff ? { folder: null, paused: null, size: null, kept: [], keptCount: 0 } : {}),
    ...(patch.dismissKept ? { kept: [], keptCount: 0 } : {}),
  }),
  same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
})

let started = false

export function startMirrorStatus(): void {
  if (started) return
  started = true
  window.addEventListener(MIRROR_CHANGED, (e) =>
    store.confirm(readStatus((e as CustomEvent<unknown>).detail)),
  )
  invoke<unknown>('mirror_get').then(
    (status) => store.confirm(readStatus(status)),
    () => console.warn('W_MIRROR_READ_FAILED'),
  )
  if (!DEVOT_UI_TEST) {
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(TAURI_EVENT, (e) =>
          window.dispatchEvent(new CustomEvent(MIRROR_CHANGED, { detail: e.payload })),
        ),
      )
      .catch(() => console.warn('W_MIRROR_LISTEN_FAILED'))
  }
}

export const mirrorStatus = (): MirrorStatus => store.current()

/**
 * After a quit was called off: a window that had already answered may have stopped its mirror. A
 * full pass (the stop forgot what it reconciled) starts it again, unless no folder is set.
 */
export function resumeMirrorAfterCancelledQuit(
  core: { mirrorReconcile: (generation?: number) => void },
  status: MirrorStatus = mirrorStatus(),
): void {
  if (status.folder === null) return
  void core.mirrorReconcile(status.generation)
}

export function useMirrorStatus(): MirrorStatus {
  return useSyncExternalStore(store.subscribe, store.current)
}

/**
 * Changes the setting: it shows here at once, then Rust stores it and tells
 * every window. Rejects with Rust's code (the change is dropped).
 */
export function changeMirror(patch: MirrorPatch): Promise<MirrorStatus> {
  return store.change(patch, async (sent) =>
    readStatus(await invoke<unknown>('mirror_set', { patch: sent })),
  )
}

export type FolderChoice =
  | { kind: 'chosen' }
  /** Not empty and no manifest: ask, then `confirmMirrorFolder(token)`. */
  | { kind: 'confirm'; token: number; name: string }
  | { kind: 'cancelled' }

export async function chooseMirrorFolder(): Promise<FolderChoice> {
  const choice = await invoke<Record<string, unknown> | null>('mirror_choose')
  if (choice?.['kind'] === 'chosen') {
    store.confirm(readStatus(choice['status']))
    return { kind: 'chosen' }
  }
  if (choice?.['kind'] === 'confirm' && typeof choice['token'] === 'number') {
    return { kind: 'confirm', token: choice['token'], name: String(choice['name'] ?? '') }
  }
  return { kind: 'cancelled' }
}

export async function confirmMirrorFolder(token: number): Promise<void> {
  store.confirm(readStatus(await invoke<unknown>('mirror_confirm', { token })))
}

export const mirrorHost: MirrorHost = {
  open: (known) => invoke('mirror_open', { known }),
  bodies: (ids) => invoke('mirror_bodies', { ids }),
  files: (ids) => invoke('mirror_files', { ids }),
  hashes: (ids) => invoke('mirror_hashes', { ids }),
  check: (generation, paths) => invoke('mirror_check', { generation, paths }),
  apply: (generation, ops) => invoke('mirror_apply', { generation, ops }),
}

const PAUSED_MESSAGES = new Map<string, MessageKey>([
  ['E_MIRROR_FOLDER_MISSING', 'mirror.pausedMissing'],
  ['E_MIRROR_FOLDER_READ_ONLY', 'mirror.pausedReadOnly'],
  // Without its manifest Devot cannot tell its files from others': the
  // mirror waits for the file to come back or the folder to be chosen again.
  ['E_MIRROR_MANIFEST_MISSING', 'mirror.pausedManifestMissing'],
  ['E_MIRROR_MANIFEST_INVALID', 'mirror.pausedManifestInvalid'],
  ['E_MIRROR_MANIFEST_FOREIGN', 'mirror.pausedManifestForeign'],
])

export function pausedMessage(code: string): string {
  return format(t(PAUSED_MESSAGES.get(code) ?? 'mirror.paused'), { code })
}

const KEPT_SHOWN = 3

export function keptMessage(kept: readonly string[], count: number, locale: string): string {
  const shown = kept.slice(0, KEPT_SHOWN)
  const rest = Math.max(count, kept.length) - shown.length
  const files = new Intl.ListFormat(locale, { type: 'conjunction' }).format([
    ...shown,
    ...(rest > 0
      ? [format(t('mirror.keptMore'), { count: new Intl.NumberFormat(locale).format(rest) })]
      : []),
  ])
  const total = Math.max(count, kept.length)
  return format(countOf(total, locale, 'mirror.keptOne', 'mirror.keptOther'), { files })
}
