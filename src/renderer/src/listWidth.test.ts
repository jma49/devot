import { describe, expect, it } from 'vitest'
import {
  LIST_DEFAULT_WIDTH,
  LIST_MAX_WIDTH,
  LIST_MIN_WIDTH,
  clampListWidth,
  listWidthStore,
} from './listWidth'

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

describe('the note list width', () => {
  it('is 300 px by default, between 220 and 500 px', () => {
    expect(LIST_DEFAULT_WIDTH).toBe(300)
    expect(LIST_MIN_WIDTH).toBe(220)
    expect(LIST_MAX_WIDTH).toBe(500)
  })

  it('stays between its minimum and maximum, in whole pixels', () => {
    expect(clampListWidth(100)).toBe(220)
    expect(clampListWidth(900)).toBe(500)
    expect(clampListWidth(333.6)).toBe(334)
    expect(clampListWidth(Number.NaN)).toBe(300)
    expect(clampListWidth(Number.POSITIVE_INFINITY)).toBe(300)
  })

  it('opens at the default until a width is remembered', () => {
    expect(listWidthStore(memory()).read()).toBe(300)
    expect(listWidthStore(undefined).read()).toBe(300)
  })

  it('remembers the width a drag ended at, clamped', () => {
    const storage = memory()
    listWidthStore(storage).write(412.2)
    expect(storage.items.get('devot.list.width')).toBe('412')
    expect(listWidthStore(storage).read()).toBe(412)
    listWidthStore(storage).write(1200)
    expect(listWidthStore(storage).read()).toBe(500)
  })

  it('clamps or ignores a remembered value it cannot use', () => {
    expect(listWidthStore(memory({ 'devot.list.width': '9999' })).read()).toBe(500)
    expect(listWidthStore(memory({ 'devot.list.width': '12' })).read()).toBe(220)
    expect(listWidthStore(memory({ 'devot.list.width': 'wide' })).read()).toBe(300)
    expect(listWidthStore(memory({ 'devot.list.width': '' })).read()).toBe(300)
  })

  it('works on with storage that fails', () => {
    const broken = {
      getItem: () => {
        throw new Error('off')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(listWidthStore(broken).read()).toBe(300)
    expect(() => listWidthStore(broken).write(400)).not.toThrow()
  })
})
