import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../../src/core'

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
    expect(htmlToMarkdown('<p>Just text</p>')).toEqual({ title: null, markdown: 'Just text\n' })
    expect(htmlToMarkdown('<title>  </title><p>x</p>').title).toBeNull()
    expect(htmlToMarkdown('')).toEqual({ title: null, markdown: '' })
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
    const { markdown } = htmlToMarkdown(hostile)
    expect(markdown).not.toMatch(/alert|javascript:|onerror|onclick|secret|<|data:/i)
    expect(markdown).toContain('![](x.png)')
    expect(markdown).toContain('click')
    expect(markdown).toContain('text')
  })

  it('never writes a thematic break as `---`, which could read as front matter', () => {
    const { markdown } = htmlToMarkdown('<hr><p>a</p><hr><p>b</p>')
    expect(markdown.startsWith('---')).toBe(false)
  })
})
