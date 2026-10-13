// The UI tests' storage adapter (src/renderer/src/storage/memory.ts) keeps
// its records in localStorage. Vitest runs in Node, whose own localStorage
// warns when read without a file, so a test that runs the adapter gives it
// an empty one in memory and puts Node's back afterwards.

// Taken without reading it.
const nodeLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

/** Gives the UI tests' storage adapter an empty localStorage in memory. */
export function useMemoryLocalStorage(): void {
  const items = new Map<string, string>()
  const value = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, text: string) => void items.set(key, text),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true })
}

/** Puts Node's own localStorage back. */
export function restoreLocalStorage(): void {
  if (nodeLocalStorage) Object.defineProperty(globalThis, 'localStorage', nodeLocalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
}
