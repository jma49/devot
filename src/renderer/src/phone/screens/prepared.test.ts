import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../core-client'
import { createPreparedNotes } from './prepared'

const NOTE = '01970000-0000-7000-8000-000000000001'
const STATE = new Uint8Array([1, 2, 3])

function fakeCore() {
  const calls: string[] = []
  const core = {
    hold: async (id: string) => void calls.push(`hold ${id}`),
    unhold: async (id: string) => void calls.push(`unhold ${id}`),
    open: async (id: string) => {
      calls.push(`open ${id}`)
      return { state: STATE }
    },
  } as unknown as Core
  return { core, calls }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('notes prepared on touch-down', () => {
  it('hands the opened note to the editor, which keeps the hold', async () => {
    const { core, calls } = fakeCore()
    const prepared = createPreparedNotes(1500)
    prepared.prepare(core, NOTE)
    expect(prepared.take(core, NOTE)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(prepared.take(core, NOTE)).toBe(STATE)
    expect(prepared.take(core, NOTE)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toStrictEqual([`hold ${NOTE}`, `open ${NOTE}`])
  })

  it('lets a note no tap took go once it expires, or when cleared', async () => {
    const { core, calls } = fakeCore()
    const prepared = createPreparedNotes(1500)
    prepared.prepare(core, NOTE)
    prepared.prepare(core, NOTE)
    await vi.advanceTimersByTimeAsync(1500)
    expect(calls).toStrictEqual([`hold ${NOTE}`, `open ${NOTE}`, `unhold ${NOTE}`])
    expect(prepared.take(core, NOTE)).toBeUndefined()
    prepared.prepare(core, NOTE)
    prepared.clear()
    expect(calls.at(-1)).toBe(`unhold ${NOTE}`)
  })

  it('gives a note only to the core that opened it', async () => {
    const first = fakeCore()
    const second = fakeCore()
    const prepared = createPreparedNotes(1500)
    prepared.prepare(first.core, NOTE)
    await vi.advanceTimersByTimeAsync(0)
    expect(prepared.take(second.core, NOTE)).toBeUndefined()
  })
})
