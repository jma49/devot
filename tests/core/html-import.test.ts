import { describe, expect, it } from 'vitest'
import { htmlDocument, htmlToMarkdown, pageBody, renderPreview } from '../../src/core'
import { labels } from '../support/preview-html'

const PNG_B64 = 'iVBORw0KGgoAAAANAQ=='
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])
const GIF_B64 = 'R0lGODlhAQA='
const ids = () => {
  let n = 0
  return () => `0190a0b0-0000-7000-8000-00000000000${(n += 1)}`
}

describe('HTML to Markdown for import', () => {
  it('turns a page into Markdown, with its title from <title>', () => {
    const page = [
      '<!doctype html><html><head><title> Launch  plan </title>',
      '<style>body { color: red }</style></head><body>',
      '<h1>Plan</h1><p>Some <strong>bold</strong>, <em>italic</em> and <code>code</code>.</p>',
      '<ul><li>one</li><li>two</li></ul>',
      '<pre><code class="language-js">let a = 1\n</code></pre>',
      '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>',
      '<p><a href="https://example.com/x">link</a> <img src="img/board.png" alt="Board"></p>',
      '</body></html>',
    ].join('')
    const out = htmlToMarkdown(page)
    expect(out.title).toBe('Launch plan')
    expect(out.markdown).toContain('# Plan\n')
    expect(out.markdown).toContain('Some **bold**, *italic* and `code`.')
    expect(out.markdown).toContain('- one\n- two')
    expect(out.markdown).toContain('```js\nlet a = 1\n```')
    expect(out.markdown).toContain('| a | b |')
    expect(out.markdown).toContain('[link](https://example.com/x)')
    expect(out.markdown).toContain('![Board](img/board.png)')
    expect(out.markdown).not.toContain('color: red')
  })

  it('has no title without a <title>, and handles a fragment', () => {
    expect(htmlToMarkdown('<p>Just text</p>')).toEqual({
      title: null,
      markdown: 'Just text\n',
      images: [],
      dropped: [],
    })
    expect(htmlToMarkdown('<title>  </title><p>x</p>').title).toBeNull()
    expect(htmlToMarkdown('')).toEqual({ title: null, markdown: '', images: [], dropped: [] })
  })

  it("takes the title from the page's head only, never from an SVG in its body", () => {
    const svg = '<body><svg><title>Icon label</title></svg><h1>Heading</h1></body>'
    expect(htmlToMarkdown(svg).title).toBeNull()
    expect(htmlToMarkdown(`<head><title>Page</title></head>${svg}`).title).toBe('Page')
  })

  it('neutralises hostile HTML: no script, handler, javascript: link or raw HTML survives', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<img src="x.png" onerror="alert(2)">',
      '<a href="javascript:alert(3)">click</a>',
      '<iframe src="https://evil.example/"></iframe>',
      '<p onclick="alert(4)">text<!-- secret comment --></p>',
      '<svg><script>alert(5)</script></svg>',
      '<object data="evil.swf"></object>',
      '<img src="data:image/png;base64,AAAA">',
    ].join('\n')
    const { markdown, dropped } = htmlToMarkdown(hostile)
    expect(markdown).not.toMatch(/alert|javascript:|onerror|onclick|secret|<|data:/i)
    expect(dropped).toEqual(['<iframe>', '<svg>', '<object>', 'data:image/png'])
    expect(markdown).toContain('![](x.png)')
    expect(markdown).toContain('click')
    expect(markdown).toContain('text')
  })

  it('never writes a thematic break as `---`, which could read as front matter', () => {
    const { markdown } = htmlToMarkdown('<hr><p>a</p><hr><p>b</p>')
    expect(markdown.startsWith('---')).toBe(false)
  })

  it('keeps images embedded as data: URIs, as attachments to store', () => {
    const page = [
      `<p><img src="data:image/png;base64,${PNG_B64}" alt="Shot"> and again`,
      ` <img src="DATA:image/png;base64,${PNG_B64.slice(0, 8)} ${PNG_B64.slice(8)}"></p>`,
    ].join('')
    const out = htmlToMarkdown(page, ids())
    const [first, second] = out.images
    expect(out.images).toHaveLength(2)
    expect(first).toEqual({
      id: '0190a0b0-0000-7000-8000-000000000001',
      mime: 'image/png',
      data: PNG,
    })
    expect(second!.data).toEqual(PNG)
    expect(out.markdown).toBe(
      `![Shot](devot://file/${first!.id}) and again ![](devot://file/${second!.id})\n`,
    )
    expect(out.dropped).toEqual([])
  })

  it('stores no image from content the page leaves out', () => {
    const out = htmlToMarkdown(
      `<body><p>Text</p><noscript><img src="data:image/png;base64,${PNG_B64}"></noscript></body>`,
      ids(),
    )
    expect(out).toEqual({ title: null, markdown: 'Text\n', images: [], dropped: [] })
  })

  it('without IDs to give them, lists embedded images as left out', () => {
    const out = htmlToMarkdown(`<img src="data:image/png;base64,${PNG_B64}">`)
    expect(out.images).toEqual([])
    expect(out.dropped).toEqual(['data:image/png'])
    expect(out.markdown).not.toContain('data:')
  })

  it('takes a lazy-loaded image from data-src over its placeholder', () => {
    const out = htmlToMarkdown(
      `<img src="data:image/gif;base64,${GIF_B64}" data-src="photo.jpg" alt="P">` +
        '<img data-src="https://example.com/r.png">',
      ids(),
    )
    expect(out.markdown).toBe('![P](photo.jpg)![](https://example.com/r.png)\n')
    expect(out.images).toEqual([])
    expect(out.dropped).toEqual([])
  })

  it('turns MathML with its TeX source back into math', () => {
    const tex = (source: string, display = '') =>
      `<math${display}><semantics><mi>x</mi>` +
      `<annotation encoding="application/x-tex">${source}</annotation></semantics></math>`
    const page = [
      `<p>Inline <span class="math-inline">${tex('x^2_i')}</span> here.</p>`,
      `<div class="math-display">${tex('\\frac{a}{b}', ' display="block"')}</div>`,
      // A KaTeX page: its HTML drawing of the math is no text of the note.
      `<p><span class="katex"><span class="katex-mathml">${tex('y')}</span>`,
      '<span class="katex-html" aria-hidden="true"><span>y</span></span></span></p>',
    ].join('')
    const out = htmlToMarkdown(page)
    expect(out.markdown).toBe('Inline $x^2_i$ here.\n\n$$\n\\frac{a}{b}\n$$\n\n$y$\n')
    expect(out.dropped).toEqual([])
  })

  it('escapes dollar signs in text, so they do not read as math', () => {
    expect(htmlToMarkdown('<p>$5 and $6</p>').markdown).toBe('\\$5 and \\$6\n')
  })

  it('lists what it cannot keep, each kind once', () => {
    const page = [
      '<p>Diagram <svg><text>A</text></svg><svg></svg></p>',
      '<math><mi>x</mi></math>',
      '<img src="data:image/bmp;base64,Qk0=">',
      '<img src="data:image/png;base64,not-base64!">',
      '<img src="file:///Users/me/a.png">',
      '<a href="data:application/pdf;base64,JVBERi0=">PDF</a>',
      '<video src="clip.mp4">Clip</video><audio src="a.mp3"></audio><canvas></canvas>',
      '<embed src="x.swf">',
    ].join('')
    const out = htmlToMarkdown(page, ids())
    expect(out.dropped).toEqual([
      '<svg>',
      '<math>',
      'data:image/bmp',
      'data:image/png',
      'file:///Users/me/a.png',
      'data:application/pdf',
      '<video>',
      '<audio>',
      '<canvas>',
      '<embed>',
    ])
    expect(out.images).toEqual([])
    expect(out.markdown).not.toMatch(/data:|file:|<|\bA\b/)
    expect(out.markdown).toContain('PDF')
  })

  it('is not fooled by placeholder text a page spells with character references', () => {
    const tex =
      '<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>'
    const page =
      `<p>devot&#105;mportm7e and devot&#105;mportm0e ${tex}</p>` +
      `<img src="data:image/png;base64,${PNG_B64}"><img src="devot&#105;mporti0" alt="mine">`
    const out = htmlToMarkdown(page, ids())
    expect(out.markdown).toBe(
      `devotimportm7e and devotimportm0e $x$\n\n![](devot://file/${out.images[0]!.id})![mine](devotimporti0)\n`,
    )
  })

  it("keeps a KaTeX page's drawn math when it has no TeX source to restore", () => {
    const page =
      '<p><span class="katex"><span class="katex-html" aria-hidden="true">' +
      '<span>E=mc</span><span>2</span></span></span></p>'
    expect(htmlToMarkdown(page).markdown).toBe('E=mc2\n')
  })

  it('takes any base64 image the bytes say is one, whatever type the URL names', () => {
    const page = [
      `<img src="data:image/jpg;base64,${PNG_B64}">`,
      `<img src="data:application/octet-stream;base64,${PNG_B64}">`,
      `<img src="data:image/png;charset=utf-8;base64,${PNG_B64}">`,
    ].join('')
    const out = htmlToMarkdown(page, ids())
    expect(out.images.map((i) => i.mime)).toEqual(['image/png', 'image/png', 'image/png'])
    expect(out.dropped).toEqual([])
  })

  it('puts the TeX back in code as text, never a placeholder', () => {
    const tex =
      '<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>'
    const out = htmlToMarkdown(`<pre><code>a ${tex} b</code></pre><p><code>${tex}</code></p>`)
    expect(out.markdown).toBe('```\na x^2 b\n```\n\n`x^2`\n')
  })

  it('looks inside media, keeping and listing what their fallback holds', () => {
    const page =
      `<video src="clip.mp4"><img src="data:image/png;base64,${PNG_B64}" alt="Poster">` +
      '<math><mi>y</mi></math></video>'
    const out = htmlToMarkdown(page, ids())
    expect(out.dropped).toEqual(['<video>', '<math>'])
    expect(out.markdown).toBe(`![Poster](devot://file/${out.images[0]!.id})\n`)
  })

  it('lists a frameset page, which has no body to import', () => {
    const out = htmlToMarkdown(
      '<html><head><title>F</title></head><frameset><frame src="a.html"></frameset></html>',
    )
    expect(out).toEqual({ title: 'F', markdown: '', images: [], dropped: ['<frameset>'] })
  })

  it('lists an embedded image whose link did not survive the conversion', () => {
    const out = htmlToMarkdown(
      `<p>a</p><kbd><img src="data:image/png;base64,${PNG_B64}"></kbd>`,
      ids(),
    )
    expect(out.images).toEqual([])
    expect(out.dropped).toEqual(['data:image/png'])
  })

  describe("of Devot's own HTML export", () => {
    const roundTrip = async (markdown: string) => {
      const tree = await renderPreview(markdown, { labels, loadedEmbeds: [] })
      const body = pageBody(tree, { nonce: '0123456789abcdef0123456789abcdef' })
      return htmlToMarkdown(htmlDocument({ title: 'T', body: body.html, css: '', lang: 'en' }))
    }

    it('gives back numbered code without its line numbers or header', async () => {
      const out = await roundTrip(
        '```py line=10\na = 1\nb = 2\n```\n\n```js title="app.js"\nlet a\n```\n',
      )
      expect(out.markdown).toContain('```py\na = 1\nb = 2\n```')
      expect(out.markdown).toContain('```js\nlet a\n```')
      expect(out.markdown).not.toMatch(/app\.js|JavaScript|Python|Line 10|^1[01]$/m)
      expect(out.dropped).toEqual([])
    })

    it('gives back an alert as the blockquote that made it', async () => {
      const out = await roundTrip('> [!NOTE]\n> Mind the gap.\n\n> [!WARNING]\n>\n> * a\n')
      expect(out.markdown).toContain('> [!NOTE]\n>\n> Mind the gap.')
      expect(out.markdown).toContain('> [!WARNING]\n>\n> - a')
      const again = await renderPreview(out.markdown, { labels, loadedEmbeds: [] })
      expect(JSON.stringify(again).match(/alert-(note|warning)/g)).toEqual([
        'alert-note',
        'alert-warning',
      ])
      expect(out.markdown).not.toMatch(/^Note$/m)
      expect(out.dropped).toEqual([])
    })
  })
})
