import { describe, expect, it } from 'vitest'
import { createPieceRenderer, createPreviewRegistry } from '../../src/core/preview'
import { labels } from '../support/preview-html'

const options = { labels, loadedEmbeds: [] }
const markdown =
  '# Same\n\nFirst [link][later] and call[^later].\n\n' +
  Array.from({ length: 30 }, (_, i) => `# Same\n\nParagraph ${i}.\n\n`).join('') +
  '[later]: https://example.com\n\n[^later]: A trailing definition.'

describe('head preview pieces', () => {
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
