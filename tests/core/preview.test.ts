import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import {
  createPreviewRegistry,
  PREVIEW_API_VERSION,
  renderPreview,
  type PreviewLabels,
  type PreviewOptions,
  type PreviewRenderer,
  createEmojiRenderer,
  createMathRenderer,
} from '../../src/core'
import { setImageMarkdownSize } from '../../src/core/images'
import { fragmentId } from '../../src/core/preview/headingIds'
import { noteFields } from '../support/preview-html'

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
  codeLines: 'Lines {start} to {end}',
  codeLine: 'Line {n}',
  codeRef: 'in {ref}',
  codeSource: 'Open source',
}

const render = (md: string, options: Partial<PreviewOptions> = {}) =>
  renderPreview(md, { labels, loadedEmbeds: [], ...options })

function elements(tree: Root | Element): Element[] {
  const out: Element[] = []
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element') out.push(node)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return out
}

const tags = (tree: Root, tag: string) => elements(tree).filter((e) => e.tagName === tag)
const classes = (e: Element) => (e.properties['className'] as string[] | undefined) ?? []
const byClass = (tree: Root, name: string) =>
  elements(tree).filter((e) => classes(e).includes(name))

function text(node: Root | RootContent): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(text).join('') : ''
}

describe('Markdown dialect', () => {
  it('renders GFM tables, task lists, strikethrough, autolinks and footnotes', async () => {
    const tree = await render(
      [
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '~~gone~~ https://example.com',
        '',
        'Claim.[^1]',
        '',
        '[^1]: Source.',
      ].join('\n'),
    )
    expect(tags(tree, 'table')).toHaveLength(1)
    const boxes = tags(tree, 'input')
    expect(boxes.map((b) => Boolean(b.properties['checked']))).toEqual([true, false])
    // Each box knows where its mark is in the Markdown, so the preview can tick it.
    expect(boxes.map((b) => b.properties['dataTaskAt'])).toEqual([34, 45])
    expect(boxes.some((b) => b.properties['disabled'])).toBe(false)
    expect(tags(tree, 'del')).toHaveLength(1)
    expect(tags(tree, 'a').some((a) => a.properties['href'] === 'https://example.com')).toBe(true)
    expect(byClass(tree, 'footnotes')).toHaveLength(1)
  })

  it('gives every footnote link the id of the footnote it points to', async () => {
    const tree = await render('Claim.[^1]\n\n[^1]: Source.\n')
    const given = elements(tree).map((e) => e.properties['id'])
    const links = tags(tree, 'a')
      .map((a) => a.properties['href'])
      .filter((href): href is string => typeof href === 'string' && href.startsWith('#'))
    expect(links).toHaveLength(2)
    for (const href of links) expect(given).toContain(fragmentId(href.slice(1)))
  })

  it('finds task marks in nested, ordered and quoted lists, and leaves raw HTML boxes disabled', async () => {
    const md =
      '1. [X] a\n   - [ ] b\n\n> * [ ] c\n\n<ul><li><input type="checkbox" disabled> d</li></ul>'
    const tree = await render(md)
    const boxes = tags(tree, 'input')
    const at = boxes.map((b) => b.properties['dataTaskAt'])
    expect(at.slice(0, 3).map((n) => md[n as number])).toEqual(['X', ' ', ' '])
    expect(at.slice(0, 3).map((n) => md.slice((n as number) - 1, (n as number) + 2))).toEqual([
      '[X]',
      '[ ]',
      '[ ]',
    ])
    expect(at[3]).toBeUndefined()
    expect(boxes[3]?.properties['disabled']).toBe(true)
  })

  it('shows front matter as a block of properties above the note', async () => {
    const tree = await render('---\ntitle: Hello\ntags: [a, b]\nmeta: {x: 1}\n---\n\n# Body')
    const first = tree.children[0] as Element
    expect(first.tagName).toBe('dl')
    expect(classes(first)).toContain('frontmatter')
    const rows = byClass(tree, 'frontmatter-row')
    expect(rows.map((r) => text(tags(r as unknown as Root, 'dt')[0]!))).toEqual([
      'title',
      'tags',
      'meta',
    ])
    expect(byClass(tree, 'frontmatter-chip').map(text)).toEqual(['a', 'b'])
    expect(text(rows[2]!)).toBe('metax: 1')
    expect(tags(tree, 'h1')).toHaveLength(1)
  })

  it('shows front matter that is not a map of keys as code', async () => {
    const tree = await render('---\n- just\n- a list\n---\n\nBody')
    const first = tree.children[0] as Element
    expect(first.tagName).toBe('pre')
    expect(classes(first)).toContain('frontmatter')
    expect(text(first)).toBe('- just\n- a list')
    const broken = await render('---\ntitle: [unclosed\n---\n\nBody')
    expect((broken.children[0] as Element).tagName).toBe('pre')
  })

  describe('beside the note it opens (the live preview)', () => {
    const row = (tree: Root, key: string) =>
      byClass(tree, 'frontmatter-row').find(
        (r) => text(tags(r as unknown as Root, 'dt')[0]!) === key,
      ) as unknown as Root
    const badges = (tree: Root) => byClass(tree, 'frontmatter-badge').map(text)
    const applies = (tree: Root) =>
      tags(tree, 'button').map((b) => ({
        field: b.properties['dataFrontmatterApply'],
        value: b.properties['dataFrontmatterValue'],
        name: b.properties['ariaLabel'],
      }))

    it('colours the chips of tags the library has a colour for, and leaves the others plain', async () => {
      const tree = await render('---\ntags: [Work, "#q4", new]\n---\n', {
        note: noteFields({
          tags: ['work', 'q4', 'new'],
          tagColors: [
            { name: 'work', color: 'green' },
            { name: 'Q4', color: 'blue' },
          ],
        }),
      })
      expect(byClass(tree, 'frontmatter-chip').map((c) => [text(c), classes(c)])).toEqual([
        ['Work', ['frontmatter-chip', 'tag-chip', 'tag-color-green']],
        ['q4', ['frontmatter-chip', 'tag-chip', 'tag-color-blue']],
        ['new', ['frontmatter-chip']],
      ])
      expect(badges(tree)).toEqual([])
    })

    it('shows the note’s value and an Apply for each field that differs', async () => {
      const tree = await render(
        '---\ntitle: Launch plan\nstatus: on hold\ntags: work, q4\nauthor: me\n---\n',
        { note: noteFields({ title: 'Draft', status: 'active', tags: ['home'] }) },
      )
      expect(badges(tree)).toEqual(['Note: Draft', 'Note: Active', 'Note: home'])
      expect(applies(tree)).toEqual([
        { field: 'title', value: 'Launch plan', name: 'Apply title to note' },
        { field: 'status', value: 'on_hold', name: 'Apply status to note' },
        { field: 'tags', value: '["work","q4"]', name: 'Apply tags to note' },
      ])
      expect(text(row(tree, 'author'))).toBe('authorme')
      expect(byClass(row(tree, 'tags'), 'frontmatter-chip').map(text)).toEqual(['work', 'q4'])
      const untitled = await render('---\ntitle: Plan\ntags: []\n---\n', {
        note: noteFields({}),
      })
      expect(badges(untitled)).toEqual(['Note: Untitled'])
      const noTags = await render('---\ntags: [a]\n---\n', { note: noteFields({}) })
      expect(badges(noTags)).toEqual(['Note: No Tags'])
    })

    it('adds nothing when the front matter says what the note does', async () => {
      const tree = await render(
        '---\ntitle: Launch plan\nStatus: On-Hold\ntags: [Q4, "#work"]\n---\n',
        { note: noteFields({ title: 'Launch plan', status: 'on_hold', tags: ['work', 'q4'] }) },
      )
      expect(badges(tree)).toEqual([])
      expect(applies(tree)).toEqual([])
    })

    it('offers no Apply for status text that names no status', async () => {
      const tree = await render('---\nstatus: someday\n---\n', {
        note: noteFields({ status: 'active' }),
      })
      expect(badges(tree)).toEqual(['Note: Active'])
      expect(applies(tree)).toEqual([])
    })

    it('offers no Apply while the note cannot be changed', async () => {
      const tree = await render('---\nstatus: active\n---\n', {
        note: noteFields({ canApply: false }),
      })
      expect(badges(tree)).toEqual(['Note: No Status'])
      expect(applies(tree)).toEqual([])
    })

    it('cuts a title to what the note can hold, on one line', async () => {
      const tree = await render(`---\ntitle: "a\\nb ${'x'.repeat(1200)}"\n---\n`, {
        note: noteFields({}),
      })
      const value = applies(tree)[0]!.value as string
      expect(value.startsWith('a b x')).toBe(true)
      expect(value).toHaveLength(1000)
    })

    it('shows front matter as written without the note’s fields (exports, copies, templates)', async () => {
      const tree = await render('---\ntitle: Plan\nstatus: on hold\ntags: [work]\n---\n')
      expect(badges(tree)).toEqual([])
      expect(applies(tree)).toEqual([])
      expect(byClass(tree, 'frontmatter-chip').map(classes)).toEqual([['frontmatter-chip']])
    })
  })

  it.each([
    ['NOTE', 'note', 'Note'],
    ['TIP', 'tip', 'Tip'],
    ['IMPORTANT', 'important', 'Important'],
    ['WARNING', 'warning', 'Warning'],
    ['CAUTION', 'caution', 'Caution'],
  ])('renders the %s alert', async (marker, kind, title) => {
    const tree = await render(`> [!${marker}]\n> Mind the gap.`)
    const [alert] = byClass(tree, 'alert')
    expect(alert && classes(alert)).toContain(`alert-${kind}`)
    expect(alert && text(byClass(tree, 'alert-title')[0]!)).toBe(title)
    expect(alert && text(alert)).toContain('Mind the gap.')
    expect(alert && text(alert)).not.toContain('[!')
  })

  it('leaves an ordinary quote alone', async () => {
    expect(byClass(await render('> [!NOPE] just text'), 'alert')).toHaveLength(0)
  })

  it('adds a swatch to inline code that is only a colour', async () => {
    const tree = await render('`#0e6b62` `rgb(1, 2, 3)` `hsl(10 20% 30%)` `#12` `color`')
    const swatches = byClass(tree, 'swatch')
    expect(swatches.map((s) => s.properties['dataSwatchColor'])).toEqual([
      '#0e6b62',
      'rgb(1, 2, 3)',
      'hsl(10 20% 30%)',
    ])
  })

  it('never adds swatches inside code blocks', async () => {
    expect(byClass(await render('```\n#ffffff\n```'), 'swatch')).toHaveLength(0)
  })
})

