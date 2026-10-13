import { describe, expect, it } from 'vitest'
import { MAX_RECENT_TEMPLATES, recentTemplates, templateGroups } from './templates'

/** A key-value store like localStorage, in memory. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

const note = (id: string, title: string) => ({ id, title })

describe('recent templates', () => {
  it('keeps the templates used last, newest first, each once, up to a limit', () => {
    const store = recentTemplates(memory())
    expect(store.load()).toEqual([])
    store.use('a')
    store.use('b')
    store.use('a')
    expect(store.load()).toEqual(['a', 'b'])
    for (let i = 0; i < MAX_RECENT_TEMPLATES + 3; i += 1) store.use(`n${i}`)
    expect(store.load()).toHaveLength(MAX_RECENT_TEMPLATES)
    expect(store.load()[0]).toBe(`n${MAX_RECENT_TEMPLATES + 2}`)
  })

  it('reads damaged or missing data as none, and survives a storage that throws', () => {
    expect(recentTemplates(memory({ 'devot.templates.recent': '{oops' })).load()).toEqual([])
    expect(recentTemplates(memory({ 'devot.templates.recent': '[1, "a", null]' })).load()).toEqual([
      'a',
    ])
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {},
    }
    const store = recentTemplates(broken)
    expect(store.load()).toEqual([])
    expect(() => store.use('a')).not.toThrow()
    expect(recentTemplates(undefined).load()).toEqual([])
  })
})

describe('templateGroups', () => {
  const templates = [note('1', 'beta'), note('2', 'Alpha'), note('3', ''), note('4', 'Gamma')]

  it('puts recently used templates first, in the order used, then the rest by title', () => {
    expect(templateGroups(templates, ['4', 'gone', '2'], '', ['en'])).toEqual({
      recent: [note('4', 'Gamma'), note('2', 'Alpha')],
      others: [note('1', 'beta'), note('3', '')],
    })
    expect(templateGroups(templates, [], '', ['en']).others.map((t) => t.id)).toEqual([
      '2',
      '1',
      '4',
      '3',
    ])
  })

  it('filters both groups by title, in any case', () => {
    expect(templateGroups(templates, ['4'], 'A', ['en'])).toEqual({
      recent: [note('4', 'Gamma')],
      others: [note('2', 'Alpha'), note('1', 'beta')],
    })
    expect(templateGroups(templates, ['4'], ' zz ', ['en'])).toEqual({ recent: [], others: [] })
  })
})
