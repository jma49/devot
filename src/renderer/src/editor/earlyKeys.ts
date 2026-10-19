import { keyboardIsFree } from '../focus'
import { isImeKey } from '../ime'

/** Collects the characters typed while nothing has the keyboard, until `stop` returns them. */
export function collectEarlyKeys(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  isFree: () => boolean,
): { stop: () => string } {
  let typed = ''
  const onKey = (event: Event) => {
    const key = event as KeyboardEvent
    if (key.defaultPrevented || key.metaKey || key.ctrlKey || key.altKey) return
    if (key.key.length !== 1 || isImeKey(key) || !isFree()) return
    key.preventDefault()
    typed += key.key
  }
  target.addEventListener('keydown', onKey)
  return {
    stop: () => {
      target.removeEventListener('keydown', onKey)
      return typed
    },
  }
}

const EARLY_KEYS_MS = 3000
let pending: { stop: () => string } | undefined
let expiry: ReturnType<typeof setTimeout> | undefined

/**
 * From New Note until its editor opens, the note has no field to type into: what is typed then is
 * kept for the editor (`takeEarlyKeys`) instead of being lost, and the note left keeps nothing.
 */
export function startEarlyKeys(): void {
  takeEarlyKeys()
  ;(document.activeElement as HTMLElement | null)?.blur()
  pending = collectEarlyKeys(window, keyboardIsFree)
  expiry = setTimeout(takeEarlyKeys, EARLY_KEYS_MS)
}

export function takeEarlyKeys(): string {
  clearTimeout(expiry)
  const typed = pending?.stop() ?? ''
  pending = undefined
  return typed
}
