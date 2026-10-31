import { describe, expect, it } from 'vitest'
import { clockTime, lastWrite, markWrite } from './lastWrite'
import { sectionStore } from './sidebarSections'

const memory = () => {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

describe('sectionStore', () => {
  it('remembers the collapsed sections for the window, as a fresh store reads them', () => {
    const storage = memory()
    sectionStore(storage, 'main').save(new Set(['tags']))
    expect([...sectionStore(storage, 'main').load()]).toEqual(['tags'])
    expect([...sectionStore(storage, 'other').load()]).toEqual([])
    sectionStore(storage, 'main').save(new Set())
    expect([...sectionStore(storage, 'main').load()]).toEqual([])
  })

  it('remembers a collapsed Notebooks section like the others', () => {
    const storage = memory()
    sectionStore(storage, 'main').save(new Set(['books', 'agents']))
    expect([...sectionStore(storage, 'main').load()]).toEqual(['books', 'agents'])
  })

  it('reads damaged or unavailable storage as none collapsed', () => {
    const storage = memory()
    storage.setItem('devot.sidebarCollapsed.main', '{"x":1}')
    expect([...sectionStore(storage, 'main').load()]).toEqual([])
    storage.setItem('devot.sidebarCollapsed.main', '["tags","bogus"]')
    expect([...sectionStore(storage, 'main').load()]).toEqual(['tags'])
    expect([...sectionStore(undefined, 'main').load()]).toEqual([])
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect([...sectionStore(broken, 'main').load()]).toEqual([])
    expect(() => sectionStore(broken, 'main').save(new Set(['status']))).not.toThrow()
  })
})

describe('sectionStore notebook folds', () => {
  it('remembers the folded notebooks for the window, apart from the sections', () => {
    const storage = memory()
    sectionStore(storage, 'main').saveBooks(new Set(['b1', 'b2']))
    expect([...sectionStore(storage, 'main').loadBooks()]).toEqual(['b1', 'b2'])
    expect([...sectionStore(storage, 'other').loadBooks()]).toEqual([])
    expect([...sectionStore(storage, 'main').load()]).toEqual([])
    sectionStore(storage, 'main').saveBooks(new Set())
    expect([...sectionStore(storage, 'main').loadBooks()]).toEqual([])
  })

  it('reads damaged or unavailable storage as none folded', () => {
    const storage = memory()
    storage.setItem('devot.sidebarBooksCollapsed.main', '{"x":1}')
    expect([...sectionStore(storage, 'main').loadBooks()]).toEqual([])
    storage.setItem('devot.sidebarBooksCollapsed.main', '["b1",7,null]')
    expect([...sectionStore(storage, 'main').loadBooks()]).toEqual(['b1'])
    expect([...sectionStore(undefined, 'main').loadBooks()]).toEqual([])
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect([...sectionStore(broken, 'main').loadBooks()]).toEqual([])
    expect(() => sectionStore(broken, 'main').saveBooks(new Set(['b1']))).not.toThrow()
  })
})

describe('lastWrite', () => {
  it('keeps the newest write time and writes it as HH:MM:SS', () => {
    const at = new Date(2026, 2, 3, 9, 5, 7).getTime()
    markWrite(at)
    markWrite(at - 1000)
    expect(lastWrite()).toBe(at)
    expect(clockTime(at)).toBe('09:05:07')
  })
})
