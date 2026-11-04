import { existsSync, readFileSync } from 'node:fs'
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