describe('note and file links', () => {
  const id = '0192f5c4-7c1a-7cc3-b5a8-3b1e0f6d2a10'

  it('keeps devot://note links and devot://file images', async () => {
    const tree = await render(`[Other](devot://note/${id}) ![pic](devot://file/${id})`)
    expect(tags(tree, 'a')[0]?.properties['href']).toBe(`devot://note/${id}`)
    expect(tags(tree, 'img')[0]?.properties['src']).toBe(`devot://file/${id}`)
  })

  it('drops malformed devot URLs', async () => {
    const tree = await render('[x](devot://note/../../etc) ![y](devot://note/abc)')
    expect(tags(tree, 'a')[0]?.properties['href']).toBeUndefined()
    expect(tags(tree, 'img')[0]?.properties['src']).toBeUndefined()
  })
})

describe('images', () => {
  const id = '0192f5c4-7c1a-7cc3-b5a8-3b1e0f6d2a10'
  const file = `devot://file/${id}`

  it('shows a size preset as a class and loads the image without it', async () => {
    const tree = await render(
      `![a](${file}#small) ![b](${file}#half) ![c](${file}#full) ![d](${file}) ![e](https://a.test/e.png#half)`,
    )
    const imgs = tags(tree, 'img')
    expect(imgs.map((i) => i.properties['src'])).toEqual([
      file,
      file,
      file,
      file,
      'https://a.test/e.png',
    ])
    expect(imgs.map((i) => classes(i))).toEqual([
      ['image-size-small'],
      ['image-size-half'],
      ['image-size-full'],
      [],
      ['image-size-half'],
    ])
  })

  it('reads the alt-text presets: w:240, w:50% and w:100%', async () => {
    const tree = await render(`![a w:240](${file}) ![b w:50%](${file}) ![c w:100%](${file})`)
    const imgs = tags(tree, 'img')
    expect(imgs.map((i) => classes(i))).toEqual([
      ['image-size-small'],
      ['image-size-half'],
      ['image-size-full'],
    ])
    expect(imgs.map((i) => i.properties['alt'])).toEqual(['a', 'b', 'c'])
  })

  it('keeps an unknown fragment as part of the URL', async () => {
    const tree = await render('![a](https://a.test/e.png#page)')
    expect(tags(tree, 'img')[0]?.properties['src']).toBe('https://a.test/e.png#page')
    expect(classes(tags(tree, 'img')[0]!)).toEqual(['image-block'])
  })

  it('marks where each inline image is in the Markdown', async () => {
    const md = `# Hi\n\n> text ![a [b]](${file}#half "T") more\n\n![r][ref]\n\n<img src="${file}">\n\n[ref]: ${file}\n`
    const imgs = tags(await render(md), 'img')
    const first = imgs[0]!
    const from = Number(first.properties['dataImageFrom'])
    const to = Number(first.properties['dataImageTo'])
    expect(md.slice(from, to)).toBe(`![a [b]](${file}#half "T")`)
    // A reference image or raw HTML has no destination of its own to size.
    expect(imgs[1]?.properties['dataImageFrom']).toBeUndefined()
    expect(imgs[2]?.properties['dataImageFrom']).toBeUndefined()
  })

  it('keeps an image whose size fragment was escaped an image after its size is set to auto', async () => {
    const md = `![a](${file}\\#small)`
    const before = tags(await render(md), 'img')[0]!
    expect(classes(before)).toEqual(['image-size-small', 'image-block'])
    const from = Number(before.properties['dataImageFrom'])
    const to = Number(before.properties['dataImageTo'])
    const auto = setImageMarkdownSize(md.slice(from, to), 'auto')!
    const after = tags(await render(auto), 'img')
    expect(after).toHaveLength(1)
    expect(after[0]?.properties['src']).toBe(file)
  })

  it('marks images after front matter at their place in the whole note', async () => {
    const md = `---\ntitle: x\n---\n\n![a](${file})\n`
    const img = tags(await render(md), 'img')[0]!
    expect(
      md.slice(Number(img.properties['dataImageFrom']), Number(img.properties['dataImageTo'])),
    ).toBe(`![a](${file})`)
  })
})

