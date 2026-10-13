import type { Element, Root, RootContent } from 'hast'
import { toHtml } from 'hast-util-to-html'
import { describe, expect, it } from 'vitest'
import { parseCodeInfo, renderPreview, type PreviewLabels } from '../../src/core'

// Code blocks in the preview: a header with the language and a title, read
// from the fence's info string, and highlighting built from text only.

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
}

const render = (md: string) => renderPreview(md, { labels, loadedEmbeds: [] })

function elements(tree: Root | Element): Element[] {
  const out: Element[] = []
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element') out.push(node)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return out
}
const classes = (e: Element) => (e.properties['className'] as string[] | undefined) ?? []
const byClass = (tree: Root | Element, name: string) =>
  elements(tree).filter((e) => classes(e).includes(name))
const text = (node: Root | RootContent): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(text).join('') : ''

describe('parseCodeInfo', () => {
  it.each([
    ['js', { language: 'js', title: null }],
    ['JS:app.js', { language: 'js', title: 'app.js' }],
    ['ts title="src/app.ts"', { language: 'ts', title: 'src/app.ts' }],
    ["py   title='my script.py' {1,3}", { language: 'py', title: 'my script.py' }],
    ['sh filename=run.sh', { language: 'sh', title: 'run.sh' }],
    ['', { language: null, title: null }],
    [':notes.txt', { language: null, title: 'notes.txt' }],
    ['<b>bad</b>', { language: null, title: null }],
  ])('reads %j', (info, expected) => {
    expect(parseCodeInfo(info)).toEqual(expected)
  })

  it('keeps a title short', () => {
    expect(parseCodeInfo(`js:${'a'.repeat(500)}`).title).toHaveLength(200)
  })
})

describe('code blocks', () => {
  it('gives a fenced block a header with its title, language and mark', async () => {
    const tree = await render('```js:app.js\nconst a = "x" // hi\n```')
    const [block] = byClass(tree, 'code-block')
    expect(block?.properties['dataLanguage']).toBe('js')
    const [header] = byClass(block!, 'code-header')
    expect(text(byClass(header!, 'code-title')[0]!)).toBe('app.js')
    expect(text(byClass(header!, 'code-lang')[0]!)).toBe('JavaScript')
    const svg = elements(header!).find((e) => e.tagName === 'svg')
    expect(classes(svg!)).toEqual(['code-lang-icon'])
    // Highlighted, with the code's text unchanged.
    const code = elements(block!).find((e) => e.tagName === 'code')!
    expect(classes(code)).toEqual(['language-js'])
    expect(byClass(code, 'hljs-keyword').map(text)).toEqual(['const'])
    expect(byClass(code, 'hljs-string').map(text)).toEqual(['"x"'])
    expect(text(code)).toBe('const a = "x" // hi\n')
  })

  it('reads the title attribute, also in a list or a quote', async () => {
    const tree = await render(
      '- item\n\n  ```py title="run.py"\n  print(1)\n  ```\n\n> ```ts title="q.ts"\n> let x\n> ```',
    )
    expect(byClass(tree, 'code-title').map(text)).toEqual(['run.py', 'q.ts'])
    expect(byClass(tree, 'code-lang').map(text)).toEqual(['Python', 'TypeScript'])
  })

  it('names an unknown language as written with a generic mark, and leaves a bare block alone', async () => {
    const tree = await render('```brainfork\n+++\n```\n\n```\nplain\n```\n\n    indented')
    const [block] = byClass(tree, 'code-block')
    expect(text(byClass(block!, 'code-lang')[0]!)).toBe('brainfork')
    expect(byClass(block!, 'code-lang-icon-generic')).toHaveLength(1)
    expect(byClass(tree, 'code-block')).toHaveLength(1)
    expect(elements(tree).filter((e) => e.tagName === 'pre')).toHaveLength(3)
  })

  it('takes the language of a raw HTML block from its class', async () => {
    const tree = await render('<pre><code class="language-css">a { color: red }</code></pre>')
    expect(byClass(tree, 'code-lang').map(text)).toEqual(['CSS'])
  })
})

describe('code blocks stay safe', () => {
  it('shows markup in a title, a language or the code as text', async () => {
    const tree = await render(
      [
        '```js title="<img src=x onerror=alert(1)>"',
        '</code></pre><script>alert(1)</script>',
        '```',
        '',
        '```<svg/onload=alert(1)>',
        'x',
        '```',
      ].join('\n'),
    )
    const html = toHtml(tree)
    expect(html).not.toMatch(/<img|<script|<svg\/onload/i)
    expect(elements(tree).some((e) => /^(img|script)$/.test(e.tagName))).toBe(false)
    expect(text(byClass(tree, 'code-title')[0]!)).toBe('<img src=x onerror=alert(1)>')
    const code = elements(tree).find((e) => e.tagName === 'code')!
    expect(text(code)).toBe('</code></pre><script>alert(1)</script>\n')
    // Only Devot's own marks are SVG: one per header.
    const svgs = elements(tree).filter((e) => e.tagName === 'svg')
    expect(svgs).toHaveLength(byClass(tree, 'code-header').length)
  })

  it('drops SVG and handlers from raw HTML code blocks before adding its own', async () => {
    const tree = await render(
      '<pre onclick="x()"><code class="language-js" style="color:red"><svg><path d="M0"/></svg>let a</code></pre>',
    )
    const html = toHtml(tree)
    expect(html).not.toMatch(/onclick|style=|<path d="M0"/)
    const code = elements(tree).find((e) => e.tagName === 'code')!
    expect(text(code)).toBe('let a')
  })
})
