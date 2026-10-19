// The keyboard shortcuts the user changed, in this window (see keymap.ts).
// Rust keeps them (src-tauri/src/keyboard_shortcuts.rs, in
// `<app data>/keyboard-shortcuts.json`, local to this Mac); after every
// change it sends `devot://keyboard-shortcuts-changed` with all of them to
// every window, which re-sends it in the page as
// `devot:keyboard-shortcuts-changed` (the UI tests send that one). Every
// change of the keys in effect goes to the registry (`setCommandKeys`), so
// whatever binds or shows a key reads it from there; what holds a key of its
// own (the editor's keymaps, native menus, labels) follows `subscribeKeymap`.
import { useSyncExternalStore } from 'react'
import {
  applyPatch,
  effectiveKeymap,
  readOverrides,
  type Keymap,
  type ShortcutOverrides,
  type ShortcutPatch,
} from './keymap'
import { setCommandKeys } from './registry'
import { createSyncedStore } from '../syncedStore'
import { invoke } from '../ipc'

export const KEYBOARD_SHORTCUTS_CHANGED = 'devot:keyboard-shortcuts-changed'
const TAURI_EVENT = 'devot://keyboard-shortcuts-changed'

export interface ShortcutsSnapshot {
  revision: number
  overrides: ShortcutOverrides
}

export function readShortcutsSnapshot(value: unknown): ShortcutsSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { revision, overrides } = value as Record<string, unknown>
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
    return undefined
  return { revision, overrides: readOverrides(overrides) }
}

const sameOverrides = (a: ShortcutOverrides, b: ShortcutOverrides) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

const store = createSyncedStore<ShortcutOverrides, ShortcutPatch>({
  initial: { revision: -1, value: {} },
  apply: applyPatch,
  same: sameOverrides,
})

let keymap: Keymap = effectiveKeymap({})
store.subscribe(() => {
  keymap = effectiveKeymap(store.current())
  setCommandKeys(keymap)
})

const reported = (snapshot: ShortcutsSnapshot | undefined) =>
  snapshot && { revision: snapshot.revision, value: snapshot.overrides }

export function shortcutOverrides(): ShortcutOverrides {
  return store.current()
}

export function currentKeymap(): Keymap {
  return keymap
}

export function subscribeKeymap(notify: () => void): () => void {
  return store.subscribe(notify)
}

export function useKeymap(): Keymap {
  return useSyncExternalStore(subscribeKeymap, currentKeymap)
}

export function useShortcutOverrides(): ShortcutOverrides {
  return useSyncExternalStore(subscribeKeymap, shortcutOverrides)
}

let started = false

export function startShortcutSettings(): void {
  if (started) return
  started = true
  window.addEventListener(KEYBOARD_SHORTCUTS_CHANGED, (e) =>
    store.confirm(reported(readShortcutsSnapshot((e as CustomEvent<unknown>).detail))),
  )
  void invoke<unknown>('keyboard_shortcuts_get').then(
    (stored) => store.confirm(reported(readShortcutsSnapshot(stored))),
    () => console.warn('W_KEYBOARD_SHORTCUTS_READ_FAILED'),
  )
  if (!DEVOT_UI_TEST) {
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(TAURI_EVENT, (e) =>
          window.dispatchEvent(new CustomEvent(KEYBOARD_SHORTCUTS_CHANGED, { detail: e.payload })),
        ),
      )
      .catch(() => console.warn('W_KEYBOARD_SHORTCUTS_LISTEN_FAILED'))
  }
}

/**
 * Changes some commands' keys (null: the defaults again): they apply here at
 * once and stay on top of what Rust reports until Rust has answered; then
 * Rust stores them and tells every window. When storing fails the change is
 * dropped (the stored keys apply again) and the error (a code) is thrown.
 */
export async function changeShortcuts(patch: ShortcutPatch): Promise<void> {
  await store.change(patch, async (sent) =>
    reported(
      readShortcutsSnapshot(await invoke<unknown>('keyboard_shortcuts_set', { patch: sent })),
    ),
  )
}
