// The menu bar's items that run a registry command (View > Revision
// History..., Command Palette..., Hide Sidebar, Synced Scrolling;
// `NATIVE_MENU_COMMANDS`).
// Rust builds them with the commands' default keys; this gives them the keys
// in effect whenever those change (Settings > Keyboard Shortcuts), through
// `command_menu_set` (main window only).
//
// Calls that set native menu keys (these items' and the Format menu's) run
// one after another, and the Format menu asks for these items' keys first
// (`syncCommandMenu`), so a key moved from one of them to a format is never
// on both menus at once.
import { invoke } from '../ipc'
import { useEffect } from 'react'
import { commandMenuKeys, defaultKeys } from './registry'
import { subscribeKeymap } from './shortcutSettings'

let tail: Promise<unknown> = Promise.resolve()

/** Runs `call` after the native menu calls queued before it. */
export function queueMenuCall<T>(call: () => Promise<T>): Promise<T> {
  const run = tail.then(call)
  tail = run.catch(() => undefined)
  return run
}

/** What Rust has: the defaults it built the items with, until told otherwise. */
let sent = JSON.stringify(commandMenuKeys(defaultKeys))

/** Gives the command items the keys in effect, if Rust does not have them yet. */
export function syncCommandMenu(): void {
  const keys = commandMenuKeys()
  const said = JSON.stringify(keys)
  if (said === sent) return
  sent = said
  queueMenuCall(() => invoke('command_menu_set', { keys })).catch(() => {
    // Sent again on the next change, or when the window is in front again.
    if (sent === said) sent = ''
    console.warn('W_COMMAND_MENU_SET_FAILED')
  })
}

/** Keeps the command items' keys the keys in effect, for the window's life. */
export function useCommandMenu() {
  useEffect(() => {
    syncCommandMenu()
    const stop = subscribeKeymap(syncCommandMenu)
    window.addEventListener('focus', syncCommandMenu)
    return () => {
      stop()
      window.removeEventListener('focus', syncCommandMenu)
    }
  }, [])
}
