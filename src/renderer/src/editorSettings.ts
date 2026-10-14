// The editor settings in this window (see src/core/editorSettings.ts). Rust
// keeps them (src-tauri/src/editor_settings.rs); after every change it sends
// `devot://editor-settings-changed` with the full settings to every window,
// which re-sends it in the page as `devot:editor-settings-changed` (the UI
// tests send that one). Font, size, weight and line height reach the editor as CSS
// variables on the root element, set through CSSOM (the CSP allows no
// inline styles); the rest reconfigure the editor (editor/settings.ts).
import { useSyncExternalStore } from 'react'
import {
  DEFAULT_EDITOR_SETTINGS,
  checkEditorSettingsPatch,
  parseEditorSettings,
  stepFontSize,
  type EditorSettings,
} from '../../core/editorSettings'
import { fontStack, syncImportedFont } from './fonts'
import { sizes } from './theme/tokens'
import { createSyncedStore } from './syncedStore'
import { invoke } from './ipc'

export const EDITOR_SETTINGS_CHANGED = 'devot:editor-settings-changed'
const TAURI_EVENT = 'devot://editor-settings-changed'

/** The type scale's preview size in pixels (what a preview scale of 1 is). */
const PREVIEW_BASE_SIZE = parseFloat(sizes['font.size.preview'])

export interface StyleTarget {
  setProperty(name: string, value: string): void
}

/** Sets the CSS variables the editor's theme reads. */
export function applyEditorStyle(settings: EditorSettings, style: StyleTarget): void {
  style.setProperty('--editor-font-size', `${settings.fontSize}px`)
  style.setProperty('--editor-font-weight', settings.fontWeight)
  // The preview's own size: 1 is the type scale's preview size.
  style.setProperty('--preview-scale', String(settings.previewFontSize / PREVIEW_BASE_SIZE))
  style.setProperty('--editor-line-height', String(settings.lineHeight))
  style.setProperty('--editor-font-family', fontStack(settings))
}

/** A snapshot from Rust: the settings and their revision (higher is newer). */
export interface EditorSettingsSnapshot {
  revision: number
  settings: EditorSettings
}

/** A snapshot from an answer or an event; undefined for anything else. */
export function readSnapshot(value: unknown): EditorSettingsSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { revision, settings } = value as Record<string, unknown>
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
    return undefined
  return { revision, settings: parseEditorSettings(settings) }
}

/** Where the page keeps the newest snapshot it knows, for a reload. */
const SESSION_KEY = 'devot.editorSettings'

interface SessionStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const session = (): SessionStore | undefined =>
  (globalThis as { sessionStorage?: SessionStore }).sessionStorage

/** Keeps a snapshot for a reload of this page; storage may be unavailable. */
function remember(snapshot: EditorSettingsSnapshot) {
  try {
    session()?.setItem(SESSION_KEY, JSON.stringify(snapshot))
  } catch {
    // Without it a reload starts from the settings the window was built with.
  }
}

/**
 * The snapshot kept before this page was reloaded (a backup restore reloads
 * it). Only a reload reads it: a new window or app launch starts from what
 * Rust hands it, and revisions count from 0 again in each launch.
 */
function remembered(): EditorSettingsSnapshot | undefined {
  try {
    const [entry] = performance.getEntriesByType('navigation') as { type?: string }[]
    if (entry?.type !== 'reload') return undefined
    const raw = session()?.getItem(SESSION_KEY)
    return raw ? readSnapshot(JSON.parse(raw)) : undefined
  } catch {
    return undefined
  }
}

/** The newer of two snapshots (either may be missing). */
const newer = (a?: EditorSettingsSnapshot, b?: EditorSettingsSnapshot) =>
  !a || (b && b.revision > a.revision) ? b : a

/**
 * The settings the window was built with, which Rust hands the main window's
 * page before its scripts run (`editor_settings::initial_script`), so the
 * first paint matches the window (an opaque sidebar, the editor's font).
 * Rust hands every load the settings read at launch, so after a reload the
 * snapshot this page kept wins when it is newer.
 */
