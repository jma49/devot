import { describe, expect, it, vi } from 'vitest'
import { noteTally, type NoteTally } from '../../core/noteFacts'
import { tallyNote } from './noteTally'

const coreTallying = () => ({
  noteTally: vi.fn<(markdown: string) => Promise<NoteTally>>((markdown) =>
    Promise.resolve(noteTally(markdown)),
  ),
})

describe('the open note’s tally', () => {
  it('asks the core once for the same text, and again once the text changes', async () => {
    const core = coreTallying()
    const first = tallyNote(core, 'one two')
    expect(tallyNote(core, `one ${'two'}`)).toBe(first)
    expect(await first).toMatchObject({ words: 2, characters: 6 })
    expect((await tallyNote(core, 'one two three')).words).toBe(3)
    expect(core.noteTally).toHaveBeenCalledTimes(2)
  })

  it('keeps each core’s tally apart', () => {
    const one = coreTallying()
    const two = coreTallying()
    void tallyNote(one, 'text')
    void tallyNote(two, 'text')
    expect(one.noteTally).toHaveBeenCalledTimes(1)
    expect(two.noteTally).toHaveBeenCalledTimes(1)
  })

  it('asks again after a tally failed', async () => {
    const core = {
      noteTally: vi
        .fn<(markdown: string) => Promise<NoteTally>>()
        .mockRejectedValueOnce(new Error('E_TEST'))
        .mockResolvedValue(noteTally('text')),
    }
    await expect(tallyNote(core, 'text')).rejects.toThrow('E_TEST')
    expect((await tallyNote(core, 'text')).words).toBe(1)
    expect(core.noteTally).toHaveBeenCalledTimes(2)
  })
})
