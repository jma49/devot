// The UI tests' storage adapter (storage/memory.ts) keeps records in localStorage. Node's own localStorage
// warns when read without a file, so a test gives the adapter an empty one in memory and restores Node's after.

// Taken without reading it.
const nodeLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

/** A Storage kept in a map, which the test can read as `items`. */
export function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, text: string) => void items.set(key, text),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size
    },
  }
}

export function useMemoryLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  })
}

export function restoreLocalStorage(): void {
  if (nodeLocalStorage) Object.defineProperty(globalThis, 'localStorage', nodeLocalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
}
