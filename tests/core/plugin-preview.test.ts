// Contract of the preview renderer contribution point (ADR 0005): a block of the plugin's language goes to the plugin, its Markdown
// answer is rendered and sanitized like note text, and a block with no answer stays code.
import { toHtml } from 'hast-util-to-html'
import { describe, expect, it } from 'vitest'
import {
  createPieceRenderer,
  createPreviewRegistry,
  renderPreview,
  type RenderPluginBlock,
} from '../../src/core'
import { labels } from '../support/preview-html'

const specs = [{ key: 'com.example.chart/chart', language: 'chart' }]

const html = async (markdown: string, render: RenderPluginBlock) =>
  toHtml(
    await renderPreview(
      markdown,
      { labels, loadedEmbeds: [] },
      createPreviewRegistry({ builtins: true, plugins: { specs, render } }),
    ),
  )

describe('plugin preview renderers', () => {
  it('replaces a block of its language with its Markdown, keeping the block on its source line', async () => {
    const asked: [string, string][] = []
    const out = await html('Intro\n\n```chart\na, b\n1, 2\n```\n', async (key, source) => {
      asked.push([key, source])
      return '**drawn** _here_'
    })
    expect(asked).toEqual([['com.example.chart/chart', 'a, b\n1, 2']])
    expect(out).toContain(
      '<div class="plugin-block" data-plugin="com.example.chart/chart" data-source-line="3">',
    )
    expect(out).toContain('<strong>drawn</strong> <em>here</em>')
    expect(out).not.toContain('a, b')
  })

  it('sanitizes the answer as note text: no scripts, handlers or javascript links', async () => {
    const out = await html(
      '```chart\nx\n```',
      async () =>
        '<script>alert(1)</script><img src="https://e.x/a.png" onerror="alert(2)"><a href="javascript:alert(3)">l</a><iframe srcdoc="<script>"></iframe>',
    )
    expect(out).not.toMatch(/<script|onerror|javascript:|srcdoc/)
    expect(out).toContain('<img src="https://e.x/a.png">')
  })

  it('leaves other languages, and blocks without an answer or whose plugin failed, as code', async () => {
    const out = await html(
      '```js\n1\n```\n\n```chart\nnull\n```\n\n```chart\nthrow\n```',
      (_k, source) =>
        source === 'throw' ? Promise.reject(new Error('E_PLUGIN_TIMEOUT')) : Promise.resolve(null),
    )
    expect(out).not.toContain('plugin-block')
    expect(out).toContain('null')
    expect(out).toContain('throw')
  })

  it('never runs plugin renderers on a plugin answer', async () => {
    let calls = 0
    const out = await html('```chart\nx\n```', async () => {
      calls += 1
      return '```chart\nnested\n```'
    })
    expect(calls).toBe(1)
    expect(out).toContain('nested')
  })

  it('renders through the piece renderer, asking again only for pieces that changed', async () => {
    let calls = 0
    const pieces = createPieceRenderer({
      registry: createPreviewRegistry({
        builtins: true,
        plugins: {
          specs,
          render: async (_k, source) => {
            calls += 1
            return source.toUpperCase()
          },
        },
      }),
      pieceLength: 10,
    })
    const options = { labels, loadedEmbeds: [] }
    const first = await pieces('```chart\nabc\n```\n\nmore text here\n', options)
    expect(calls).toBe(1)
    await pieces(
      '```chart\nabc\n```\n\nmore text changed\n',
      options,
      first.map((p) => p.key),
    )
    expect(calls).toBe(1)
  })
})
