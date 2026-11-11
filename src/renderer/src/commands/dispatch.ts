import { useEffect, useInsertionEffect, useRef } from 'react'
import { earlyKeysWaiting } from '../editor/earlyKeys'
import { isImeKey } from '../ime'
import { listenHere, unlistenLater } from '../windowEvents'
import { rememberKey } from './keys'
import { windowCommand, type CommandHandlers } from './registry'

/**
 * Whether a modal sheet (a `<dialog>`) is up; window commands wait for it to
 * close. A closing dialog's fading copy (dialogMotion.ts) is not one.
 */
export const sheetOpen = () => document.querySelector('dialog[open]:not([data-closing])') !== null

export function inEditor(element: EventTarget | null): boolean {
  return element instanceof Element && element.closest('[data-devot-part="editor-body"]') !== null
}

function inTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        !['button', 'checkbox', 'radio', 'submit', 'reset', 'range'].includes(target.type)))
  )
}

/**
 * Learns from every key press in the window which character each physical
 * key types (`rememberKey`), so keys with Option or Shift on them are read
 * on the keyboard layout in use. Listens before anything can stop the key.
 */
export function useKeyLayout() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => rememberKey(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

/**
 * Runs the window command a key press asks for, when the window has a
 * handler for it. Keys already handled (the note list's, the editor's), keys
 * an input method composes with (`isImeKey`) and keys pressed while a sheet
 * is up are left alone. A held key runs its command once: its repeats are
 * stopped too, so they do not reach a native menu item with that key (View >
 * Hide Sidebar would toggle on and on).
 */
export function useWindowCommands(handlers: CommandHandlers) {
  useKeyLayout()
  const latest = useRef(handlers)
  useInsertionEffect(() => {
    latest.current = handlers
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeKey(e) || sheetOpen()) return
      const press = {
        code: e.code,
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      }
      const id = windowCommand(press, { inEditor: inEditor(e.target) })
      // Command and an arrow key move the caret in a text field or the editor
      // (seen from here as its shadow root's host, not as editable).
      if (id && e.key.startsWith('Arrow') && (inTextField(e.target) || inEditor(e.target))) return
      // A bare letter is text in a field, or in the new note whose editor is still on its way.
      if (
        id &&
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        (inTextField(e.target) || earlyKeysWaiting())
      )
        return
      const handler = id && latest.current[id]
      if (!handler) return
      e.preventDefault()
      if (!e.repeat) void handler.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Calls `run` when the native menu item behind the Tauri event `tauriEvent`
 * is picked, with the event's payload; the event is re-sent in the page as
 * `pageEvent` (the payload as its `detail`), which tests can dispatch.
 * Nothing runs while a sheet is up, nor while the window is not the one the
 * user is in: Rust sends a menu item's event to the main window whichever
 * window has the keyboard (Settings, or a native panel such as a save
 * panel), and a key pressed there must not act on the notes behind it.
 */
export function useMenuEvent(
  tauriEvent: string,
  pageEvent: string,
  run: (payload: unknown) => void,
) {
  const latest = useRef(run)
  useInsertionEffect(() => {
    latest.current = run
  })
  useEffect(() => {
    const show = (event: Event) => {
      if (!sheetOpen() && document.hasFocus()) {
        latest.current(event instanceof CustomEvent ? event.detail : undefined)
      }
    }
    window.addEventListener(pageEvent, show)
    const unlisten = DEVOT_UI_TEST
      ? undefined
      : unlistenLater(
          listenHere(tauriEvent, (event) =>
            window.dispatchEvent(new CustomEvent(pageEvent, { detail: event.payload })),
          ),
          () => console.warn('W_MENU_LISTEN_FAILED', tauriEvent),
        )
    return () => {
      window.removeEventListener(pageEvent, show)
      unlisten?.()
    }
  }, [tauriEvent, pageEvent])
}
