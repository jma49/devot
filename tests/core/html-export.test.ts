import { describe, expect, it } from 'vitest'
import {
  htmlDocument,
  pageBody,
  PAGE_CSP,
  PRINT_CSP,
  renderPreview,
  type PageOptions,
  type PreviewLabels,
} from '../../src/core'

const labels: PreviewLabels = {
  alerts: {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
  },
  embedFrom: 'Embedded content from {origin}',
  embedLoad: 'Load',
  videoTitle: 'Embedded video',
  untitled: 'Untitled',
  missingNote: 'Note not found',
}

const NONCE = '0123456789abcdef0123456789abcdef'
const ID1 = '0192a6f0-0000-7000-8000-00000000f001'
const ID2 = '0192a6f0-0000-7000-8000-00000000f002'
/** UUID-shaped but version 4: no attachment has such an ID (Rust refuses it). */
const V4 = '0192a6f0-0000-4000-8000-00000000f003'
const NOTE = '0192a6f0-0000-7000-8000-000000000009'

const NOTE_MD = [
  '---',
  'tags: [work]',
  '---',
  '# Plan',
  '',
  `![Board](devot://file/${ID1}) ![again](devot://file/${ID1}) ![logo](devot://file/${ID2})`,
  '',
  '![Remote](https://example.com/r.png)',
  '',
  `[Other note](devot://note/${NOTE}) and \`#ff8800\``,
  '',
  '> [!WARNING]',
  '> Careful.',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '```js',
  `const a = "devot-image-${NONCE}-0 devot://file/${ID1}" < 1`,
  '```',
  '',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  '',
  '<iframe src="https://example.com/embed"></iframe>',
  '',
  '- [x] done',
  '',
  'Footnote[^1] <script>alert(1)</script> <img src="x" onerror="alert(1)">',
  '',
  '[^1]: The note.',
  '',
].join('\n')

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">' +
  '<style>.node{fill:#eee}</style><script>alert(1)</script>' +
  '<foreignObject><div>x</div></foreignObject><a href="https://evil.example"><text>A</text></a>' +
  '<use href="#n"/><rect class="node" width="5" height="5" style="stroke: red"/></svg>'

async function page(options: Partial<PageOptions> = {}) {
  const tree = await renderPreview(NOTE_MD, { labels, loadedEmbeds: [] })
  return pageBody(tree, { nonce: NONCE, ...options })
}

