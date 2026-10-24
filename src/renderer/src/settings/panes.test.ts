import { describe, expect, it } from 'vitest'
import { PANES, paneAfterKey, paneStore } from './panes'

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

describe('the last pane', () => {
  it('opens on General until a pane is remembered', () => {
    expect(paneStore(memory()).read()).toBe('general')
    expect(paneStore(undefined).read()).toBe('general')
  })

  it('remembers the pane shown last', () => {
    const storage = memory()
    paneStore(storage).write('mirror')
    expect(paneStore(storage).read()).toBe('mirror')
  })

  it('opens a pane remembered under its old name', () => {
    expect(paneStore(memory({ 'devot.settings.pane': 'editor' })).read()).toBe('editing')
  })

  it('falls back to General for a value that names no pane', () => {
    expect(paneStore(memory({ 'devot.settings.pane': 'cloud' })).read()).toBe('general')
  })

  it('works on when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('E_STORAGE')
      },
      setItem: () => {
        throw new Error('E_STORAGE')
      },
    }
    expect(() => paneStore(broken).write('usage')).not.toThrow()
    expect(paneStore(broken).read()).toBe('general')
  })
})

describe('navigation keys', () => {
  it('step through the panes with the Up and Down keys, wrapping at the ends', () => {
    expect(paneAfterKey('general', 'ArrowDown')).toBe('editing')
    expect(paneAfterKey('editing', 'ArrowDown')).toBe('preview')
    expect(paneAfterKey('usage', 'ArrowDown')).toBe('general')
    expect(paneAfterKey('general', 'ArrowUp')).toBe('usage')
    expect(paneAfterKey('general', 'ArrowRight')).toBeUndefined()
  })

  it('lists the panes in the order the column shows them', () => {
    expect(PANES).toEqual([
      'general',
      'editing',
      'preview',
      'appearance',
      'keyboard',
      'mirror',
      'sync',
      'ai',
      'integrations',
      'plugins',
      'usage',
    ])
  })

  it('go to the ends with Home and End, and leave other keys alone', () => {
    expect(paneAfterKey('keyboard', 'Home')).toBe(PANES[0])
    expect(paneAfterKey('keyboard', 'End')).toBe('usage')
    expect(paneAfterKey('keyboard', 'Enter')).toBeUndefined()
  })
})
