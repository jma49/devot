import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTE_SORT, NOTE_SORTS, type NoteSort } from '../../core/sort'
import { shownGroups } from './contextMenu'
import { t } from './i18n'
import {
  SORT_MENU,
  datesAction,
  sortAction,
  sortLocales,
  sortStore,
  sortView,
  type SortMenuTarget,
} from './noteSort'

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

const TITLE_AZ: NoteSort = { key: 'title', direction: 'asc' }
const CREATED_OLD: NoteSort = { key: 'created', direction: 'asc' }

describe('sortView', () => {
  it('names All Notes, each notebook, each filter and search results', () => {
    expect(sortView({ search: false, bookId: null, filter: null })).toBe('all')
    expect(sortView({ search: false, bookId: 'b1', filter: null })).toBe('book:b1')
    expect(sortView({ search: false, bookId: null, filter: { kind: 'pinned' } })).toBe(
      'filter:pinned',
    )
    expect(
      sortView({ search: false, bookId: null, filter: { kind: 'status', status: 'on_hold' } }),
    ).toBe('filter:status:on_hold')
    expect(sortView({ search: false, bookId: null, filter: { kind: 'tag', tagId: 't1' } })).toBe(
      'filter:tag:t1',
    )
    expect(sortView({ search: true, bookId: 'b1', filter: { kind: 'pinned' } })).toBe('search')
  })

  it('keys a filter by the filter alone, whatever notebook narrows it', () => {
    expect(sortView({ search: false, bookId: 'b1', filter: { kind: 'tag', tagId: 't1' } })).toBe(
      'filter:tag:t1',
    )
  })
})

describe('sortStore', () => {
  it('starts every library view at the default order, following the default', () => {
    const store = sortStore(memoryStorage())
    expect(store.load('all')).toEqual({ order: DEFAULT_NOTE_SORT, followsDefault: true })
    expect(store.load('book:b1')).toEqual({ order: DEFAULT_NOTE_SORT, followsDefault: true })
  })

  it('remembers an order per view', () => {
    const storage = memoryStorage()
    sortStore(storage).choose('book:b1', TITLE_AZ)
    sortStore(storage).choose('filter:pinned', CREATED_OLD)
    const store = sortStore(storage)
    expect(store.load('book:b1')).toEqual({ order: TITLE_AZ, followsDefault: false })
    expect(store.load('filter:pinned')).toEqual({ order: CREATED_OLD, followsDefault: false })
    expect(store.load('all')).toEqual({ order: DEFAULT_NOTE_SORT, followsDefault: true })
    expect(store.load('book:b2')).toEqual({ order: DEFAULT_NOTE_SORT, followsDefault: true })
  })

  it('makes a view order the default for every view without its own', () => {
    const storage = memoryStorage()
    const store = sortStore(storage)
    store.choose('book:b1', CREATED_OLD)
    store.choose('book:b2', TITLE_AZ)
    store.makeDefault('book:b2')
    expect(store.load('book:b2')).toEqual({ order: TITLE_AZ, followsDefault: true })
    expect(store.load('all')).toEqual({ order: TITLE_AZ, followsDefault: true })
    expect(store.load('filter:tag:t1')).toEqual({ order: TITLE_AZ, followsDefault: true })
    // A view with its own order keeps it.
    expect(store.load('book:b1')).toEqual({ order: CREATED_OLD, followsDefault: false })
    // A view that follows the default follows later changes too.
    store.choose('book:b1', DEFAULT_NOTE_SORT)
    store.makeDefault('book:b1')
    expect(store.load('book:b2')).toEqual({ order: DEFAULT_NOTE_SORT, followsDefault: true })
  })

  it('leaves a view following the default when its current order is picked again', () => {
    const store = sortStore(memoryStorage())
    store.choose('all', DEFAULT_NOTE_SORT)
    expect(store.load('all')).toEqual({ order: DEFAULT_NOTE_SORT, followsDefault: true })
  })

  it('keeps search results in relevance order until another order is picked', () => {
    const storage = memoryStorage()
    const store = sortStore(storage)
    store.choose('all', TITLE_AZ)
    store.makeDefault('all')
    expect(store.load('search')).toEqual({ order: 'relevance', followsDefault: false })
    store.choose('search', CREATED_OLD)
    expect(sortStore(storage).load('search')).toEqual({
      order: CREATED_OLD,
      followsDefault: false,
    })
    store.choose('search', 'relevance')
    expect(store.load('search')).toEqual({ order: 'relevance', followsDefault: false })
    // Search never becomes the default, and relevance is never a library order.
    store.choose('search', CREATED_OLD)
    store.makeDefault('search')
    store.choose('book:b1', 'relevance')
    expect(store.load('all')).toEqual({ order: TITLE_AZ, followsDefault: true })
    expect(store.load('book:b1')).toEqual({ order: TITLE_AZ, followsDefault: true })
  })

  it('ignores stored values it does not know', () => {
    const storage = memoryStorage()
    storage.setItem('devot.sort.default', 'size-asc')
    storage.setItem('devot.sort.view.all', '{"key":"title"}')
    expect(sortStore(storage).load('all')).toEqual({
      order: DEFAULT_NOTE_SORT,
      followsDefault: true,
    })
  })

  it('falls back to the defaults when storage is missing or throws', () => {
    expect(sortStore(undefined).load('all').order).toEqual(DEFAULT_NOTE_SORT)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    const store = sortStore(broken)
    expect(store.load('search').order).toBe('relevance')
    expect(() => store.choose('all', TITLE_AZ)).not.toThrow()
    expect(() => store.makeDefault('all')).not.toThrow()
  })
})

