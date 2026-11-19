import { describe, expect, it, vi } from 'vitest'
import { createPieceRenderer, createPreviewRegistry } from '../../src/core/preview'
import * as definitions from '../../src/core/preview/definitions'
import { labels } from '../support/preview-html'

const options = { labels, loadedEmbeds: [] }
const markdown =
  '# Same\n\nFirst [link][later] and call[^later].\n\n' +
  Array.from({ length: 30 }, (_, i) => `# Same\n\nParagraph ${i}.\n\n`).join('') +
  '[later]: https://example.com\n\n[^later]: A trailing definition.'

describe('head preview pieces', () => {
  it('returns the full cached note instead of a head and another worker request', async () => {
    const render = createPieceRenderer({ pieceLength: 80 })
    const full = await render(markdown, options)
    await render('Another note.', options)
    const warm = await render.head(markdown, options, [], 160)
    expect(warm.partial).toBe(false)
    expect(warm.pieces).toEqual(full)
  })

  it('checks cross-piece definitions before considering a whole note cached', async () => {
    const render = createPieceRenderer({ pieceLength: 1 })
    const first = '[link]: https://first.test\n\n'
    const second = '[link]: https://second.test\n\n'
    const linked = '[Read][link].\n\n'
    const source = first + second + linked
    await render(source, options)
    const changed = second + first + linked
    const head = await render.head(changed, options, [], 1)
    expect(head.partial).toBe(true)
    const full = await render(changed, options)
    expect(JSON.stringify(full)).toContain('https://second.test')
  })

  it('keeps the head budget when options changed or tail pieces were evicted', async () => {
    for (const capacity of [0, 50_000]) {
      const render = createPieceRenderer({ pieceLength: 80, capacity })
      await render(markdown, options)
      await render('Another note.', options)
      const changed = capacity === 0 ? options : { ...options, loadedEmbeds: ['changed'] }
      const head = await render.head(markdown, changed, [], 160)
      expect(head.partial).toBe(true)
      expect(head.pieces.every((piece) => piece.offset < 160)).toBe(true)
    }
  })

  it('parses each piece once across the head and its full answer', async () => {
    const parse = vi.spyOn(definitions, 'parseSeeded')
    try {
      const render = createPieceRenderer({ pieceLength: 80 })
      const head = await render.head(markdown, options, [], 160)
      const calls = parse.mock.calls.length
      expect(calls).toBeGreaterThan(head.pieces.length)
      await render(markdown, options)
      expect(parse).toHaveBeenCalledTimes(calls)
    } finally {
      parse.mockRestore()
    }
  })
  it('keeps full-document references, heading ids, numbering and keys in its prefix', async () => {
    const render = createPieceRenderer({ pieceLength: 80 })
    const head = await render.head(markdown, options, [], 160)
    const saved = structuredClone(head.pieces)
    const full = await render(markdown, options)
    expect(head.partial).toBe(true)
    expect(saved).toEqual(full.slice(0, saved.length))
    expect(saved.every((piece) => piece.offset < 160)).toBe(true)
    expect(saved.at(-1)?.parts).toBeUndefined()
  })

  it('reuses head transforms when the full render follows', async () => {
    const registry = createPreviewRegistry({ builtins: true })
    const transformed: string[] = []
    registry.register({
      id: 'test.count',
      apiVersion: 1,
      transform: (_, context) => {
        transformed.push(context.source)
      },
    })
    const render = createPieceRenderer({ pieceLength: 80, registry })
    const head = await render.head(markdown, options, [], 160)
    const sources = [...transformed]
    await render(
      markdown,
      options,
      head.pieces.map((piece) => piece.key),
    )
    expect(sources.length).toBe(head.pieces.length)
    for (const source of sources)
      expect(transformed.filter((text) => text === source)).toHaveLength(1)
  })

  it.each(['edit', 'options', 'switch', 'close', 'failure'])(
    'discards the prepared tail after %s',
    async (change) => {
      const registry = createPreviewRegistry({ builtins: true })
      let fail = false
      registry.register({
        id: 'test.failure',
        apiVersion: 1,
        transform: () => {
          if (fail) throw new Error('E_TEST_RENDER')
        },
      })
      const render = createPieceRenderer({ pieceLength: 80, registry, capacity: 0 })
      await render.head(markdown, options, [], 160)
      let text = markdown
      let changed = options
      if (change === 'edit') text = markdown.replace('https://example.com', 'https://changed.test')
      if (change === 'options') changed = { ...options, loadedEmbeds: ['changed'] }
      if (change === 'switch') await render('Another note.', options)
      if (change === 'close') render.forgetShown()
      if (change === 'failure') {
        fail = true
        await expect(render(markdown, options)).rejects.toThrow('E_TEST_RENDER')
        fail = false
      }
      const parse = vi.spyOn(definitions, 'parseSeeded')
      try {
        const actual = await render(text, changed)
        expect(parse).toHaveBeenCalled()
        const expected = await createPieceRenderer({ pieceLength: 80 })(text, changed)
        expect(actual.map((piece) => piece.nodes)).toEqual(expected.map((piece) => piece.nodes))
      } finally {
        parse.mockRestore()
      }
    },
  )

  it('returns a complete answer for empty and short documents', async () => {
    for (const text of ['', '# Short']) {
      const render = createPieceRenderer()
      const head = await render.head(text, options, [], 8000)
      expect(head.partial).toBe(false)
      expect(head.pieces).toEqual(await render(text, options))
    }
  })

  it('rejects an invalid head budget', async () => {
    await expect(createPieceRenderer().head(markdown, options, [], 0)).rejects.toThrow(
      'E_PREVIEW_HEAD_BUDGET',
    )
  })
})