describe('embeds', () => {
  const frame = (tree: Root) => tags(tree, 'iframe')[0]

  it('turns a YouTube URL on its own line into a privacy-enhanced embed', async () => {
    const tree = await render('Watch:\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\nAfter.')
    const iframe = frame(tree)
    expect(iframe?.properties['src']).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
    expect(iframe?.properties['title']).toBe('Embedded video')
  })

  it.each([
    ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    [
      'https://www.bilibili.com/video/BV1GJ411x7h7',
      'https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&autoplay=0',
    ],
  ])('embeds %s', async (url, src) => {
    expect(frame(await render(url))?.properties['src']).toBe(src)
  })

  it('keeps a video URL inside a sentence as a link', async () => {
    const tree = await render('See https://youtu.be/dQw4w9WgXcQ here')
    expect(tags(tree, 'iframe')).toHaveLength(0)
    expect(tags(tree, 'a')).toHaveLength(1)
  })

  it('rewrites every iframe to the safe form', async () => {
    const iframe = frame(
      await render(
        '<iframe src="https://player.vimeo.com/video/1" sandbox="allow-top-navigation allow-scripts" allow="camera; microphone" referrerpolicy="unsafe-url" onload="alert(1)"></iframe>',
      ),
    )
    expect(iframe?.properties).toEqual({
      src: 'https://player.vimeo.com/video/1',
      sandbox: [
        'allow-scripts',
        'allow-same-origin',
        'allow-popups',
        'allow-popups-to-escape-sandbox',
        'allow-presentation',
      ],
      allow: 'fullscreen; picture-in-picture; encrypted-media',
      allowFullScreen: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
      loading: 'lazy',
      title: 'Embedded video',
      className: ['embed-frame'],
    })
  })

  it('names a loaded embed by its video provider or its origin', async () => {
    const src = 'https://example.com/widget'
    const other = await render(`<iframe src="${src}"></iframe>`, { loadedEmbeds: [src] })
    expect(frame(other)?.properties['title']).toBe('Embedded content from example.com')
    const video = await render('<iframe src="https://player.vimeo.com/video/1"></iframe>')
    expect(frame(video)?.properties['title']).toBe('Embedded video')
  })

  it('shows a click-to-load placeholder for unknown origins', async () => {
    const tree = await render('<iframe src="https://example.com/widget"></iframe>')
    expect(tags(tree, 'iframe')).toHaveLength(0)
    const [placeholder] = byClass(tree, 'embed-placeholder')
    expect(placeholder?.properties['dataEmbedSrc']).toBe('https://example.com/widget')
    expect(placeholder && text(placeholder)).toContain('Embedded content from example.com')
    expect(placeholder && tags({ type: 'root', children: [placeholder] }, 'button')).toHaveLength(1)
  })

  it('loads an unknown origin once the user asked for it', async () => {
    const src = 'https://example.com/widget'
    const tree = await render(`<iframe src="${src}"></iframe>`, { loadedEmbeds: [src] })
    expect(frame(tree)?.properties['src']).toBe(src)
  })

  it('removes iframes that are not https', async () => {
    for (const src of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', '/local']) {
      const tree = await render(`<iframe src="${src}"></iframe>`)
      expect(tags(tree, 'iframe')).toHaveLength(0)
      expect(byClass(tree, 'embed-placeholder')).toHaveLength(0)
    }
  })
})

