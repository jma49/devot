import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '../../core'
import type { Properties } from '../../core/propertyTypes'
import {
  NO_SETTINGS,
  editText,
  parseCell,
  readTableSettings,
  tableColumns,
  tableRows,
  tableSettingsStore,
  withFilter,
  type TableSettings,
} from './table'

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

const note = (id: string, more: Partial<NoteSummary> = {}): NoteSummary => ({
  id,
  title: id.toUpperCase(),
  createdAt: 1,
  updatedAt: 1,
  bookId: null,
  status: 'none',
  pinned: false,
  tagIds: [],
  bodyVersion: 0,
  ...more,
})

const notes = [note('a'), note('b'), note('c'), note('d')]
const properties = new Map<string, Properties>([
  ['a', { rating: 3, done: true, due: '2026-02-01' }],
  ['b', { rating: 10, done: false, owner: 'Bo' }],
  ['c', { rating: null, owner: 'ann', labels: ['x', 'y'] }],
])
const noTags = () => []
const ids = (rows: readonly NoteSummary[]) => rows.map((n) => n.id)
const rows = (settings: TableSettings) =>
  ids(
    tableRows(
      notes,
      tableColumns(notes, properties, settings, collator),
      properties,
      settings,
      noTags,
      collator,
    ),
  )

describe('tableColumns', () => {
  it('lists the fields, then properties by how many notes hold them, typed by their values', () => {
    expect(tableColumns(notes, properties, NO_SETTINGS, collator)).toEqual([
      { id: 'field:title', field: 'title' },
      { id: 'field:status', field: 'status' },
      { id: 'field:tags', field: 'tags' },
      { id: 'field:updated', field: 'updated' },
      { id: 'property:rating', key: 'rating', type: 'number' },
      { id: 'property:done', key: 'done', type: 'checkbox' },
      { id: 'property:owner', key: 'owner', type: 'text' },
      { id: 'property:due', key: 'due', type: 'date' },
      { id: 'property:labels', key: 'labels', type: 'list' },
    ])
  })

  it('adds properties made in the table and hides hidden ones, never the title', () => {
    const settings = {
      ...NO_SETTINGS,
      added: ['zeta', 'owner'],
      hidden: ['field:title', 'property:rating', 'field:tags'],
    }
    expect(tableColumns(notes, properties, settings, collator).map((c) => c.id)).toEqual([
      'field:title',
      'field:status',
      'field:updated',
      'property:done',
      'property:owner',
      'property:due',
      'property:labels',
      'property:zeta',
    ])
  })
})

describe('tableRows', () => {
  it('keeps the view order without a sort', () => {
    expect(rows(NO_SETTINGS)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('sorts numbers by value and text by the collator, empty cells last both ways', () => {
    const rating = { ...NO_SETTINGS, sort: { column: 'property:rating', descending: false } }
    expect(rows(rating)).toEqual(['a', 'b', 'c', 'd'])
    expect(rows({ ...rating, sort: { column: 'property:rating', descending: true } })).toEqual([
      'b',
      'a',
      'c',
      'd',
    ])
    const owner = { ...NO_SETTINGS, sort: { column: 'property:owner', descending: false } }
    expect(rows(owner)).toEqual(['c', 'b', 'a', 'd'])
  })

  it('filters on filled, empty, checked and unchecked cells', () => {
    expect(rows(withFilter(NO_SETTINGS, 'property:rating', 'filled'))).toEqual(['a', 'b'])
    expect(rows(withFilter(NO_SETTINGS, 'property:rating', 'empty'))).toEqual(['c', 'd'])
    expect(rows(withFilter(NO_SETTINGS, 'property:done', 'checked'))).toEqual(['a'])
    expect(rows(withFilter(NO_SETTINGS, 'property:done', 'unchecked'))).toEqual(['b', 'c', 'd'])
    const both = withFilter(
      withFilter(NO_SETTINGS, 'property:owner', 'filled'),
      'property:labels',
      'empty',
    )
    expect(rows(both)).toEqual(['b'])
    expect(rows(withFilter(both, 'property:labels', undefined))).toEqual(['b', 'c'])
  })

  it('sorts and filters the fields too', () => {
    const fields = [
      note('a', { status: 'completed', updatedAt: 5, title: '' }),
      note('b', { status: 'active', updatedAt: 9 }),
      note('c', { updatedAt: 1, tagIds: ['t'] }),
    ]
    const sorted = (column: string, descending = false) =>
      ids(
        tableRows(
          fields,
          tableColumns(fields, new Map(), NO_SETTINGS, collator),
          new Map(),
          { ...NO_SETTINGS, sort: { column, descending } },
          (n) => (n.tagIds.length > 0 ? ['Work'] : []),
          collator,
        ),
      )
    expect(sorted('field:updated', true)).toEqual(['b', 'a', 'c'])
    expect(sorted('field:status')).toEqual(['b', 'a', 'c'])
    expect(sorted('field:title')).toEqual(['b', 'c', 'a'])
    expect(sorted('field:tags')).toEqual(['c', 'a', 'b'])
  })
})

describe('cells', () => {
  it('parse what is typed by the column type', () => {
    expect(parseCell('number', ' 4.5 ')).toBe(4.5)
    expect(parseCell('number', 'n/a')).toBe('n/a')
    expect(parseCell('text', '42')).toBe('42')
    expect(parseCell('text', 'a\nb')).toBe('a b')
    expect(parseCell('list', 'a, , b ,c')).toEqual(['a', 'b', 'c'])
    expect(parseCell('list', '  ')).toBeNull()
    expect(parseCell('date', '2026-11-20')).toBe('2026-11-20')
    expect(parseCell('text', '   ')).toBeNull()
  })

  it('start their editor with the value as text', () => {
    expect(editText(['a', 'b'])).toBe('a, b')
    expect(editText(3)).toBe('3')
    expect(editText(null)).toBe('')
    expect(editText(undefined)).toBe('')
  })
})

describe('table settings', () => {
  it('read only what they wrote', () => {
    expect(readTableSettings(null)).toEqual(NO_SETTINGS)
    expect(
      readTableSettings({
        sort: { column: 'property:a', descending: 1 },
        filters: { 'property:a': 'filled', 'property:b': 'nope' },
        hidden: ['field:tags', 3],
        added: 'x',
      }),
    ).toEqual({
      sort: { column: 'property:a', descending: false },
      filters: { 'property:a': 'filled' },
      hidden: ['field:tags'],
      added: [],
    })
  })

  it('keep each view, the last 100 changed, and survive storage that fails', () => {
    const map = new Map<string, string>()
    const store = tableSettingsStore({
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    })
    for (let i = 0; i < 105; i++) store.save(`v${i}`, { ...NO_SETTINGS, hidden: [`field:${i}`] })
    expect(store.load('v104').hidden).toEqual(['field:104'])
    expect(store.load('v5').hidden).toEqual(['field:5'])
    expect(store.load('v4')).toEqual(NO_SETTINGS)
    const broken = tableSettingsStore({
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(broken.load('v')).toEqual(NO_SETTINGS)
    expect(() => broken.save('v', NO_SETTINGS)).not.toThrow()
  })
})
