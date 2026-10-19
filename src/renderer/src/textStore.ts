import { useSyncExternalStore } from 'react'

/**
 * A text that changes often (the open note's Markdown as the editor reports
 * it), kept outside React state: only the components that subscribe render
 * when it changes, so typing renders nothing that does not show the text.
 */
export interface TextStore {
  get(): string
  set(text: string): void
  subscribe(listener: () => void): () => void
}

export function textStore(initial = ''): TextStore {
  let text = initial
  const listeners = new Set<() => void>()
  return {
    get: () => text,
    set(next) {
      if (next === text) return
      text = next
      for (const listener of [...listeners]) listener()
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
