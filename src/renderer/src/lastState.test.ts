import { describe, expect, it } from 'vitest'
import {
  clampSelection,
  clampTop,
  lastStateStore,
  parseLastState,
  restorePlan,
  serializeLastState,
  type LastState,
} from './lastState'

const NOTE = '019a0000-0000-7000-8000-000000000001'
const BOOK = '019a0000-0000-7000-8000-0000000000b1'
const TAG = '019a0000-0000-7000-8000-0000000000a1'

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

const full: LastState = {
  view: { kind: 'book', id: BOOK },
  filter: { kind: 'tag', tagId: TAG },
  mode: 'split',
  note: {
    id: NOTE,
    selection: { anchor: 4, head: 12 },
    editorTop: { pos: 120, offset: 7.5 },
    previewTop: 340,
    keyboard: true,
  },
}

describe('parseLastState', () => {
  it('reads back what was written', () => {
    expect(parseLastState(serializeLastState(full))).toEqual(full)
    const bare: LastState = { view: { kind: 'all' }, filter: null, mode: 'edit' }
    expect(parseLastState(serializeLastState(bare))).toEqual(bare)
    const templates: LastState = {
      view: { kind: 'templates' },
      filter: null,
      mode: 'preview',
      note: { id: NOTE, keyboard: false },
    }
    expect(parseLastState(serializeLastState(templates))).toEqual(templates)
  })

  it('reads every filter kind', () => {
    for (const filter of [
      { kind: 'pinned' },
      { kind: 'status', status: 'on_hold' },
      { kind: 'tag', tagId: TAG },
    ] as const) {
      const state = { ...full, filter }
      expect(parseLastState(serializeLastState(state))?.filter).toEqual(filter)
    }
  })

  it('has nothing for missing, damaged or foreign data', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '[]', '"text"', '{}']) {
      expect(parseLastState(raw)).toBeUndefined()
    }
    // A later format this build does not know.
    expect(parseLastState(JSON.stringify({ ...JSON.parse(serializeLastState(full)), v: 2 }))).toBe(
      undefined,
    )
  })

  it('falls back part by part when a part is not valid', () => {
    const stored = JSON.parse(serializeLastState(full)) as Record<string, unknown>
    const parse = (patch: Record<string, unknown>) =>
      parseLastState(JSON.stringify({ ...stored, ...patch }))

    // The view: an unknown kind, the Trash, or a notebook without a proper ID.
    for (const view of [
      { kind: 'trash' },
      { kind: 'search' },
      { kind: 'book' },
      { kind: 'book', id: 'x' },
      { kind: 'book', id: 7 },
      'all',
      null,
    ]) {
      expect(parse({ view })?.view).toEqual({ kind: 'all' })
    }
    // The filter: an unknown kind, status or tag ID.
    for (const filter of [
      { kind: 'status', status: 'later' },
      { kind: 'tag', tagId: '' },
      { kind: 'tag' },
      { kind: 'colour' },
      'pinned',
    ]) {
      expect(parse({ filter })?.filter).toBeNull()
    }
    // The mode.
    for (const mode of ['source', 1, null]) expect(parse({ mode })?.mode).toBe('edit')
    // The note: no proper ID drops it; a bad position drops only that part.
    for (const note of [null, 'x', { id: 'x' }, { id: 3 }, { selection: { anchor: 1, head: 1 } }]) {
      expect(parse({ note })?.note).toBeUndefined()
    }
    const note = stored['note'] as Record<string, unknown>
    const parseNote = (patch: Record<string, unknown>) =>
      parse({ note: { ...note, ...patch } })?.note
    for (const selection of [
      { anchor: -1, head: 2 },
      { anchor: 1.5, head: 2 },
      { anchor: 1 },
      { anchor: '1', head: 2 },
      { anchor: Number.MAX_SAFE_INTEGER + 2, head: 0 },
      7,
    ]) {
      expect(parseNote({ selection })).toEqual({ ...full.note, selection: undefined })
    }
    for (const editorTop of [
      { pos: -1, offset: 0 },
      { pos: 1.5, offset: 0 },
      { pos: 3, offset: Number.NaN },
      { pos: 3, offset: '2' },
      { pos: 3 },
    ]) {
      expect(parseNote({ editorTop })).toEqual({ ...full.note, editorTop: undefined })
    }
    for (const previewTop of [-1, '5', Number.POSITIVE_INFINITY, null]) {
      expect(parseNote({ previewTop })).toEqual({ ...full.note, previewTop: undefined })
    }
    expect(parseNote({ keyboard: 'yes' })?.keyboard).toBe(false)
  })

  it('keeps the parts that are not set out of the result', () => {
    const parsed = parseLastState(
      serializeLastState({ ...full, note: { id: NOTE, keyboard: false } }),
    )
    expect(Object.keys(parsed?.note ?? {})).toEqual(['id', 'keyboard'])
  })
})

