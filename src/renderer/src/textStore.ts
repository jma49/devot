import { useSyncExternalStore } from 'react'

/**
 * A text that changes often (the open note's Markdown as the editor reports
 * it), kept outside React state: only the components that subscribe render
 * when it changes, so typing renders nothing that does not show the text.
 */
export interface TextStore {
  get(): string
  /**
   * The text changed and `read` gives it: it is read only when asked for, at
   * most once per change, and subscribers hear of changes once per frame, so
   * typing with nothing showing the text never reads it.
   */
  changed(read: () => string): void
  subscribe(listener: () => void): () => void
}

const animationFrame = (run: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 0)
}

export function textStore(initial = '', nextFrame = animationFrame): TextStore {
  let text = initial
  let unread: (() => string) | undefined
  let telling = false
  const listeners = new Set<() => void>()
  return {
    get() {
      if (unread) {
        text = unread()
        unread = undefined
      }
      return text
    },
    changed(read) {
      unread = read
      if (telling || listeners.size === 0) return
      telling = true
      nextFrame(() => {
        telling = false
        for (const listener of [...listeners]) listener()
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export function useText(store: TextStore): string {
  return useSyncExternalStore(store.subscribe, store.get)
}
