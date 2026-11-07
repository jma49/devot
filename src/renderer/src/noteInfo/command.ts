import { useRef } from 'react'
import { useMenuEvent } from '../commands/dispatch'
import { MENU_ECHO_MS } from '../app/usePanes'

const NOTE_INFO = 'devot:note-info'
const FROM_KEY = 'key'

/** View > Note Info from its key: the summary of the open note opens or closes its card. */
export function requestNoteInfo(): void {
  window.dispatchEvent(new CustomEvent(NOTE_INFO, { detail: FROM_KEY }))
}

/** Runs `toggle` for the key and for the menu item, once for a key press that reaches both. */
export function useNoteInfoCommand(toggle: () => void): void {
  const keyEcho = useRef(-Infinity)
  useMenuEvent('devot://note-info', NOTE_INFO, (detail) => {
    if (detail === FROM_KEY) keyEcho.current = performance.now() + MENU_ECHO_MS
    else if (performance.now() < keyEcho.current) return
    toggle()
  })
}
