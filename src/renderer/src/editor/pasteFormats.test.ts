import { describe, expect, it } from 'vitest'
import { parseGithubBlobUrl } from '../../../core/codeMeta'
import {
  escapeLinkText,
  formatUrl,
  pasteFormats,
  snippetFence,
  snippetLanguage,
} from './pasteFormats'

const types = (url: string) => pasteFormats(url).map((f) => f.type)
const SHA = '0123456789abcdef0123456789abcdef01234567'

describe('pasteFormats', () => {
  it('lists the formats in order, the snippet only for a GitHub file', () => {
    expect(types('https://github.com/o/r/blob/main/src/a.ts#L5')).toEqual([
      'plain',
      'snippet',
      'title',
      'emptyText',
      'autolink',
    ])
    expect(types('https://example.com/a')).toEqual(['plain', 'title', 'emptyText', 'autolink'])
    expect(types('https://github.com/o/r/tree/main/src')).not.toContain('snippet')
    expect(
      pasteFormats('https://github.com/o/r/blob/main/a.ts', { block: false }).map((f) => f.type),
    ).not.toContain('snippet')
  })

  it('fetches titles over https only, and leaves out what a URL cannot be', () => {
    expect(types('http://example.com/a')).toEqual(['plain', 'emptyText', 'autolink'])
    expect(types('mailto:me@example.com')).toEqual(['plain', 'emptyText', 'autolink'])
    expect(types('https://example.com/<a>')).not.toContain('autolink')
    expect(types('https://github.com/o/r/blob/main/a`b.ts')).not.toContain('snippet')
  })
})

describe('escapeLinkText', () => {
  it('escapes what would end or change the link text', () => {
    expect(escapeLinkText('a [b] (c) `d` {e} <f> g|h *i* \\j')).toBe(
      'a \\[b\\] \\(c\\) \\`d\\` \\{e\\} \\<f\\> g\\|h \\*i\\* \\\\j',
    )
    expect(escapeLinkText('~~x~~ _y_')).toBe('\\~\\~x\\~\\~ \\_y\\_')
    expect(escapeLinkText('Plain title')).toBe('Plain title')
  })
})

describe('formatUrl', () => {
  const url = 'https://example.com/a_(b)|c'

  it('writes each format, with the selection where it belongs', () => {
    expect(formatUrl('plain', url, null)).toEqual({
      insert: url,
      anchor: url.length,
      head: url.length,
    })
    expect(formatUrl('autolink', 'https://a.b/x|y', null).insert).toBe('<https://a.b/x%7Cy>')
    expect(formatUrl('emptyText', 'https://a.b/', null)).toEqual({
      insert: '[](https://a.b/)',
      anchor: 1,
      head: 1,
    })
    expect(formatUrl('emptyText', url, null).insert).toBe('[](https://example.com/a_(b)%7Cc)')
    expect(formatUrl('title', 'https://a.b/', 'A [B]')).toEqual({
      insert: '[A \\[B\\]](https://a.b/)',
      anchor: 1,
      head: 8,
    })
  })

  it('puts a snippet on lines of its own', () => {
    const fence = '```\nx\n```'
    expect(formatUrl('snippet', url, fence).insert).toBe(fence)
    const both = formatUrl('snippet', url, fence, { before: true, after: true })
    expect(both.insert).toBe(`\n${fence}\n`)
    expect(both.head).toBe(1 + fence.length)
  })
})

describe('snippetLanguage', () => {
  it('names the language by file name or extension', () => {
    expect(snippetLanguage('src/a.ts')).toBe('ts')
    expect(snippetLanguage('lib/Main.RS')).toBe('rs')
    expect(snippetLanguage('Dockerfile')).toBe('dockerfile')
    expect(snippetLanguage('a/Makefile')).toBe('makefile')
    expect(snippetLanguage('.env')).toBe('env')
    expect(snippetLanguage('LICENSE')).toBe('')
    expect(snippetLanguage('.gitignore')).toBe('')
  })
})

describe('snippetFence', () => {
  const blob = (url: string) => {
    const parsed = parseGithubBlobUrl(url)
    expect(parsed).not.toBeNull()
    return parsed!
  }
  const code = 'one\r\ntwo\nthree\nfour\n'

  it('fences the whole file with its branch and URL', () => {
    const url = 'https://github.com/o/r/blob/main/src/a.ts'
    expect(snippetFence(code, blob(url), url)).toBe(
      `\`\`\`ts branch=main url=${url}\none\ntwo\nthree\nfour\n\`\`\``,
    )
  })

  it('slices the lines a fragment names, with a short commit', () => {
    const range = `https://github.com/o/r/blob/${SHA}/a.py#L2-L3`
    expect(snippetFence(code, blob(range), range)).toBe(
      `\`\`\`py line=2-3 commit=0123456 url=${range}\ntwo\nthree\n\`\`\``,
    )
    const one = 'https://github.com/o/r/blob/v1.0/a.py#L4'
    expect(snippetFence(code, blob(one), one)).toBe(
      `\`\`\`py line=4 branch=v1.0 url=${one}\nfour\n\`\`\``,
    )
  })

  it('gives nothing for lines the file does not have', () => {
    const past = 'https://github.com/o/r/blob/main/a.py#L9'
    expect(snippetFence(code, blob(past), past)).toBeNull()
  })

  it('makes the fence longer than any backtick run in the code', () => {
    const url = 'https://github.com/o/r/blob/main/README'
    expect(snippetFence('a ```` b', blob(url), url)).toBe(
      `\`\`\`\`\`branch=main url=${url}\na \`\`\`\` b\n\`\`\`\`\``,
    )
  })
})
