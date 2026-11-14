import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import * as counting from '../../../core/noteCounts'
import type { NoteCounts } from '../../../core/noteCounts'
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

  it('reports the word goal the front matter sets, as it changes', () => {
    const { dispatch, reports } = open('---\nword-goal: 500\n---\none two')
    vi.advanceTimersByTime(0)
    expect(reports.at(-1)).toEqual({ words: 2, characters: 6, selection: null, goal: 500 })
    dispatch({ changes: { from: 15, to: 18, insert: '1200' } })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(reports.at(-1)?.goal).toBe(1200)
    dispatch({ changes: { from: 0, to: 3, insert: '' } })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(reports.at(-1)).not.toHaveProperty('goal')
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

describe('a count pacer counting off the page', () => {
  // A counter that answers when told, as the core worker does.
  function offPage(doc: string) {
    const asked: { text: string; answer: (c: NoteCounts) => void; fail: () => void }[] = []
    const count = (text: string) =>
      new Promise<NoteCounts>((answer, reject) =>
        asked.push({ text, answer, fail: () => reject(new Error('E_TEST')) }),
      )
    const reports: EditorCounts[] = []
    let state = EditorState.create({ doc })
    const pacer = new CountsPacer(
      () => state,
      (c) => reports.push(c),
      () => true,
      count,
    )
    const dispatch = (spec: TransactionSpec) => {
      const tr = state.update(spec)
      state = tr.state
      if (tr.docChanged || tr.selection) pacer.changed(tr.docChanged)
    }
    return { asked, reports, dispatch }
  }

  it('reports once the counter answers, and never counts on the page', async () => {
    const count = vi.spyOn(counting, 'noteCounts')
    const { asked, reports } = offPage('one two')
    vi.advanceTimersByTime(0)
    expect(asked.map((a) => a.text)).toEqual(['one two'])
    expect(reports).toEqual([])
    asked[0]!.answer({ words: 2, characters: 6 })
    await vi.waitFor(() => expect(reports).toEqual([{ words: 2, characters: 6, selection: null }]))
    expect(count).not.toHaveBeenCalled()
  })

  it('drops an answer for text that has changed since', async () => {
    const { asked, reports, dispatch } = offPage('one')
    vi.advanceTimersByTime(0)
    dispatch({ changes: { from: 3, insert: ' two' } })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    asked[0]!.answer({ words: 1, characters: 3 })
    asked[1]!.answer({ words: 2, characters: 6 })
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    await Promise.resolve()
    expect(reports).toEqual([{ words: 2, characters: 6, selection: null }])
  })

  it('counts the note again at the next pause after a count failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { asked, reports, dispatch } = offPage('one')
    vi.advanceTimersByTime(0)
    asked[0]!.fail()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('W_COUNTS_FAILED'))
    dispatch({ selection: { anchor: 1 } })
    vi.advanceTimersByTime(COUNTS_DEBOUNCE_MS)
    expect(asked.map((a) => a.text)).toEqual(['one', 'one'])
    asked[1]!.answer({ words: 1, characters: 3 })
    await vi.waitFor(() => expect(reports).toEqual([{ words: 1, characters: 3, selection: null }]))
  })
})
