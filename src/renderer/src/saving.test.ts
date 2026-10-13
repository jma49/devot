import { describe, expect, it } from 'vitest'
import { createQuitGuard, newProblems, saveProblemsIn } from './saving'

const A = '01920000-0000-7000-8000-00000000000a'
const B = '01920000-0000-7000-8000-00000000000b'

describe('newProblems', () => {
  it('finds the notes that started failing, or fail with another code', () => {
    const before = [{ id: A, code: 'E_STORAGE_SQLITE' }]
    expect(newProblems([], before)).toEqual(before)
    expect(newProblems(before, before)).toEqual([])
    expect(newProblems(before, [...before, { id: B, code: 'E_STORAGE_SQLITE' }])).toEqual([
      { id: B, code: 'E_STORAGE_SQLITE' },
    ])
    expect(newProblems(before, [{ id: A, code: 'E_NOTE_BODY_TOO_LARGE' }])).toEqual([
      { id: A, code: 'E_NOTE_BODY_TOO_LARGE' },
    ])
    expect(newProblems(before, [])).toEqual([])
  })
})

describe('saveProblemsIn', () => {
  it('reads the problems the core worker sends, and ignores its other messages', () => {
    const problems = [{ id: A, code: 'E_STORAGE_SQLITE' }]
    expect(saveProblemsIn({ saveProblems: problems })).toEqual(problems)
    expect(saveProblemsIn({ saveProblems: [] })).toEqual([])
    // The replies to the page's calls come on the same channel.
    expect(saveProblemsIn({ id: 'reply', type: 'RAW', value: [] })).toBeUndefined()
    expect(saveProblemsIn({ saveProblems: 'E_STORAGE_SQLITE' })).toBeUndefined()
    expect(saveProblemsIn(null)).toBeUndefined()
    expect(saveProblemsIn('saveProblems')).toBeUndefined()
  })
})

describe('the quit guard', () => {
  /** A quit's save that could not save note A (what the core's flush rejects with). */
  const failedSave = () => Promise.reject(new Error(`E_NOTE_SAVE_FAILED ${A}`))

  it('lets a quit go on once everything is saved', async () => {
    const guard = createQuitGuard()
    expect(await guard.answer(Promise.resolve())).toBe('exit')
  })

  it('holds the first quit whose save failed, and lets the next one go on', async () => {
    const guard = createQuitGuard()
    guard.update([{ id: A, code: 'E_STORAGE_SQLITE' }])
    expect(await guard.answer(failedSave())).toBe('hold')
    expect(await guard.answer(failedSave())).toBe('exit')
  })

  it('holds a quit whose save failed before any note was reported', async () => {
    // The quit's own save is the first to fail: the guard holds on the
    // save's failure alone, not on what has been reported by then.
    const guard = createQuitGuard()
    expect(await guard.answer(failedSave())).toBe('hold')
    guard.update([{ id: A, code: 'E_STORAGE_SQLITE' }])
    expect(await guard.answer(failedSave())).toBe('exit')
  })

  it('holds a quit whatever its save failed with', async () => {
    const guard = createQuitGuard()
    expect(await guard.answer(Promise.reject(new Error('E_CORE_NOT_READY')))).toBe('hold')
  })

  it('holds a quit again once every note saved in between', async () => {
    const guard = createQuitGuard()
    guard.update([{ id: A, code: 'E_STORAGE_SQLITE' }])
    expect(await guard.answer(failedSave())).toBe('hold')
    guard.update([])
    guard.update([{ id: B, code: 'E_STORAGE_SQLITE' }])
    expect(await guard.answer(failedSave())).toBe('hold')
  })
})