describe('SORT_MENU', () => {
  const lines = (target: SortMenuTarget) =>
    shownGroups(SORT_MENU, target).map((group) =>
      group.map((entry) => {
        const label = t(typeof entry.label === 'function' ? entry.label(target) : entry.label)
        const checked = entry.checked?.(target)
        return checked === undefined ? label : `${label} ${checked ? '[x]' : '[ ]'}`
      }),
    )

  it('lists the six orders, checks the current one, and offers Use as Default', () => {
    expect(
      lines({ order: TITLE_AZ, search: false, followsDefault: false, dates: 'relative' }),
    ).toEqual([
      ['Title (A to Z) [x]', 'Title (Z to A) [ ]'],
      ['Date Updated (Newest First) [ ]', 'Date Updated (Oldest First) [ ]'],
      ['Date Created (Newest First) [ ]', 'Date Created (Oldest First) [ ]'],
      ['Use as Default [ ]'],
      ['Relative Dates [x]', 'Absolute Dates [ ]'],
    ])
    expect(
      lines({ order: DEFAULT_NOTE_SORT, search: false, followsDefault: true, dates: 'relative' }),
    ).toEqual([
      ['Title (A to Z) [ ]', 'Title (Z to A) [ ]'],
      ['Date Updated (Newest First) [x]', 'Date Updated (Oldest First) [ ]'],
      ['Date Created (Newest First) [ ]', 'Date Created (Oldest First) [ ]'],
      ['Use as Default [x]'],
      ['Relative Dates [x]', 'Absolute Dates [ ]'],
    ])
  })

  it('offers relevance for search results, and no default', () => {
    expect(
      lines({ order: 'relevance', search: true, followsDefault: false, dates: 'relative' }),
    ).toEqual([
      ['Relevance [x]'],
      ['Title (A to Z) [ ]', 'Title (Z to A) [ ]'],
      ['Date Updated (Newest First) [ ]', 'Date Updated (Oldest First) [ ]'],
      ['Date Created (Newest First) [ ]', 'Date Created (Oldest First) [ ]'],
      ['Relative Dates [x]', 'Absolute Dates [ ]'],
    ])
  })

  it('checks the date style in use, and maps its items', () => {
    const target: SortMenuTarget = {
      order: TITLE_AZ,
      search: false,
      followsDefault: false,
      dates: 'absolute',
    }
    expect(lines(target).at(-1)).toEqual(['Relative Dates [ ]', 'Absolute Dates [x]'])
    expect(datesAction('dates.relative')).toBe('relative')
    expect(datesAction('dates.absolute')).toBe('absolute')
    expect(datesAction('default')).toBeUndefined()
    expect(sortAction('dates.absolute')).toBeUndefined()
  })

  it('maps every order item to its order', () => {
    for (const order of NOTE_SORTS) {
      const entry = SORT_MENU.flat().find(
        (e) =>
          e.checked?.({ order, search: false, followsDefault: false, dates: 'relative' }) &&
          e.action !== 'default',
      )
      expect(entry && sortAction(entry.action)).toEqual(order)
    }
    expect(sortAction('relevance')).toBe('relevance')
    expect(sortAction('default')).toBeUndefined()
  })
})

describe('sortLocales', () => {
  it('collates in the preferred languages first, then the UI locale', () => {
    expect(sortLocales(['zh-CN', 'en-US'], 'en')).toEqual(['zh-CN', 'en-US', 'en'])
    expect(sortLocales([], 'en')).toEqual(['en'])
  })
})
