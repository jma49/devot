import { afterEach, describe, expect, it, vi } from 'vitest'
import { markAllWritesSeen } from './markAllWritesSeen'

afterEach(() => vi.restoreAllMocks())

describe('Mark All Read for agent writes', () => {
  it('marks every note on its own, so one failure leaves the others marked, and reloads after all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const order: string[] = []
    const mark = vi.fn<(noteId: string, writeIds: string[]) => Promise<void>>(async (noteId) => {
      order.push(noteId)
      if (noteId === 'n1') throw new Error('E_NOTE_GONE')
    })
    const reload = vi.fn<() => void>(() => {
      order.push('reload')
    })
    await markAllWritesSeen(
      mark,
      new Map([
        ['n1', ['w1']],
        ['n2', ['w2', 'w3']],
      ]),
      reload,
    )
    expect(mark).toHaveBeenCalledWith('n2', ['w2', 'w3'])
    expect(order).toEqual(['n1', 'n2', 'reload'])
    expect(warn).toHaveBeenCalledExactlyOnceWith('W_AGENT_WRITES_SEEN_FAILED', 'n1', 'E_NOTE_GONE')
  })
})
