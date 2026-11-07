import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropNote, linkedNoteDiscard } from './linkedNotes'

afterEach(() => {
  vi.restoreAllMocks()
})

function fakeCore(failing?: 'trash' | 'purge') {
  const calls: string[] = []
  const step = (name: 'trash' | 'purge') => async (id: string) => {
    calls.push(`${name} ${id}`)
    if (failing === name) throw new Error('E_STORAGE_WRITE')
  }
  return { calls, core: { trash: step('trash'), purge: step('purge') } }
}

describe('dropNote', () => {
  it('moves the note to the Trash, then purges it from there', async () => {
    const { calls, core } = fakeCore()
    await dropNote(core, 'n1')
    expect(calls).toEqual(['trash n1', 'purge n1'])
  })

  it('logs a failure by the note id alone, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { calls, core } = fakeCore('trash')
    await expect(dropNote(core, 'n1')).resolves.toBeUndefined()
    expect(calls).toEqual(['trash n1'])
    expect(warn).toHaveBeenCalledExactlyOnceWith('W_NOTE_DROP_FAILED', 'n1')
  })
})

describe('linkedNoteDiscard', () => {
  it('drops the note, then runs what the window does after', async () => {
    const { calls, core } = fakeCore()
    const after = vi.fn<(c: typeof core) => Promise<void>>(async () => void calls.push('after'))
    await linkedNoteDiscard(() => core, after)('n1')
    expect(calls).toEqual(['trash n1', 'purge n1', 'after'])
    expect(after).toHaveBeenCalledWith(core)
  })

  it('still runs what comes after a drop that failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { calls, core } = fakeCore('purge')
    await linkedNoteDiscard(
      () => core,
      async () => void calls.push('after'),
    )('n1')
    expect(calls).toEqual(['trash n1', 'purge n1', 'after'])
  })

  it('does nothing before the core has started', async () => {
    const after = vi.fn<() => Promise<void>>()
    await linkedNoteDiscard(() => null, after)('n1')
    expect(after).not.toHaveBeenCalled()
  })

  it('reads the core when it discards, not when it is made', async () => {
    const { calls, core } = fakeCore()
    let current: typeof core | undefined
    const discard = linkedNoteDiscard(() => current)
    current = core
    await discard('n1')
    expect(calls).toEqual(['trash n1', 'purge n1'])
  })
})
