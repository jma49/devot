// The Format menu in the menu bar (src-tauri/src/format_menu.rs). Some keys
// (Command-I) never reached the page in the app, so the format keys live in
// that menu while the editor has the keyboard, and on macOS a key monitor
// offers keys with Command or Control to that menu before the web view sees
// them. Its keys come from the registry: this sends them to Rust when the
// editor gains the keyboard and takes them away (greying the items out) when
// it loses it (also to another window), so elsewhere a key does what it does
// there (Command-K opens the palette). Keys the user changes (Settings >
// Keyboard Shortcuts) reach the menu at once. A picked item, by mouse or key,
// arrives as `devot://format` with the command's ID and formats the editor's
// selection, unless an input method composes there: the format would end the
// composition and leave its raw text in the note, so it does nothing then
// (`formatCommand`), and the key monitor offers the menu no key while the
// web view has marked text.
//
// A format's key is offered only where the format does something: the editor
// reports the formats that do nothing at the caret (`setInertFormats`, such as
// every inline format in code), and their keys are taken off the menu, so the
// key reaches the editor's other bindings (Command-I selects the parent syntax
// in code).
//
// A format runs once per key press: when the menu has the key, the page
// never sees it (the monitor drops it), so only the menu runs it; when the
// page sees it (no monitor, as on Linux), the editor's keymap runs it and
// stops the key; and should the same key still reach the menu, its event is
// dropped once, as an echo of the format just run. A held key repeats
// through the menu, as menu key equivalents do.
import { invoke } from '../ipc'
import { useEffect, useRef } from 'react'
import type { FormatId } from '../editor/formats'
import { queueMenuCall, syncCommandMenu } from './commandMenu'
import { inEditor, useMenuEvent } from './dispatch'
import {
  formatMenuKeys,
  formatOf,
  isFormatMenuCommand,
  type CommandHandlers,
  type CommandId,
} from './registry'
import { subscribeKeymap } from './shortcutSettings'

export const FORMAT_MENU_EVENT = 'devot://format'
export const FORMAT_MENU_PAGE_EVENT = 'devot:format'
let inert: ReadonlySet<FormatId> = new Set()
let resend: (() => void) | undefined

export function setInertFormats(formats: readonly FormatId[]): void {
  const same = formats.length === inert.size && formats.every((f) => inert.has(f))
  if (same) return
  inert = new Set(formats)
  resend?.()
}

/** A menu event this soon after the editor's keys ran the same format is that key again. */
const ECHO_MS = 500

export interface KeyFormat {
  format: FormatId
  at: number
}

let lastKeyFormat: KeyFormat | undefined

export function formatKeyRan(format: FormatId): void {
  lastKeyFormat = { format, at: performance.now() }
}

export function isEcho(id: CommandId, ran: KeyFormat | undefined, now: number): boolean {
  return ran !== undefined && formatOf(id) === ran.format && now - ran.at < ECHO_MS
}

/**
 * Whether the editor has the keyboard: the focus is in it and this window is
 * the key window (in another window, Settings, the menu keys are not ours).
 */
const editorHasKeyboard = (focused: EventTarget | null = document.activeElement) =>
  document.hasFocus() && inEditor(focused)

export function useFormatMenu(handlers: CommandHandlers) {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  // What Rust was last told (the menu off, or on with these keys). Calls go
  // one after another (with the command items', which get their keys first),
  // so the last one sent is the one that stays; a failed one is sent again
  // on the next change of focus or render.
  const sent = useRef<string | undefined>(undefined)
  const sync = useRef((active: boolean) => {
    // Read-only notes have no format commands: the menu's items would do nothing, so it is off with them.
    const on = active && Object.keys(latest.current).some(isFormatMenuCommand)
    const args = { enabled: on, keys: on ? formatMenuKeys(inert) : {} }
    const said = JSON.stringify(args)
    if (sent.current === said) return
    sent.current = said
    syncCommandMenu()
    queueMenuCall(() => invoke('format_menu_set', args)).catch(() => {
      if (sent.current === said) sent.current = undefined
      console.warn('W_FORMAT_MENU_SET_FAILED')
    })
  })
  // After every render (the editor may have gone with the focus in it), and
  // as the focus moves: at once, from where it is going, so the menu gives a
  // key back as soon as the editor loses the keyboard.
  useEffect(() => sync.current(editorHasKeyboard()))
  useEffect(() => {
    resend = () => sync.current(editorHasKeyboard())
    return () => {
      resend = undefined
    }
  }, [])
  useEffect(() => {
    const focusIn = (e: FocusEvent) => sync.current(editorHasKeyboard(e.target))
    const focusOut = (e: FocusEvent) => sync.current(editorHasKeyboard(e.relatedTarget))
    const windowBlur = () => sync.current(false)
    const windowFocus = () => sync.current(editorHasKeyboard())
    document.addEventListener('focusin', focusIn)
    document.addEventListener('focusout', focusOut)
    window.addEventListener('blur', windowBlur)
    window.addEventListener('focus', windowFocus)
    const keysChanged = subscribeKeymap(() => sync.current(editorHasKeyboard()))
    return () => {
      keysChanged()
      document.removeEventListener('focusin', focusIn)
      document.removeEventListener('focusout', focusOut)
      window.removeEventListener('blur', windowBlur)
      window.removeEventListener('focus', windowFocus)
    }
  }, [])

  useMenuEvent(FORMAT_MENU_EVENT, FORMAT_MENU_PAGE_EVENT, (id) => {
    if (!isFormatMenuCommand(id)) {
      console.warn('W_FORMAT_MENU_COMMAND_UNKNOWN')
      return
    }
    if (!editorHasKeyboard()) return
    // An echo is dropped once; the next pick of the same format runs.
    if (isEcho(id, lastKeyFormat, performance.now())) {
      lastKeyFormat = undefined
      return
    }
    void latest.current[id]?.run()
  })
}
