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

export function current<T>(store: (storage: KeyValue | undefined, label: string) => T): T {
  const w = globalThis as { localStorage?: KeyValue } & Record<string, unknown>
  let storage: KeyValue | undefined
  try {
    storage = w.localStorage
  } catch {
    storage = undefined
  }
  return store(storage, windowLabel(w['__TAURI_INTERNALS__'] as TauriInternals | undefined))
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
