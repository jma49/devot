import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import * as counting from '../../../core/noteCounts'
import { COUNTS_DEBOUNCE_MS, CountsPacer, type EditorCounts } from './counts'

function open(doc: string) {
  const reports: EditorCounts[] = []
  let state = EditorState.create({ doc, extensions: EditorState.allowMultipleSelections.of(true) })
  const pacer = new CountsPacer(
    () => state,
    (c) => reports.push(c),
  )
  const dispatch = (spec: TransactionSpec) => {
    const tr = state.update(spec)
    state = tr.state
    if (tr.docChanged || tr.selection) pacer.changed(tr.docChanged)
  }
  return { pacer, dispatch, reports, length: () => state.doc.length }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the count pacer', () => {
  it('reports the note once it is open', () => {
    const { reports } = open('one two\nthree')
    expect(reports).toEqual([])
    vi.advanceTimersByTime(0)
    expect(reports).toEqual([{ words: 3, characters: 11, selection: null }])
  })

  it('counts the selection apart from the note, once the selection has paused', () => {
    const { dispatch, reports } = open('one two three')
    vi.advanceTimersByTime(0)
    dispatch({ selection: EditorSelection.range(0, 7) })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS - 1)
    expect(reports).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(reports.at(-1)).toEqual({
      words: 3,
      characters: 11,
      selection: { words: 2, characters: 6 },
    })
    dispatch({ selection: EditorSelection.cursor(2) })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(reports.at(-1)?.selection).toBeNull()
  })

  it('joins several selected ranges', () => {
    const { dispatch, reports } = open('aa bb cc dd')
    dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(6, 8)]),
    })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(reports.at(-1)?.selection).toEqual({ words: 3, characters: 6 })
  })

  it('counts the whole note once for a burst of keystrokes', () => {
    const count = vi.spyOn(counting, 'noteCounts')
    const { dispatch, reports, length } = open('start')
    vi.advanceTimersByTime(0)
    count.mockClear()
    for (let i = 0; i < 200; i++) {
      dispatch({ changes: { from: length(), insert: ' word' } })
      vi.advanceTimersByTime(20)
    }
    expect(count).not.toHaveBeenCalled()
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(count).toHaveBeenCalledTimes(1)
    expect(reports.at(-1)?.words).toBe(201)
  })

  it('does not count the note again for a selection change alone', () => {
    const count = vi.spyOn(counting, 'noteCounts')
    const { dispatch } = open('one two three')
    vi.advanceTimersByTime(0)
    count.mockClear()
    dispatch({ selection: EditorSelection.range(0, 3) })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(count).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalledWith('one')
  })

  it('measures nothing while nobody wants the counts', () => {
    const count = vi.spyOn(counting, 'noteCounts')
    let wanted = false
    const reports: EditorCounts[] = []
    const state = EditorState.create({ doc: 'one two' })
    const pacer = new CountsPacer(
      () => state,
      (c) => reports.push(c),
      () => wanted,
    )
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(count).not.toHaveBeenCalled()
    wanted = true
    pacer.changed(false)
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(reports).toEqual([{ words: 2, characters: 6, selection: null }])
  })

  it('reports nothing once stopped', () => {
    const { pacer, dispatch, reports } = open('one')
    pacer.stop()
    dispatch({ changes: { from: 0, insert: 'x' } })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(reports).toEqual([])
  })

  it('takes keystrokes in a long note within a budget', (context) => {
    const { dispatch, length } = open('word '.repeat(200_000))
    const start = performance.now()
    for (let i = 0; i < 200; i++) dispatch({ changes: { from: length(), insert: 'x' } })
    expectWithinBudget(context, performance.now() - start, 400)
  })
})
