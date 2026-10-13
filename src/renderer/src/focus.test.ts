import { describe, expect, it } from 'vitest'
import { focusStore, sidebarStore, windowLabel } from './focus'

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

describe('focusStore', () => {
  it('is off until turned on, and remembers the choice', () => {
    const storage = memoryStorage()
    expect(focusStore(storage, 'main').load()).toBe(false)
    focusStore(storage, 'main').save(true)
    expect(focusStore(storage, 'main').load()).toBe(true)
    focusStore(storage, 'main').save(false)
    expect(focusStore(storage, 'main').load()).toBe(false)
  })

  it('keeps one value per window', () => {
    const storage = memoryStorage()
    focusStore(storage, 'main').save(true)
    expect(focusStore(storage, 'note-2').load()).toBe(false)
    expect([...storage.items.keys()]).toEqual(['devot.focus.main'])
  })

  it('falls back to off when storage is missing or throws', () => {
    expect(focusStore(undefined, 'main').load()).toBe(false)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(focusStore(broken, 'main').load()).toBe(false)
    expect(() => focusStore(broken, 'main').save(true)).not.toThrow()
  })
})

describe('windowLabel', () => {
  it('reads the Tauri window label, or names the main window', () => {
    expect(windowLabel({ metadata: { currentWindow: { label: 'note-2' } } })).toBe('note-2')
    expect(windowLabel(undefined)).toBe('main')
    expect(windowLabel({})).toBe('main')
  })
})

describe('sidebarStore', () => {
  it('shows the sidebar until it is hidden, and remembers the choice per window', () => {
    const storage = memoryStorage()
    expect(sidebarStore(storage, 'main').load()).toBe(false)
    sidebarStore(storage, 'main').save(true)
    expect(sidebarStore(storage, 'main').load()).toBe(true)
    expect(sidebarStore(storage, 'note-2').load()).toBe(false)
    // Its own key: focus mode is a separate choice.
    expect(focusStore(storage, 'main').load()).toBe(false)
    expect([...storage.items.keys()]).toEqual(['devot.sidebarHidden.main'])
    sidebarStore(storage, 'main').save(false)
    expect(sidebarStore(storage, 'main').load()).toBe(false)
  })

  it('shows the sidebar when storage is missing or throws', () => {
    expect(sidebarStore(undefined, 'main').load()).toBe(false)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(sidebarStore(broken, 'main').load()).toBe(false)
    expect(() => sidebarStore(broken, 'main').save(true)).not.toThrow()
  })
})