describe('lastStateStore', () => {
  it('has nothing until saved, then reads back per window', () => {
    const storage = memoryStorage()
    expect(lastStateStore(storage, 'main').load()).toBeUndefined()
    lastStateStore(storage, 'main').save(full)
    expect(lastStateStore(storage, 'main').load()).toEqual(full)
    expect(lastStateStore(storage, 'note-2').load()).toBeUndefined()
    expect([...storage.items.keys()]).toEqual(['devot.lastState.main'])
  })

  it('has nothing when storage is missing or throws, and saving never throws', () => {
    expect(lastStateStore(undefined, 'main').load()).toBeUndefined()
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(lastStateStore(broken, 'main').load()).toBeUndefined()
    expect(() => lastStateStore(broken, 'main').save(full)).not.toThrow()
  })
})

describe('restorePlan', () => {
  const library = {
    books: new Set([BOOK]),
    tags: new Set([TAG]),
    notes: new Set([NOTE]),
  }

  it('restores the view, its filter and the open note when they all still exist', () => {
    expect(restorePlan(full, library)).toEqual({
      view: full.view,
      filter: full.filter,
      note: full.note,
    })
  })

  it('shows All Notes when the notebook is gone', () => {
    const plan = restorePlan(full, { ...library, books: new Set() })
    expect(plan.view).toEqual({ kind: 'all' })
    expect(plan.filter).toEqual(full.filter)
    expect(plan.note).toEqual(full.note)
  })

  it('drops a filter on a tag that is gone, and keeps the others', () => {
    expect(restorePlan(full, { ...library, tags: new Set() }).filter).toBeNull()
    const pinned = { ...full, filter: { kind: 'pinned' } as const }
    expect(restorePlan(pinned, { ...library, tags: new Set() }).filter).toEqual({ kind: 'pinned' })
  })

  it('opens no note when it is gone, and keeps the view', () => {
    const plan = restorePlan(full, { ...library, notes: new Set() })
    expect(plan.note).toBeUndefined()
    expect(plan.view).toEqual(full.view)
    expect(plan.filter).toEqual(full.filter)
  })

  it('shows Templates without a filter', () => {
    const plan = restorePlan({ ...full, view: { kind: 'templates' } }, library)
    expect(plan.view).toEqual({ kind: 'templates' })
    expect(plan.filter).toBeNull()
  })
})

describe('clampSelection', () => {
  it('keeps a selection inside the document', () => {
    expect(clampSelection({ anchor: 2, head: 5 }, 10)).toEqual({ anchor: 2, head: 5 })
    expect(clampSelection({ anchor: 8, head: 50 }, 10)).toEqual({ anchor: 8, head: 10 })
    expect(clampSelection({ anchor: 40, head: 30 }, 10)).toEqual({ anchor: 10, head: 10 })
    expect(clampSelection({ anchor: 3, head: 3 }, 0)).toEqual({ anchor: 0, head: 0 })
  })
})

describe('clampTop', () => {
  it('keeps a top line inside the document', () => {
    expect(clampTop({ pos: 4, offset: 12 }, 10)).toEqual({ pos: 4, offset: 12 })
    expect(clampTop({ pos: 500, offset: 7 }, 10)).toEqual({ pos: 10, offset: 7 })
    expect(clampTop({ pos: 3, offset: 0 }, 0)).toEqual({ pos: 0, offset: 0 })
  })
})
