import type { Element, Root, RootContent } from 'hast'
import { toHtml } from 'hast-util-to-html'
import { describe, expect, it } from 'vitest'
import { parseCodeInfo, renderPreview, type PreviewLabels } from '../../src/core'

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
    expect(parseCodeInfo(info)).toMatchObject(expected)
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
    const code = elements(block!).find((e) => e.tagName === 'code')!
    expect(classes(code)).toEqual(['language-js'])
    expect(byClass(code, 'hljs-keyword').map(text)).toEqual(['const'])
    expect(byClass(code, 'hljs-string').map(text)).toEqual(['"x"'])
    expect(text(code)).toBe('const a = "x" // hi')
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

  it('drops the blank lines before a closing fence, so the block does not end in a gap', async () => {
    const tree = await render('```py\nx = 1\n\n\n```\n\n```\nplain\n  \n```')
    expect(
      elements(tree)
        .filter((e) => e.tagName === 'code')
        .map(text),
    ).toEqual(['x = 1', 'plain'])
  })

  it('takes the language of a raw HTML block from its class', async () => {
    const tree = await render('<pre><code class="language-css">a { color: red }</code></pre>')
    expect(byClass(tree, 'code-lang').map(text)).toEqual(['CSS'])
  })
})

describe('parseCodeInfo meta', () => {
  it('reads line, url, branch, commit and filename', () => {
    expect(
      parseCodeInfo(
        'ts line=10-20 commit=a1b2c3d branch="feat/x" url=https://github.com/o/r/blob/a1b2c3d/a.ts#L10-L20 filename=a.ts',
      ),
    ).toEqual({
      language: 'ts',
      title: 'a.ts',
      filename: 'a.ts',
      line: { start: 10, end: 20 },
      url: 'https://github.com/o/r/blob/a1b2c3d/a.ts#L10-L20',
      branch: 'feat/x',
      commit: 'a1b2c3d',
    })
  })

  it('reads a single line and drops what it cannot trust', () => {
    expect(parseCodeInfo('js line=5').line).toEqual({ start: 5, end: null })
    expect(parseCodeInfo('js line=9-5').line).toBeNull()
    expect(parseCodeInfo('js line=0').line).toBeNull()
    expect(parseCodeInfo('js line=x').line).toBeNull()
    expect(parseCodeInfo('js url=http://example.com/a').url).toBeNull()
    expect(parseCodeInfo('js url=javascript:alert(1)').url).toBeNull()
    expect(parseCodeInfo(`js url=https://example.com/${'a'.repeat(2100)}`).url).toBeNull()
    expect(parseCodeInfo('js branch="a b"').branch).toBeNull()
    expect(parseCodeInfo('js commit=<img>').commit).toBeNull()
  })
})

describe('line numbers', () => {
  it('numbers the lines from line=N, beside the code and not in it', async () => {
    const tree = await render('```js line=5\nlet a\nlet b\n```')
    const [pre] = elements(tree).filter((e) => e.tagName === 'pre')
    expect(classes(pre!)).toEqual(['with-line-numbers'])
    const [gutter] = byClass(pre!, 'code-gutter')
    expect(text(gutter!)).toBe('5\n6')
    expect(gutter!.properties['ariaHidden']).toBe('true')
    const code = elements(pre!).find((e) => e.tagName === 'code')!
    expect(text(code)).toBe('let a\nlet b')
    expect(byClass(code, 'code-gutter')).toHaveLength(0)
    expect(pre!.children.filter((c) => c.type === 'element')).toHaveLength(2)
  })

  it('counts lines without a final break and numbers a block with no language', async () => {
    const tree = await render('``` line=3\nx\ny')
    expect(text(byClass(tree, 'code-gutter')[0]!)).toBe('3\n4')
    const other = await render('```js line=1\nx\n\ny\n```')
    expect(text(byClass(other, 'code-gutter')[0]!)).toBe('1\n2\n3')
  })

  it('leaves a block without line= alone', async () => {
    const tree = await render('```js\nx\n```')
    expect(byClass(tree, 'code-gutter')).toHaveLength(0)
  })
})

describe('code block source header', () => {
  it('shows the GitHub mark, the link, the lines and the commit', async () => {
    const url = 'https://github.com/o/r/blob/a1b2c3d/src/a.ts#L10-L20'
    const tree = await render(`\`\`\`ts line=10-20 commit=a1b2c3d url=${url}\nlet a\n\`\`\``)
    const [header] = byClass(tree, 'code-header')
    const [link] = byClass(header!, 'code-source')
    expect(link!.properties['href']).toBe('https://github.com/o/r/blob/a1b2c3d/src/a.ts')
    expect(text(link!)).toBe('o/r/blob/a1b2c3d/src/a.ts')
    expect(text(byClass(header!, 'code-lines-label')[0]!)).toBe('Lines 10 to 20')
    expect(text(byClass(header!, 'code-ref')[0]!)).toBe('in a1b2c3d')
    expect(text(byClass(header!, 'code-lang')[0]!)).toBe('TypeScript')
    const svg = elements(header!).find((e) => e.tagName === 'svg')!
    expect(classes(svg)).toEqual(['code-lang-icon'])
    const github = (await import('../../design/icons/languages.json')).default.icons.github
    expect(elements(svg)[1]!.properties['d']).toBe(github.path)
  })

  it('uses filename for the link text, names one line, and a branch', async () => {
    const tree = await render(
      '```py line=7 branch=main url=https://example.com/x/run.py#frag filename=run.py\nprint(1)\n```',
    )
    const [header] = byClass(tree, 'code-header')
    expect(text(byClass(header!, 'code-source')[0]!)).toBe('run.py')
    expect(byClass(header!, 'code-title')).toHaveLength(0)
    expect(byClass(header!, 'code-source')[0]!.properties['href']).toBe(
      'https://example.com/x/run.py',
    )
    expect(text(byClass(header!, 'code-lines-label')[0]!)).toBe('Line 7')
    expect(text(byClass(header!, 'code-ref')[0]!)).toBe('in main')
    const svg = elements(header!).find((e) => e.tagName === 'svg')!
    expect(elements(svg)[1]!.properties['d']).not.toBe(
      (await import('../../design/icons/languages.json')).default.icons.github.path,
    )
  })

  it('adds no header link for a url that is not https', async () => {
    const tree = await render('```js url=http://example.com/a.js\nlet a\n```')
    expect(byClass(tree, 'code-source')).toHaveLength(0)
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
    expect(text(code)).toBe('</code></pre><script>alert(1)</script>')
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
