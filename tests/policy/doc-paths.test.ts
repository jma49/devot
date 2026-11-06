import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

const files = listFiles('.')
const topLevel = new Set(files.map((file) => file.split('/')[0]))
// ADRs keep the paths of their day, some of them since removed on purpose.
const docs = files.filter((file) => file.endsWith('.md') && !file.startsWith('docs/adr/'))

// Docs name Rust files from `src-tauri` or `src-tauri/src`, and a folder's own files from beside it.
function resolves(doc: string, ref: string): boolean {
  return [ref, join(dirname(doc), ref), join('src-tauri', ref), join('src-tauri/src', ref)].some(
    (path) => existsSync(path),
  )
}

function deadPaths(doc: string): string[] {
  const refs = [...readFileSync(doc, 'utf8').matchAll(/`([\w.-]+(?:\/[\w.@-]+)+\/?)`/g)].map(
    (m) => m[1] ?? '',
  )
  return refs.filter(
    (ref) =>
      topLevel.has(ref.split('/')[0] ?? '') && !ref.includes('/target/') && !resolves(doc, ref),
  )
}

it('finds the docs', () => {
  expect(docs).toContain('docs/architecture.md')
})

it.each(docs)('%s names only paths that exist', (doc) => {
  expect(deadPaths(doc)).toEqual([])
})

const overview = 'docs/architecture.md'
const specs = readdirSync('docs/specs')
  .filter((name) => name.endsWith('.md'))
  .map((name) => `docs/specs/${name}`)

function anchors(doc: string): Set<string> {
  const headings = [...readFileSync(doc, 'utf8').matchAll(/^#+ (.+)$/gm)].map((m) => m[1] ?? '')
  return new Set(
    headings.map((heading) =>
      heading
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s/g, '-'),
    ),
  )
}

function deadLinks(doc: string): string[] {
  // Code spans and blocks show Markdown as written, so their links are examples.
  const prose = readFileSync(doc, 'utf8')
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/(`+)[\s\S]*?\1/g, '')
  const links = [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '')
  return links
    .filter((link) => !/^[a-z][\w+.-]*:/.test(link) && !link.startsWith('#'))
    .filter((link) => {
      const [path = '', anchor] = link.split('#')
      const target = join(dirname(doc), path)
      if (!existsSync(target)) return true
      return anchor !== undefined && !anchors(target).has(anchor)
    })
}

it('the architecture overview links every spec', () => {
  expect(specs.length).toBeGreaterThan(0)
  const text = readFileSync(overview, 'utf8')
  expect(specs.filter((spec) => !text.includes(`](${spec.replace('docs/', '')})`))).toEqual([])
})

it.each([overview, ...specs])('%s links only files and headings that exist', (doc) => {
  expect(deadLinks(doc)).toEqual([])
})