describe('HTML pages', () => {
  it('keeps the preview markup with its classes, without the attributes it uses itself', async () => {
    const { html } = await page()
    expect(html).toContain('<h1>Plan</h1>')
    expect(html).toContain(
      '<div class="alert alert-warning"><p class="alert-title"><svg class="glyph alert-icon"',
    )
    expect(html).toContain('</svg>Warning</p>')
    expect(html).toContain(
      '<dl class="frontmatter"><div class="frontmatter-row"><dt>tags</dt><dd><span class="frontmatter-chip">work</span></dd></div></dl>',
    )
    expect(html).toContain('class="task-list-item"')
    expect(html).not.toMatch(/\sdata-[a-z-]+=/)
    // Nothing runs or loads on its own: no scripts, frames or buttons.
    expect(html).not.toMatch(/<script|<iframe|<button|onerror|onload/i)
  })

  it('gives each attachment one placeholder and leaves other images and text alone', async () => {
    const { html, images } = await page()
    expect(images).toEqual([
      { placeholder: `devot-image-${NONCE}-0`, fileId: ID1 },
      { placeholder: `devot-image-${NONCE}-1`, fileId: ID2 },
    ])
    expect(html).toContain(
      `<img src="devot-image-${NONCE}-0" alt="Board"> <img src="devot-image-${NONCE}-0" alt="again"> <img src="devot-image-${NONCE}-1" alt="logo">`,
    )
    expect(html).toContain('<img src="https://example.com/r.png" alt="Remote" class="image-block">')
    // Code that mentions a placeholder or an attachment stays text.
    expect(html).toContain(`"devot-image-${NONCE}-0 devot://file/${ID1}"</span> &#x3C; `)
    expect(() => pageBody({ type: 'root', children: [] }, { nonce: 'x' })).toThrow(
      'E_EXPORT_NONCE_INVALID',
    )
  })

  it('sizes an attachment image like the preview: one placeholder, a size class', async () => {
    const md = `![a](devot://file/${ID1}#half) ![b](devot://file/${ID1}) ![c](devot://file/${ID2}#small)\n`
    const tree = await renderPreview(md, { labels, loadedEmbeds: [] })
    const full = pageBody(tree, { nonce: NONCE })
    expect(full.images).toEqual([
      { placeholder: `devot-image-${NONCE}-0`, fileId: ID1 },
      { placeholder: `devot-image-${NONCE}-1`, fileId: ID2 },
    ])
    expect(full.html).toBe(
      `<p><img src="devot-image-${NONCE}-0" alt="a" class="image-size-half"> ` +
        `<img src="devot-image-${NONCE}-0" alt="b"> ` +
        `<img src="devot-image-${NONCE}-1" alt="c" class="image-size-small"></p>`,
    )
    // Simple HTML shows each image at its own size, as other Markdown tools do.
    const simple = pageBody(tree, { nonce: NONCE, simple: true })
    expect(simple.html).toBe(
      `<p><img src="devot-image-${NONCE}-0" alt="a"> <img src="devot-image-${NONCE}-0" alt="b"> ` +
        `<img src="devot-image-${NONCE}-1" alt="c"></p>`,
    )
    expect(simple.images).toEqual(full.images)
  })

  it('puts in only attachment IDs Rust accepts; any other devot:// image stays as written', async () => {
    const md = `![a](devot://file/${ID1}) ![old](devot://file/${V4}) ![b](devot://file/${V4}#half)\n`
    const tree = await renderPreview(md, { labels, loadedEmbeds: [] })
    for (const options of [{}, { simple: true }, { print: true }]) {
      const { html, images } = pageBody(tree, { nonce: NONCE, ...options })
      // Rust refuses the whole page when one image's ID is not a UUIDv7.
      expect(images).toEqual([{ placeholder: `devot-image-${NONCE}-0`, fileId: ID1 }])
      expect(html).toContain(`<img src="devot://file/${V4}" alt="old">`)
    }
  })

  it('a page to print shows images from the web as links to them, attachments as images', async () => {
    const md = [
      `![Board](devot://file/${ID1}#half) ![Remote](https://example.com/r.png "Remote image") ![](http://example.com/plain.png)`,
      '',
      '[![Build](https://example.com/badge.svg)](https://example.com/ci) and [![](https://example.com/b.svg)](https://example.com/b)',
      '',
      '<picture><source srcset="https://example.com/wide.png"><img src="https://example.com/narrow.png" alt="Narrow"></picture>',
      '',
    ].join('\n')
    const tree = await renderPreview(md, { labels, loadedEmbeds: [] })
    const printed = pageBody(tree, { nonce: NONCE, print: true })
    // Attachments still print as images (Rust puts them in as data: URIs).
    expect(printed.images).toEqual([{ placeholder: `devot-image-${NONCE}-0`, fileId: ID1 }])
    expect(printed.html).toContain(
      `<img src="devot-image-${NONCE}-0" alt="Board" class="image-size-half"> ` +
        '<a href="https://example.com/r.png">Remote</a> ' +
        '<a href="http://example.com/plain.png">http://example.com/plain.png</a>',
    )
    // Inside a link an image becomes its text: links never nest.
    expect(printed.html).toContain(
      '<a href="https://example.com/ci">Build</a> and ' +
        '<a href="https://example.com/b">https://example.com/b.svg</a>',
    )
    expect(printed.html).toContain('<a href="https://example.com/narrow.png">Narrow</a>')
    // No image or source from the web is left to load.
    expect(printed.html).not.toMatch(/<img[^>]*src="https?:/i)
    expect(printed.html).not.toMatch(/<source/)

    // An exported page keeps them as images, to load where it is opened.
    const exported = pageBody(tree, { nonce: NONCE })
    expect(exported.html).toContain(
      '<img src="https://example.com/r.png" alt="Remote" title="Remote image">',
    )
    expect(exported.html).toContain('<source srcset="https://example.com/wide.png">')
  })

  it("shows the UI's drawing of a diagram, cleaned; its source without one", async () => {
    const drawn = await page({ island: (kind) => (kind === 'mermaid' ? SVG : null) })
    expect(drawn.html).toContain('<div class="island island-mermaid"><svg')
    expect(drawn.html).toContain('<style>.node{fill:#eee}</style>')
    expect(drawn.html).toContain('<rect class="node" width="5" height="5" style="stroke: red">')
    expect(drawn.html).toContain('<a><text>A</text></a>')
    expect(drawn.html).not.toMatch(/<script|foreignObject|<use|onload|evil\.example/i)
    const source = await page()
    expect(source.html).toContain(
      '<pre><code class="language-mermaid">graph TD; A-->B\n</code></pre>',
    )
    const refused = await page({ island: () => '<p>not a drawing</p>' })
    expect(refused.html).toContain('<code class="language-mermaid">')
  })

  it("never lets a drawing's stylesheet end its style element", async () => {
    // As the UI's serializer writes it: `<` in the CSS as `&lt;`.
    const css =
      ".a{content:'&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;'} .b{} &lt;/STYLE &gt;"
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect class="a"/></svg>`
    const { html } = await page({ island: () => svg })
    const island = html.indexOf('<div class="island')
    const drawing = html.slice(html.indexOf('<svg', island), html.indexOf('</svg>', island))
    expect(drawing).not.toMatch(/<img/i)
    expect(drawing.match(/<\/style/gi)).toHaveLength(1)
    // The CSS still means the same: `\3c ` is `<` in CSS.
    expect(drawing).toContain(
      "<style>.a{content:'\\3c /style>\\3c img src=x onerror=alert(1)>'} .b{} \\3c /STYLE ></style>",
    )
  })

  it('turns embeds into links and swatches into inline colours', async () => {
    const { html } = await page()
    expect(html).toContain(
      '<p><a href="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ">https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ</a></p>',
    )
    expect(html).toContain(
      '<p><a href="https://example.com/embed">https://example.com/embed</a></p>',
    )
    expect(html).toContain(
      '<span class="swatch" aria-hidden="true" style="background-color: #ff8800"></span>',
    )
  })

  it('points note links where the export says, or keeps them', async () => {
    expect((await page()).html).toContain(`<a href="devot://note/${NOTE}">Other note</a>`)
    const mapped = await page({ noteHref: (id) => (id === NOTE ? '../Other%20note.html' : null) })
    expect(mapped.html).toContain('<a href="../Other%20note.html">Other note</a>')
  })

  it('simple HTML has no classes, styles or data attributes', async () => {
    const { html, images } = await page({ simple: true, island: () => SVG })
    expect(html).not.toMatch(/\s(?:class|style|data-[a-z-]+)=/)
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('tags: [work]')
    expect(html).toContain('<blockquote><p><strong>Warning</strong></p>')
    expect(html).toContain('<pre><code>graph TD; A-->B\n</code></pre>')
    expect(html).toContain('<li><input type="checkbox" checked disabled> done</li>')
    expect(html).toContain('<code>#ff8800</code>')
    expect(images).toHaveLength(2)
  })

  it('wraps a page in a document of its own with its styles and no scripts', () => {
    const doc = htmlDocument({
      title: 'A <b>&</b> title',
      body: '<p>Body</p>',
      css: 'p { color: var(--x) } </style><script>',
      lang: 'en',
    })
    expect(
      doc.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">'),
    ).toBe(true)
    expect(doc).toContain('<title>A &lt;b&gt;&amp;&lt;/b&gt; title</title>')
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`)
    expect(PAGE_CSP).toContain("default-src 'none'")
    expect(PAGE_CSP).not.toContain('script-src')
    expect(doc).toContain('<style>p { color: var(--x) } <\\/style><script></style>')
    expect(doc).toContain('<article class="preview"><p>Body</p></article>')
  })

  it('a page to print may load its own styles and data: images, nothing from the web', () => {
    const note = { title: 'Plan', body: '<p>Body</p>', css: 'p {}', lang: 'en' }
    const printed = htmlDocument({ ...note, print: true })
    expect(printed).toContain(`<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`)
    expect(printed).not.toContain(PAGE_CSP)
    expect(PRINT_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'")
    // An exported page may show images from the web where it is opened.
    expect(htmlDocument(note)).toContain(`content="${PAGE_CSP}"`)
    expect(PAGE_CSP).toContain('img-src data: https: http:')
  })
})
