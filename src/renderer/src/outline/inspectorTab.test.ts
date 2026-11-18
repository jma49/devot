import { describe, expect, it } from 'vitest'
import { inspectorRoute, inspectorTabStore } from './inspectorTab'

const memory = () => {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

describe('the inspector tab', () => {
  it('starts on the outline and remembers the last tab per window', () => {
    const storage = memory()
    expect(inspectorTabStore(storage, 'main').load()).toBe('outline')
    inspectorTabStore(storage, 'main').save('history')
    expect(inspectorTabStore(storage, 'main').load()).toBe('history')
    expect(inspectorTabStore(storage, 'note-a').load()).toBe('outline')
  })

  it('ignores an unknown saved tab and storage that refuses', () => {
    const storage = memory()
    storage.items.set('devot.inspector.tab.main', 'graph')
    expect(inspectorTabStore(storage, 'main').load()).toBe('outline')
    const refusing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(inspectorTabStore(refusing, 'main').load()).toBe('outline')
    expect(() => inspectorTabStore(refusing, 'main').save('info')).not.toThrow()
    expect(inspectorTabStore(undefined, 'main').load()).toBe('outline')
  })
})

describe('a command that asks for an inspector tab', () => {
  it('shows the tab, turning the inspector on first when it is off', () => {
    expect(inspectorRoute({ on: true, room: true })).toBe('show')
    expect(inspectorRoute({ on: false, room: true })).toBe('open')
  })

  it('falls back to what the window did before the inspector when it has no room', () => {
    expect(inspectorRoute({ on: true, room: false })).toBe('fallback')
    expect(inspectorRoute({ on: false, room: false })).toBe('fallback')
  })
})