const initial = newer(
  readSnapshot((globalThis as { devotInitialEditorSettings?: unknown }).devotInitialEditorSettings),
  remembered(),
)

/** The stored settings with this window's changes on top (see syncedStore.ts). */
const store = createSyncedStore<EditorSettings, Partial<EditorSettings>>({
  initial: initial
    ? { revision: initial.revision, value: initial.settings }
    : { revision: -1, value: { ...DEFAULT_EDITOR_SETTINGS } },
  apply: (settings, patch) => ({ ...settings, ...patch }),
  same: (a, b) => (Object.keys(a) as (keyof EditorSettings)[]).every((k) => a[k] === b[k]),
  confirmed: ({ revision, value }) => remember({ revision, settings: value }),
})

/** A snapshot from an answer or an event, as the store takes it. */
const reported = (snapshot: EditorSettingsSnapshot | undefined) =>
  snapshot && { revision: snapshot.revision, value: snapshot.settings }

/** The settings in effect in this window. */
export function editorSettings(): EditorSettings {
  return store.current()
}

/** Calls `notify` after every change of the settings in effect. */
export function subscribeEditorSettings(notify: () => void): () => void {
  return store.subscribe(notify)
}

/** The settings in effect, re-rendering on every change. */
export function useEditorSettings(): EditorSettings {
  return useSyncExternalStore(subscribeEditorSettings, editorSettings)
}

/** One setting, re-rendering only when it changes. */
export function useEditorSetting<K extends keyof EditorSettings>(key: K): EditorSettings[K] {
  return useSyncExternalStore(subscribeEditorSettings, () => store.current()[key])
}

let started = false
/** Settles once the stored settings have been read (or could not be). */
let loaded: Promise<void> = Promise.resolve()

/**
 * Reads the stored settings, follows changes made in any window, and keeps
 * the CSS variables on `style` (the root element's) up to date. Once per page.
 */
export function startEditorSettings(style: StyleTarget = document.documentElement.style): void {
  if (started) return
  started = true
  const apply = () => {
    applyEditorStyle(store.current(), style)
    syncImportedFont(store.current())
  }
  apply()
  subscribeEditorSettings(apply)
  window.addEventListener(EDITOR_SETTINGS_CHANGED, (e) =>
    store.confirm(reported(readSnapshot((e as CustomEvent<unknown>).detail))),
  )
  loaded = invoke<unknown>('editor_settings_get').then(
    (stored) => store.confirm(reported(readSnapshot(stored))),
    () => console.warn('W_EDITOR_SETTINGS_READ_FAILED'),
  )
  if (!DEVOT_UI_TEST) {
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(TAURI_EVENT, (e) =>
          window.dispatchEvent(new CustomEvent(EDITOR_SETTINGS_CHANGED, { detail: e.payload })),
        ),
      )
      .catch(() => console.warn('W_EDITOR_SETTINGS_LISTEN_FAILED'))
  }
}

/**
 * Changes some settings: they apply here at once and stay on top of what
 * Rust reports until Rust has answered, then Rust stores them and tells
 * every window. When storing fails the change is dropped (the stored
 * settings show again) and the error (a code) is thrown.
 */
export function changeEditorSettings(patch: Partial<EditorSettings>): Promise<EditorSettings> {
  const checked = checkEditorSettingsPatch(patch)
  return store.change(checked, async (sent) =>
    reported(readSnapshot(await invoke<unknown>('editor_settings_set', { patch: sent }))),
  )
}

/**
 * Cmd+= (1), Cmd+- (-1) and Cmd+0 (0, the default size), from the stored
 * size once it has been read.
 */
export async function stepEditorFontSize(delta: 1 | -1 | 0): Promise<void> {
  await loaded
  const now = store.current().fontSize
  const size = delta === 0 ? DEFAULT_EDITOR_SETTINGS.fontSize : stepFontSize(now, delta)
  if (size === now) return
  await changeEditorSettings({ fontSize: size }).catch(() =>
    console.warn('W_EDITOR_SETTINGS_SAVE_FAILED'),
  )
}
