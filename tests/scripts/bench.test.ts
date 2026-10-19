import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'
import { expect, it } from 'vitest'
import { analyzeBundle } from '../../scripts/bench/bundle.ts'
import {
  bodyState,
  bookOf,
  diagramCount,
  libraryBooks,
  sampleNote,
  SAMPLE_END,
} from '../../scripts/bench/fixtures.ts'
import { percentile, summarize } from '../../scripts/bench/stats.ts'
import { tempDir } from '../support/temp-dirs'

// The helpers behind `pnpm bench` (scripts/bench, docs/benchmarks/README.md).

it('summarizes by nearest rank', () => {
  expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3)
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9)
  expect(percentile([], 0.5)).toBeNaN()
  expect(summarize([10, 20, 30, 40, 1000])).toEqual({
    n: 5,
    median: 30,
    p90: 1000,
    min: 10,
    max: 1000,
  })
})

it.each([20_000, 100_000])(
  'a %i byte sample has every block type and ends with its marker',
  (bytes) => {
    const text = sampleNote(bytes)
    expect(text.length).toBeGreaterThan(bytes * 0.95)
    expect(text.length).toBeLessThan(bytes * 1.15)
    expect(text).toBe(sampleNote(bytes))
    expect(text.endsWith(SAMPLE_END)).toBe(true)
    expect(text.match(/^```mermaid$/gm)).toHaveLength(diagramCount(bytes))
    for (const lang of ['ts', 'python', 'rust', 'bash', 'json', 'css', 'html', 'sql', 'go', 'yaml'])
      expect(text).toContain(`\`\`\`${lang}`)
    for (const part of [
      '\n| Name |',
      '\n$$\n',
      '\n> [!NOTE]',
      '\n- [x] ',
      '\n![Figure ',
      '\n1. Step',
    ])
      expect(text).toContain(part)
    expect([...text].every((c) => c.charCodeAt(0) < 128)).toBe(true)
  },
)

it('the library puts half the notes in one notebook and leaves a tenth unfiled', () => {
  const books = libraryBooks(10_000)
  expect(books).toHaveLength(50)
  expect(libraryBooks(1000)).toHaveLength(12)
  const counts = new Map<number | null, number>()
  for (let i = 0; i < 1000; i += 1) {
    const book = bookOf(i, books.length)
    counts.set(book, (counts.get(book) ?? 0) + 1)
  }
  expect(counts.get(null)).toBe(100)
  expect(counts.get(0)).toBe(500)
  expect([...counts.keys()].every((k) => k === null || (k >= 0 && k < books.length))).toBe(true)
})

it('a note body goes into the state the editor opens from', () => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(bodyState('# Title\n\nText')))
  expect(doc.getText('body').toString()).toBe('# Title\n\nText')
})

it('the bundle report counts what the page reaches statically as startup', () => {
  const dir = tempDir('devot-bench-bundle-')
  mkdirSync(join(dir, 'assets'))
  const write = (file: string, text: string) => writeFileSync(join(dir, file), text)
  write(
    'index.html',
    '<script type="module" src="/assets/main.js"></script><link rel="modulepreload" href="/assets/vendor.js"><link rel="stylesheet" href="/assets/main.css">',
  )
  write(
    'assets/main.js',
    'import{a}from"./vendor.js";const l=()=>import("./lazy.js");new Worker("core.worker-1.js")',
  )
  write('assets/vendor.js', 'export const a=1')
  write('assets/lazy.js', 'import"./lazy-dep.js"')
  write('assets/lazy-dep.js', 'export const b=2')
  write('assets/main.css', '@font-face{src:url(./font.woff2)}')
  write('assets/font.woff2', 'fontfontfont')
  write('assets/core.worker-1.js', 'import{c}from"./core-shared.js";import("./math.js")')
  write('assets/core-shared.js', 'export const c=3')
  write('assets/math.js', 'export const m=4')
  write('settings.html', '<script type="module" src="/assets/settings.js"></script>')
  write('assets/settings.js', 'export const s=5')

  const report = analyzeBundle(dir)
  expect(report.startupMain.files).toBe(4)
  expect(report.startupMain.css).toBe('@font-face{src:url(./font.woff2)}'.length)
  expect(report.startupMain.other).toBe('fontfontfont'.length)
  expect(report.startupWorker.files).toBe(2)
  expect(report.lazy.files).toBe(4)
  expect(report.lazy.largest.map((f) => f.file)).toContain('assets/math.js')
  expect(report.lazy.largest.map((f) => f.file)).toContain('assets/settings.js')
  expect(report.total.files).toBe(10)
})