describe('preview renderer extension point', () => {
  it('runs registered renderers on the sanitized tree, in order', async () => {
    const registry = createPreviewRegistry()
    const seen: string[] = []
    registry.register({
      id: 'test.upper',
      apiVersion: PREVIEW_API_VERSION,
      transform(tree) {
        seen.push(tree.type)
        for (const h of elements(tree).filter((e) => e.tagName === 'h1')) {
          h.properties['dataTest'] = 'yes'
        }
      },
    })
    const tree = await renderPreview('# Hi', { labels, loadedEmbeds: [] }, registry)
    expect(seen).toEqual(['root'])
    expect(tags(tree, 'h1')[0]?.properties['dataTest']).toBe('yes')
  })

  it('rejects duplicate ids and unknown API versions', async () => {
    const registry = createPreviewRegistry()
    const renderer: PreviewRenderer = { id: 'x', apiVersion: PREVIEW_API_VERSION, transform() {} }
    const unregister = registry.register(renderer)
    expect(() => registry.register(renderer)).toThrow('E_PREVIEW_RENDERER_DUPLICATE')
    expect(() =>
      registry.register({ ...renderer, id: 'y', apiVersion: 99 as typeof PREVIEW_API_VERSION }),
    ).toThrow('E_PREVIEW_API_VERSION')
    unregister()
    expect(() => registry.register(renderer)).not.toThrow()
  })

  it('ships the built-in renderers through the same registry', async () => {
    expect(createPreviewRegistry({ builtins: true }).ids()).toEqual([
      'devot.frontmatter',
      'devot.alerts',
      'devot.tasks',
      'devot.math',
      'devot.emoji',
      'devot.mermaid',
      'devot.code',
      'devot.headingIds',
      'devot.swatches',
      'devot.images',
      'devot.links',
      'devot.note-links',
      'devot.video-embeds',
      'devot.iframes',
    ])
  })

  it('strips source positions so the tree stays small across the worker boundary', async () => {
    expect(JSON.stringify(await render('# Hi\n\ntext'))).not.toContain('"position"')
  })
})

