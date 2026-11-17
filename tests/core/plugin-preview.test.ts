// Contract of the preview renderer contribution point (ADR 0005): a block of the plugin's language goes to the plugin, its Markdown
// answer is rendered and sanitized like note text, and a block with no answer stays code.
import { toHtml } from 'hast-util-to-html'
import { describe, expect, it } from 'vitest'
import {
  createPieceRenderer,
  createPreviewRegistry,
  renderPreview,
  type PluginRendererSpec,
  type RenderPluginBlock,
} from '../../src/core'
import { labels } from '../support/preview-html'

const specs = [{ key: 'com.example.chart/chart', language: 'chart', output: 'markdown' as const }]

const html = async (
  markdown: string,
  render: RenderPluginBlock,
  rendererSpecs: readonly PluginRendererSpec[] = specs,
) =>
  toHtml(
    await renderPreview(
      markdown,
      { labels, loadedEmbeds: [] },
      createPreviewRegistry({ builtins: true, plugins: { specs: rendererSpecs, render } }),
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
        '<script>alert(1)</script><img src="devot://file/00000000-0000-4000-8000-000000000001" onerror="alert(2)"><a href="javascript:alert(3)">l</a><iframe srcdoc="<script>"></iframe>',
    )
    expect(out).not.toMatch(/<script|onerror|javascript:|srcdoc/)
    expect(out).toContain('<img src="devot://file/00000000-0000-4000-8000-000000000001">')
  })

  it('loads nothing remote from an answer: no remote images, links, frames or video embeds', async () => {
    const out = await html(
      '```chart\nx\n```',
      async () =>
        '![p](https://e.x/p?d=1) ![q](http://e.x/q)\n\n<iframe src="https://e.x/f"></iframe>\n\n[l](https://e.x/l)\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n![ok](data:image/png;base64,AAAA)',
    )
    expect(out).not.toMatch(/(?:src|href)="https?:|<iframe|data-embed-src/)
    expect(out).toContain('<img src="data:image/png;base64,AAAA"')
  })

  it("links nowhere but to notes from an answer, not even through a code block's source", async () => {
    const out = await html(
      '```chart\nsecret\n```',
      async () =>
        '```js filename=app.js url=https://evil.example/c?d=x\nlet a\n```\n\n[n](devot://note/0192a6f0-0000-7000-8000-000000000009) [w](https://x.example)',
    )
    expect(out).not.toMatch(/evil\.example|x\.example/)
    expect(out).toContain('devot://note/0192a6f0-0000-7000-8000-000000000009')
  })

  it('draws a code block and a colour swatch of an answer once', async () => {
    const tree = await renderPreview(
      '```chart\nx\n```',
      { labels, loadedEmbeds: [] },
      createPreviewRegistry({
        builtins: true,
        plugins: { specs, render: async () => 'Colour `#ff0000`\n\n```js\nlet a\n```' },
      }),
    )
    const out = toHtml(tree)
    expect(out.match(/class="swatch"/g)).toHaveLength(1)
    expect(out.match(/class="code-block/g)).toHaveLength(1)
    expect(out.match(/class="code-header/g)).toHaveLength(1)
  })

  it('keeps a plugin block inside an alert a built-in renderer rebuilds', async () => {
    const out = await html('> [!NOTE]\n> ```chart\n> x\n> ```', async () => 'drawn')
    expect(out).toMatch(
      /<div class="alert alert-note"[^>]*>[\s\S]*<div class="plugin-block"[\s\S]*drawn/,
    )
  })

  it('keeps front matter first when a plugin block opens the body', async () => {
    const out = await html('---\ntitle: a\n---\n\n```chart\nx\n```\n\nAfter', async () => 'drawn')
    expect(out.indexOf('class="frontmatter"')).toBeGreaterThan(-1)
    expect(out.indexOf('class="frontmatter"')).toBeLessThan(out.indexOf('class="plugin-block"'))
    expect(out.indexOf('class="plugin-block"')).toBeLessThan(out.indexOf('After'))
  })

  it('leaves the answer no offsets into the note: its task boxes are disabled and its images carry no range', async () => {
    const tree = await renderPreview(
      '- [ ] real task\n\n```chart\nx\n```\n\n![a](devot://file/00000000-0000-4000-8000-000000000001)\n',
      { labels, loadedEmbeds: [] },
      createPreviewRegistry({
        builtins: true,
        plugins: {
          specs,
          render: async () =>
            '- [ ] inner task\n\n![b](devot://file/00000000-0000-4000-8000-000000000002) ![c](data:image/png;base64,AAAA)',
        },
      }),
    )
    const out = toHtml(tree)
    const block = out.slice(out.indexOf('plugin-block'), out.lastIndexOf('</div>'))
    expect(block).toContain('inner task')
    expect(block).not.toMatch(/data-task-at|data-image-from|data-image-to/)
    expect(block).toMatch(/<input type="checkbox" disabled>/)
    expect(out.match(/data-task-at/g)).toHaveLength(1)
    expect(out.match(/data-image-from/g)).toHaveLength(1)
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

  it("shows a note an answer links to as a chip, asking for the targets the note's own text did not list", async () => {
    const listed = '0192a6f0-0000-7000-8000-000000000001'
    const answered = '0192a6f0-0000-7000-8000-000000000002'
    const gone = '0192a6f0-0000-7000-8000-000000000003'
    const target = (title: string) => ({
      title,
      status: 'none' as const,
      tasks: { done: 0, total: 0 },
      tags: [],
    })
    const asked: string[][] = []
    const out = toHtml(
      await renderPreview(
        '```chart\nx\n```',
        { labels, loadedEmbeds: [], noteLinks: { [listed]: target('Listed') } },
        createPreviewRegistry({
          builtins: true,
          plugins: {
            specs,
            render: async () =>
              `- [Listed](devot://note/${listed})\n- [Answered](devot://note/${answered})\n- [Gone](devot://note/${gone})`,
            linkTargets: async (ids) => {
              asked.push(ids)
              return { [answered]: target('Answered') }
            },
          },
        }),
      ),
    )
    expect(asked).toEqual([[answered, gone]])
    expect(out.match(/class="note-chip"/g)).toHaveLength(2)
    expect(out.match(/note-link-missing/g)).toHaveLength(1)
    expect(out).toContain(`href="devot://note/${gone}" class="note-link-missing"`)
  })

  it('asks for no targets where the preview shows no chips, or when the answer links to no notes', async () => {
    const asked: string[][] = []
    const registry = createPreviewRegistry({
      builtins: true,
      plugins: {
        specs,
        render: async (_k, source) =>
          source === 'links' ? '[n](devot://note/0192a6f0-0000-7000-8000-000000000002)' : 'plain',
        linkTargets: async (ids) => {
          asked.push(ids)
          return {}
        },
      },
    })
    await renderPreview('```chart\nlinks\n```', { labels, loadedEmbeds: [] }, registry)
    await renderPreview(
      '```chart\nplain\n```',
      { labels, loadedEmbeds: [], noteLinks: {} },
      registry,
    )
    expect(asked).toEqual([])
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

  it('renders again only the pieces that may hold a plugin block when the notes plugins read change', async () => {
    const asked: string[] = []
    const pieces = createPieceRenderer({
      registry: createPreviewRegistry({
        builtins: true,
        plugins: {
          specs,
          render: async (_k, source) => {
            asked.push(source)
            return source.toUpperCase()
          },
        },
      }),
      pieceLength: 10,
      pluginLanguages: () => ['chart'],
    })
    const note =
      '```chart\nabc\n```\n\nmore text about a chart\n\n```js\nlet a\n```\n\n```&#99;hart\ndef\n```\n'
    const options = { labels, loadedEmbeds: [] }
    const first = await pieces(note, { ...options, pluginNotes: 0 })
    expect(asked).toEqual(['abc', 'def'])
    const second = await pieces(
      note,
      { ...options, pluginNotes: 1 },
      first.map((p) => p.key),
    )
    expect(asked).toEqual(['abc', 'def', 'abc', 'def'])
    expect(second.map((p) => p.nodes !== undefined)).toEqual([true, false, false, true])
    expect(second.map((p, i) => p.key === first[i]!.key)).toEqual([false, true, true, false])
  })

  it('leaves a block of a renderer that draws SVG to the page, as an island naming the renderer and where the block is', async () => {
    const asked: string[] = []
    const out = await html(
      'Intro\n\n```dot\na -> b\n```\n',
      async (key) => {
        asked.push(key)
        return null
      },
      [{ key: 'com.example.graphviz/dot', language: 'dot', output: 'svg' }],
    )
    expect(asked).toEqual([])
    expect(out).toContain(
      '<div class="island island-plugin" data-devot-island="plugin" data-island-source="com.example.graphviz/dot\na -> b" data-block-from="7" data-block-to="24" data-source-line="3">',
    )
  })
})
