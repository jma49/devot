import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../../src/core'

// Hand-written pages in tests/core/fixtures/html-import: `pages/` convert to
// the Markdown beside them (`name.md`); `hostile/` holds XSS vectors that must
// come out as inert text, never as markup, script or a dangerous link.
const ROOT = join(__dirname, 'fixtures', 'html-import')

const fixtures = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => ({
      name,
      html: readFileSync(join(ROOT, dir, name), 'utf8'),
      markdown: readFileSync(join(ROOT, dir, name.replace(/\.html$/, '.md')), 'utf8'),
    }))

const TITLES: Record<string, string | null> = {
  'article.html': 'Notes on Slow Mornings',
  'documentation.html': 'Config reference',
  'images.html': 'Photo log',
  'legacy.html': 'Old Page',
}

const DROPPED: Record<string, string[]> = {
  'embeds.html': ['<iframe>', '<object>'],
  'handlers.html': [],
  'scripts.html': ['<svg>', '<math>'],
  'urls.html': ['data:text/html', "javascript:alert('PWNED')", 'data:image/svg+xml'],
}

const RAW_HTML = /(?<!\\)<[a-zA-Z!/?]/
const DANGEROUS_TARGET = /\]\(\s*(javascript|vbscript|data|file):/i
const EVENT_ATTRIBUTE = /\son[a-z]+\s*=/i

describe('sample pages convert to readable Markdown', () => {
  const pages = fixtures('pages')

  it('has a corpus to run', () => {
    expect(pages.length).toBeGreaterThanOrEqual(4)
  })

  for (const page of pages) {
    describe(`${page.name}`, () => {
      const out = htmlToMarkdown(page.html)

      it('matches its Markdown', () => {
        expect(out.markdown).toBe(page.markdown)
      })

      it('takes its title and leaves nothing out', () => {
        expect(out.title).toBe(TITLES[page.name])
        expect(out.dropped).toEqual([])
        expect(out.images).toEqual([])
      })

      it('is plain Markdown: no HTML, no blank-line runs, ends in one newline', () => {
        expect(out.markdown).not.toMatch(RAW_HTML)
        expect(out.markdown).not.toMatch(/\n{3,}/)
        expect(out.markdown).toMatch(/[^\n]\n$/)
      })
    })
  }
})

describe('hostile pages are neutralised', () => {
  const pages = fixtures('hostile')

  it('has a corpus to run', () => {
    expect(pages.map((p) => p.name)).toEqual(Object.keys(DROPPED).sort())
  })

  for (const page of pages) {
    describe(`${page.name}`, () => {
      const out = htmlToMarkdown(page.html)

      it('matches its Markdown', () => {
        expect(out.markdown).toBe(page.markdown)
      })

      it('writes no markup, event handler or dangerous link target', () => {
        expect(out.markdown).not.toMatch(RAW_HTML)
        expect(out.markdown).not.toMatch(DANGEROUS_TARGET)
        expect(out.markdown).not.toMatch(EVENT_ATTRIBUTE)
        expect(out.markdown).not.toMatch(/evil\.example|etc\/passwd/)
      })

      it('stores no image and names what it left out', () => {
        expect(out.images).toEqual([])
        expect(out.dropped).toEqual(DROPPED[page.name])
      })
    })
  }

  it('keeps the text a page shows, even beside an attack', () => {
    const byName = Object.fromEntries(fixtures('hostile').map((p) => [p.name, p.markdown]))
    expect(byName['scripts.html']).toContain('Visible text survives.')
    expect(byName['handlers.html']).toContain('[safe link](https://example.com/)')
    expect(byName['urls.html']).toContain('[fine](https://example.com/ok)')
    expect(byName['embeds.html']).toContain('Before')
    expect(byName['embeds.html']).toContain('After')
  })
})