describe('math', () => {
  const find = (tree: Root, tag: string) => elements(tree).filter((e) => e.tagName === tag)

  it('renders inline and block math as MathML', async () => {
    const tree = await render('Energy $E = mc^2$ and\n\n$$\n\\frac{a}{b}\n$$')
    const [inline] = byClass(tree, 'math-inline')
    const [block] = byClass(tree, 'math-display')
    expect(inline && find({ type: 'root', children: [inline] }, 'msup')).toHaveLength(1)
    expect(block && find({ type: 'root', children: [block] }, 'mfrac')).toHaveLength(1)
    expect(find(tree, 'pre')).toHaveLength(0)
  })

  it('keeps the TeX source in the MathML, so an exported page imports as math again', async () => {
    const tree = await render('Energy $E = mc^2$')
    const [annotation] = find(tree, 'annotation')
    expect(annotation?.properties['encoding']).toBe('application/x-tex')
    expect(annotation && text(annotation)).toBe('E = mc^2')
  })

  it('renders ```math blocks', async () => {
    expect(byClass(await render('```math\nx_1\n```'), 'math-display')).toHaveLength(1)
  })

  it('shows invalid math as its source, marked as an error', async () => {
    const [error] = byClass(await render('$\\frac{$'), 'math-error')
    expect(error && text(error)).toBe('\\frac{')
  })

  it('keeps no styles, classes or links in the MathML', async () => {
    const tree = await render('$\\color{red}{x} \\href{https://example.com}{y}$')
    for (const el of find(tree, 'math').flatMap((m) => elements(m))) {
      expect(Object.keys(el.properties).filter((k) => /style|class|href/i.test(k))).toEqual([])
    }
  })

  it('loads the math engine only for notes with math', async () => {
    let loads = 0
    const registry = createPreviewRegistry()
    registry.register(
      createMathRenderer(async () => {
        loads += 1
        return { render: () => '<math></math>', parse: () => ({ type: 'root', children: [] }) }
      }),
    )
    const prose = await renderPreview('Costs $5 and $6', { labels, loadedEmbeds: [] }, registry)
    expect(loads).toBe(0)
    expect(text(prose)).toBe('Costs $5 and $6')
    await renderPreview('Has $x$', { labels, loadedEmbeds: [] }, registry)
    expect(loads).toBe(1)
  })
})

