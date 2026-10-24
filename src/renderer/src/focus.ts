// Focus mode (only the editor shows) and a hidden sidebar are remembered per
// window. They are view preferences, so they live in the webview's local
// storage, not in the note database.

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } }
}

/** The label of the window this page runs in; `main` outside Tauri. */
export function windowLabel(internals: TauriInternals | undefined): string {
  return internals?.metadata?.currentWindow?.label ?? 'main'
}

/** `main` and the windows File > New Window opens (`main-<n>`; src-tauri/src/main_windows.rs). */
export const isMainLabel = (label: string) => label === 'main' || /^main-[1-9]\d{0,8}$/.test(label)

/** A main window other than the first; it hosts nothing that runs once (the mirror, compaction). */
export const isSecondaryLabel = (label: string) => label !== 'main' && isMainLabel(label)

export function focusStore(storage: KeyValue | undefined, label: string) {
  return windowFlag(storage, `devot.focus.${label}`, 'W_FOCUS_SAVE_FAILED')
}

export function sidebarStore(storage: KeyValue | undefined, label: string) {
  return windowFlag(storage, `devot.sidebarHidden.${label}`, 'W_SIDEBAR_SAVE_FAILED')
}

function windowFlag(storage: KeyValue | undefined, key: string, saveFailed: string) {
  return {
    load(): boolean {
      try {
        return storage?.getItem(key) === '1'
      } catch {
        return false
      }
    },
    save(on: boolean) {
      try {
        storage?.setItem(key, on ? '1' : '0')
      } catch {
        console.warn(saveFailed)
      }
    },
  }
}

/** The label of the window this page runs in. */
export function currentWindowLabel(): string {
  const w = globalThis as Record<string, unknown>
  return windowLabel(w['__TAURI_INTERNALS__'] as TauriInternals | undefined)
}

/**
 * The view preferences of this window: kept in the webview's local storage under the window's
 * label. A window File > New Window opened keeps them for as long as it lives (session storage), so
 * a later window with the same label starts fresh.
 */
export function current<T>(store: (storage: KeyValue | undefined, label: string) => T): T {
  const w = globalThis as { localStorage?: KeyValue; sessionStorage?: KeyValue }
  const label = currentWindowLabel()
  let storage: KeyValue | undefined
  try {
    storage = isSecondaryLabel(label) ? w.sessionStorage : w.localStorage
  } catch {
    storage = undefined
  }
  return store(storage, label)
}

export const currentFocusStore = () => current(focusStore)

export const currentSidebarStore = () => current(sidebarStore)

export function keyboardIsFree(): boolean {
  const active = document.activeElement
  return active === null || active === document.body
}

/**
 * Whether the keyboard is in a text field outside `host` (a title, a tag,
 * the palette): an editor that finishes loading then leaves it there, so
 * what the user types goes where they put it.
 */
export function typingElsewhere(active: Element | null, host: Node | null): boolean {
  if (!active || host?.contains(active)) return false
  const { tagName } = active
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true
  return (active as Partial<HTMLElement>).isContentEditable === true
}
