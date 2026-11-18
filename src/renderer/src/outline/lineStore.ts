export interface LineStore {
  get(): number
  set(line: number): void
  subscribe(listener: () => void): () => void
}

export function lineStore(initial = 1): LineStore {
  let line = initial
  const listeners = new Set<() => void>()
  return {
    get: () => line,
    set(next) {
      if (next === line) return
      line = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
