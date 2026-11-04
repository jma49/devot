import { describe, expect, it } from 'vitest'
import type { NoteLinkTarget, PreviewOptions, PreviewPiece } from '../../src/core'
import { createLivePreviewRenderer } from '../../src/core/preview/live'

const A = '0192a6f0-0000-7000-8000-00000000000a'
const B = '0192a6f0-0000-7000-8000-00000000000b'

const target = (title: string): NoteLinkTarget => ({
  title,
  status: 'none',
  tasks: { done: 0, total: 0 },
  tags: [],
})

const options = { labels: {} as PreviewOptions['labels'], loadedEmbeds: [] }

function setup(fail = false) {
  const asked: string[][] = []
  const rendered: PreviewOptions[] = []
  let failures = 0
  let failing = fail
  const render = createLivePreviewRenderer({
    renderPieces: async (_markdown, given) => {
      rendered.push(given)
      return [] as PreviewPiece[]
    },
    linkTargets: async (ids) => {
      asked.push([...ids])
      if (failing) throw new Error('E_TEST')
      return Object.fromEntries(ids.map((id) => [id, target(id)]))
    },
    onTargetsFailed: () => (failures += 1),
  })
  return {
    render: (markdown: string, scope = 'note 0') => render(markdown, options, [], scope),
    asked,
    rendered,
    failures: () => failures,
    recover: () => (failing = false),
  }
}

describe('the live preview as the core renders it', () => {
  it('reads task progress, line count and linked notes from the text', async () => {
    const s = setup()
    const result = await s.render(
      `- [x] one\n- [ ] two\n\n[b](devot://note/${B}) [a](devot://note/${A}) [a](devot://note/${A})\n`,
    )
    expect(result.tasks).toEqual({ done: 1, total: 2 })
    expect(result.lines).toBe(5)
    expect(result.links).toEqual([A, B])
    expect(s.rendered[0]?.noteLinks).toEqual({ [A]: target(A), [B]: target(B) })
  })

  it('asks for the linked notes again only when the scope or the links change', async () => {
    const s = setup()
    const one = `[a](devot://note/${A})`
    await s.render(one)
    await s.render(`${one} typed`)
    expect(s.asked).toEqual([[A]])
    await s.render(`${one} [b](devot://note/${B})`)
    await s.render(one, 'note 1')
    expect(s.asked).toEqual([[A], [A, B], [A]])
  })

  it('asks for nothing without links, and renders with no targets', async () => {
    const s = setup()
    const result = await s.render('plain')
    expect(s.asked).toEqual([])
    expect(result.links).toEqual([])
    expect(s.rendered[0]?.noteLinks).toEqual({})
  })

  it('renders without targets that failed, and asks again next time', async () => {
    const s = setup(true)
    const one = `[a](devot://note/${A})`
    await s.render(one)
    expect(s.failures()).toBe(1)
    expect(s.rendered[0]).not.toHaveProperty('noteLinks')
    s.recover()
    await s.render(one)
    expect(s.asked).toEqual([[A], [A]])
    expect(s.rendered[1]?.noteLinks).toEqual({ [A]: target(A) })
  })
})
