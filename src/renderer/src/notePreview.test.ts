import { noteIdOf } from '../../core/links'
import { describe, expect, it, vi } from 'vitest'
import { PREVIEW_FRESH_MS, PREVIEW_KEPT, previewLoader, type PreviewCore } from './notePreview'

function setup(known: Record<string, { title: string; excerpt: string }>) {
  const core = {
    linkTargets: vi.fn<PreviewCore['linkTargets']>(async (ids) =>
      Object.fromEntries(
        ids.filter((id) => known[id]).map((id) => [id, { title: known[id]!.title }]),
      ),
    ),
    excerpts: vi.fn<PreviewCore['excerpts']>(async (ids) =>
      Object.fromEntries(ids.filter((id) => known[id]).map((id) => [id, known[id]!.excerpt])),
    ),
  }
  let clock = 0
  const load = previewLoader(core, () => clock)
  return { core, load, advance: (ms: number) => (clock += ms) }
}

describe('note link preview loader', () => {
  it('loads the title and the excerpt', async () => {
    const { load } = setup({ a: { title: 'Groceries', excerpt: 'Milk, eggs' } })
    expect(await load('a')).toEqual({ title: 'Groceries', excerpt: 'Milk, eggs' })
  })

  it('answers null for a note that is gone', async () => {
    const { load } = setup({})
    expect(await load('missing')).toBeNull()
  })

  it('shares a load that runs and reuses a fresh answer', async () => {
    const { core, load, advance } = setup({ a: { title: 'A', excerpt: 'x' } })
    await Promise.all([load('a'), load('a')])
    advance(PREVIEW_FRESH_MS - 1)
    await load('a')
    expect(core.linkTargets).toHaveBeenCalledTimes(1)
    advance(2)
    await load('a')
    expect(core.linkTargets).toHaveBeenCalledTimes(2)
  })

  it('does not keep a failed load', async () => {
    const { core, load } = setup({ a: { title: 'A', excerpt: 'x' } })
    core.linkTargets.mockRejectedValueOnce(new Error('down'))
    await expect(load('a')).rejects.toThrow('down')
    await Promise.resolve()
    expect(await load('a')).toEqual({ title: 'A', excerpt: 'x' })
  })

  it('keeps the most recent previews only', async () => {
    const known = Object.fromEntries(
      Array.from({ length: PREVIEW_KEPT + 1 }, (_, n) => [
        `n${n}`,
        { title: `T${n}`, excerpt: '' },
      ]),
    )
    const { core, load } = setup(known)
    for (const id of Object.keys(known)) await load(id)
    core.linkTargets.mockClear()
    await load('n1')
    expect(core.linkTargets).not.toHaveBeenCalled()
    await load('n0')
    expect(core.linkTargets).toHaveBeenCalledTimes(1)
  })
})

describe('noteIdOf', () => {
  it('names the note of a note address only', () => {
    const id = '0192a6f0-0000-7000-8000-000000000001'
    expect(noteIdOf(`devot://note/${id}`)).toBe(id)
    expect(noteIdOf(`devot://note/${id}/x`)).toBeUndefined()
    expect(noteIdOf('https://example.com')).toBeUndefined()
  })
})