describe('emoji', () => {
  it('turns shortcodes into emoji outside code', async () => {
    const tree = await render(':tada: done :nope: and `:tada:`')
    expect(text(tree)).toContain('\u{1F389} done :nope: and :tada:')
  })

  it('loads the shortcode table only when a shortcode appears', async () => {
    let loads = 0
    const registry = createPreviewRegistry()
    registry.register(
      createEmojiRenderer(async () => {
        loads += 1
        return new Map([['tada', '\u{1F389}']])
      }),
    )
    await renderPreview('Meeting at 10:30, ratio 3:4', { labels, loadedEmbeds: [] }, registry)
    expect(loads).toBe(0)
    const tree = await renderPreview('Done :tada:', { labels, loadedEmbeds: [] }, registry)
    expect(loads).toBe(1)
    expect(text(tree)).toContain('\u{1F389}')
  })
})

describe('mermaid', () => {
  it('turns a mermaid block into an island the page renders', async () => {
    const tree = await render('```mermaid\ngraph TD\n  A --> B\n```')
    const [island] = byClass(tree, 'island-mermaid')
    expect(island?.properties).toMatchObject({
      dataDevotIsland: 'mermaid',
      dataIslandSource: 'graph TD\n  A --> B\n',
    })
    expect(island?.children).toEqual([])
    expect(tags(tree, 'pre')).toHaveLength(0)
  })

  it('leaves other code blocks alone', async () => {
    expect(byClass(await render('```js\nmermaid()\n```'), 'island')).toHaveLength(0)
  })
})

describe('images from the web', () => {
  it('load as images, http and https alike', async () => {
    for (const src of ['https://example.com/chart.png', 'http://example.com/chart.png']) {
      const [img] = tags(await render(`![A chart](${src})`), 'img')
      expect(img?.properties['src']).toBe(src)
      expect(img?.properties['alt']).toBe('A chart')
    }
  })

  it('load from allowlisted HTML, without event attributes or script URLs', async () => {
    const tree = await render(
      '<img src="https://example.com/a.png" alt="x" onerror="alert(1)">\n\n<img src="javascript:alert(1)" alt="y">',
    )
    const [web, script] = tags(tree, 'img')
    expect(web?.properties['src']).toBe('https://example.com/a.png')
    expect(Object.keys(web?.properties ?? {}).some((k) => /^on/i.test(k))).toBe(false)
    expect(script?.properties['src']).toBeUndefined()
  })

  it('stay images inside a link', async () => {
    const tree = await render('[![x](https://example.com/a.png)](https://example.com/page)')
    expect(tags(tree, 'a')[0]?.properties['href']).toBe('https://example.com/page')
    expect(tags(tree, 'img')[0]?.properties['src']).toBe('https://example.com/a.png')
  })

  it('load without the size suffix, which becomes a class', async () => {
    const [img] = tags(await render('![x](https://example.com/a.png#half)'), 'img')
    expect(img?.properties['src']).toBe('https://example.com/a.png')
    expect(img?.properties['className']).toContain('image-size-half')
  })
})
