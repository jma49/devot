// `pnpm bench`: the renderer's performance baseline (docs/benchmarks/README.md).
// It builds the UI the way the UI tests do (production build, notes in the
// in-memory storage, Tauri's IPC mocked), serves it under the production
// CSP, drives it in Playwright's WebKit and writes docs/benchmarks/results.json.
// usage: node scripts/bench/run.ts [--quick] [--out <file>]
import { devices, webkit, type Browser, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { arch, cpus, loadavg, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mockTauri } from '../../tests/ui/fixtures.ts'
import { analyzeBundle } from './bundle.ts'
import {
  bodyState,
  bookOf,
  libraryBody,
  libraryBooks,
  sampleNote,
  SAMPLE_END,
  SAMPLE_IMAGE,
  diagramCount,
} from './fixtures.ts'
import { installBench } from './page.ts'
import { round, summarize } from './stats.ts'

const ROOT = join(import.meta.dirname, '../..')
const UI_DIR = 'dist-bench'
const APP_DIR = 'dist-bench-app'
const args = process.argv.slice(2)
const quick = args.includes('--quick')
const out = args.includes('--out')
  ? args[args.indexOf('--out') + 1]!
  : 'docs/benchmarks/results.json'

const RUNS = quick
  ? { ready: 3, open: 3, keys: 6, cycles: 2, scroll: 1 }
  : { ready: 9, open: 15, keys: 30, cycles: 8, scroll: 5 }
const SAMPLES = [
  { label: '20 KB', bytes: 20_000 },
  { label: '100 KB', bytes: 100_000 },
]
const LIBRARIES = quick ? [1000] : [1000, 10_000]
const NOW = Date.UTC(2026, 0, 1)

const log = (message: string) => console.log(`bench: ${message}`)

function sh(command: string, argv: string[], env: Record<string, string> = {}): string {
  return execFileSync(command, argv, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

const id = (kind: number, n: number) =>
  `0192a6f0-0000-7000-${kind}000-${String(n).padStart(12, '0')}`

function noteRecord(n: number, title: string, body: string, bookId: string | null, at: number) {
  return {
    id: id(8, n),
    title,
    titleHlc: '',
    bodyMd: body,
    ydoc: [0, 0] as number[],
    bookId,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    deletedHlc: null,
  }
}

function bookRecord(book: { id: string; name: string }) {
  return {
    id: book.id,
    name: book.name,
    nameHlc: 'h',
    parentId: null,
    parentHlc: 'h',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    deletedHlc: null,
    aiAccess: false,
    aiAccessHlc: '',
    icon: null,
    iconColor: null,
    iconHlc: '',
    sortKey: '',
    sortKeyHlc: '',
  }
}

interface Library {
  notes: ReturnType<typeof noteRecord>[]
  books: ReturnType<typeof bookRecord>[]
  views: Map<string, { count: number; first: string }>
}

function library(count: number, samples: { title: string; body: string }[] = []): Library {
  const books = libraryBooks(count)
  const views = new Map([['All Notes', { count: count + samples.length, first: 'Note 1' }]])
  const notes = Array.from({ length: count }, (_, i) => {
    const book = bookOf(i, books.length)
    if (book !== null) {
      const name = books[book]!.name
      const seen = views.get(name)
      views.set(name, { count: (seen?.count ?? 0) + 1, first: seen?.first ?? `Note ${i + 1}` })
    }
    return noteRecord(
      i + 1,
      `Note ${i + 1}`,
      libraryBody(i),
      book === null ? null : books[book]!.id,
      NOW - (i + 1) * 60_000,
    )
  })
  samples.forEach((sample, k) => {
    const record = noteRecord(
      count + 1 + k,
      sample.title,
      sample.body,
      null,
      NOW + (k + 1) * 60_000,
    )
    record.ydoc = bodyState(sample.body)
    notes.unshift(record)
  })
  return { notes, books: books.map(bookRecord), views }
}

const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="100%" height="100%" fill="teal"/></svg>'

async function openPage(browser: Browser, base: string): Promise<Page> {
  const context = await browser.newContext({
    ...devices['Desktop Safari'],
    reducedMotion: 'reduce',
    baseURL: base,
  })
  const page = await context.newPage()
  await mockTauri(page)
  await page.addInitScript(installBench)
  await page.route(`**${SAMPLE_IMAGE}**`, (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: IMAGE }),
  )
  return page
}

const ready = (page: Page) => page.locator('.window[data-ready]').waitFor({ timeout: 120_000 })

async function seed(page: Page, data: Library): Promise<void> {
  await page.goto('/')
  await page.evaluate(
    ({ notes, books }) => {
      localStorage.clear()
      localStorage.setItem('devot.test.notes', notes)
      localStorage.setItem('devot.test.books', books)
    },
    { notes: JSON.stringify(data.notes), books: JSON.stringify(data.books) },
  )
  await page.reload()
  await ready(page)
}

// oxlint-disable-next-line typescript/no-explicit-any
type Win = any

const noteList = (page: Page) => page.getByRole('listbox', { name: 'Notes' })

async function startup(browser: Browser, base: string, data: Library) {
  const page = await openPage(browser, base)
  await seed(page, data)
  const times: number[] = []
  let loaded: { files: number; bytes: number } = { files: 0, bytes: 0 }
  for (let i = 0; i < RUNS.ready; i += 1) {
    await page.reload()
    await ready(page)
    const run = await page.evaluate(() => {
      const w = globalThis as Win
      const resources = w.performance.getEntriesByType('resource') as { decodedBodySize: number }[]
      return {
        at: w.devotBench.readyAt as number,
        files: resources.length,
        bytes: resources.reduce((sum, r) => sum + r.decodedBodySize, 0),
      }
    })
    times.push(run.at)
    loaded = run
  }
  await page.context().close()
  // The first run is cold; the rest reload with a warm HTTP cache.
  return { readyMs: summarize(times), firstReadyMs: round(times[0]!), loaded }
}

interface OpenResult {
  editor: number
  preview: number
  mermaid: number
}

async function openOnce(page: Page, title: string, diagrams: number): Promise<OpenResult> {
  return page.evaluate(
    async ({ title: noteTitle, diagrams: count, end }) => {
      const w = globalThis as Win
      const b = w.devotBench
      const doc = w.document
      const rows = [...doc.querySelectorAll('[role=listbox][aria-label=Notes] [role=option]')]
      const row = rows.find((r: Win) => r.querySelector('.row-title')?.textContent === noteTitle)
      // The editor lives in a shadow root.
      const body = () =>
        doc.querySelector('[data-devot-part=editor-body]')?.shadowRoot?.querySelector('.cm-content')
          ?.textContent ?? ''
      const preview = () => doc.querySelector('article[aria-label=Preview]')
      const t0 = w.performance.now()
      row.click()
      const track = async (done: () => boolean, timeout?: number) => {
        const ms = await b.when(done, t0, timeout)
        if (ms < 0) return -1
        await b.painted()
        return w.performance.now() - t0
      }
      const [editor, shown, mermaid] = await Promise.all([
        track(() => body().includes('Benchmark sample')),
        track(() => (preview()?.textContent ?? '').includes(end)),
        track(
          () => (preview()?.querySelectorAll('.island-mermaid svg').length ?? 0) >= count,
          30_000,
        ),
      ])
      return { editor, preview: shown, mermaid }
    },
    { title, diagrams, end: SAMPLE_END },
  )
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

async function openAndType(browser: Browser, base: string, bytes: number, label: string) {
  const small = { title: 'Small note', body: 'Just a few words.' }
  const sample = { title: `Sample ${label}`, body: sampleNote(bytes) }
  const diagrams = diagramCount(bytes)
  const page = await openPage(browser, base)
  await seed(page, library(1000, [sample, small]))
  await noteList(page).getByRole('option').first().click()
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()

  const runs: OpenResult[] = []
  for (let i = 0; i < RUNS.open; i += 1) {
    await openOnce(page, small.title, 0).catch(() => undefined)
    await page.getByRole('textbox', { name: 'Note body' }).getByText('Just a few words.').waitFor()
    await page.waitForTimeout(400)
    runs.push(await openOnce(page, sample.title, diagrams))
    log(`open ${label} #${i + 1}: preview ${runs.at(-1)!.preview.toFixed(0)} ms`)
  }
  const warm = runs.slice(1)
  const field = (key: keyof OpenResult) => warm.map((r) => r[key]).filter((v) => v >= 0)
  const open = {
    first: runs[0],
    warm: {
      editorMs: summarize(field('editor')),
      previewMs: summarize(field('preview')),
      mermaidMs: field('mermaid').length > 0 ? summarize(field('mermaid')) : null,
    },
  }

  await page.waitForTimeout(1500)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.press('Meta+ArrowUp')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const letters = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnop'.slice(0, RUNS.keys)
  let typed = ''
  for (const letter of letters) {
    typed += letter
    await page.evaluate((text) => ((globalThis as Win).devotBench.expect = text), typed)
    await page.keyboard.press(letter)
    await page.waitForFunction(() => {
      const keys = (globalThis as Win).devotBench.keys as { editor: number; preview: number }[]
      const last = keys.at(-1)
      return last !== undefined && last.editor >= 0 && last.preview >= 0
    })
    await page.waitForTimeout(120)
  }
  const keys = await page.evaluate(
    () => (globalThis as Win).devotBench.keys as { editor: number; preview: number }[],
  )
  await page.context().close()
  const typing = {
    keys: keys.length,
    editorMs: summarize(keys.map((k) => k.editor)),
    previewMs: summarize(keys.map((k) => k.preview)),
  }
  log(`typing ${label}: editor ${typing.editorMs.median} ms, preview ${typing.previewMs.median} ms`)
  return { open, typing, openMean: round(mean(runs.map((r) => r.preview))) }
}

async function clickSidebar(
  page: Page,
  name: string,
  view: { count: number; first: string },
): Promise<number> {
  return page.evaluate(
    async ({ name: target, view: shown }) => {
      const w = globalThis as Win
      const b = w.devotBench
      const doc = w.document
      const norm = (text: string) => text.replace(/[\d,]+$/, '').trim()
      const matches = [...doc.querySelectorAll('*')].filter(
        (e: Win) => (e.textContent ?? '').length < 80 && norm(e.textContent ?? '') === target,
      )
      const leaf = matches.find((e: Win) => !matches.some((m: Win) => m !== e && e.contains(m)))
      const caption = `${shown.count.toLocaleString('en-US')} notes`
      const done = () =>
        doc.querySelector('.list-count')?.textContent === caption &&
        doc.querySelector('[role=listbox][aria-label=Notes] [role=option] .row-title')
          ?.textContent === shown.first
      const t0 = w.performance.now()
      leaf.click()
      const ms = await b.when(done, t0)
      if (ms < 0) return -1
      await b.painted()
      return w.performance.now() - t0
    },
    { name, view },
  )
}

async function lists(browser: Browser, base: string, count: number) {
  const data = library(count)
  const page = await openPage(browser, base)
  await seed(page, data)
  const big = data.books[0]!.name
  const small = data.books.slice(1).map((b) => b.name)
  const toAll: number[] = []
  const toBig: number[] = []
  const toSmall: number[] = []
  for (let i = 0; i < RUNS.cycles; i += 1) {
    for (const [name, into] of [
      [big, toBig],
      ['All Notes', toAll],
      [small[i % small.length]!, toSmall],
      ['All Notes', toAll],
    ] as const) {
      const ms = await clickSidebar(page, name, data.views.get(name)!)
      if (ms >= 0) into.push(ms)
      await page.waitForTimeout(150)
    }
  }
  const frames: number[] = []
  for (let i = 0; i < RUNS.scroll; i += 1) {
    frames.push(
      ...(await page.evaluate(
        () => (globalThis as Win).devotBench.scrollList('Notes', 240, 48) as Promise<number[]>,
      )),
    )
  }
  const rendered = await noteList(page).getByRole('option').count()
  await page.context().close()
  const slow = frames.filter((ms) => ms > 20).length
  log(`list ${count}: to All ${summarize(toAll).median} ms, to big ${summarize(toBig).median} ms`)
  return {
    notes: count,
    notebooks: data.books.length,
    switchMs: {
      toAllNotes: summarize(toAll),
      toBigNotebook: summarize(toBig),
      toSmallNotebook: summarize(toSmall),
    },
    scroll: {
      frameMs: summarize(frames),
      framesOver20ms: round((100 * slow) / frames.length),
      rowsRendered: rendered,
    },
  }
}

function machine(browser: Browser) {
  const cpu = cpus()
  return {
    model: sh('sysctl', ['-n', 'hw.model']),
    cpu: sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
    cores: cpu.length,
    memoryGB: Math.round(totalmem() / 2 ** 30),
    os: `macOS ${sh('sw_vers', ['-productVersion'])} (Darwin ${release()}, ${arch()})`,
    node: process.version,
    webkit: browser.version(),
    loadAverageAtStart: round(loadavg()[0]!, 2),
  }
}

let server: ChildProcess | undefined
const cleanup = () => {
  server?.kill()
  rmSync(join(ROOT, UI_DIR), { recursive: true, force: true })
  rmSync(join(ROOT, APP_DIR), { recursive: true, force: true })
}
process.on('exit', cleanup)

async function main() {
  const env = { DEVOT_SENTRY_DSN: '' }
  log('building the UI (with the in-memory storage) and the app bundle')
  sh(
    'pnpm',
    [
      'vite',
      'build',
      '--config',
      'vite.ui-test.config.ts',
      '--outDir',
      `../../${UI_DIR}`,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    env,
  )
  sh(
    'pnpm',
    ['vite', 'build', '--outDir', `../../${APP_DIR}`, '--emptyOutDir', '--logLevel', 'error'],
    env,
  )
  const bundle = analyzeBundle(join(ROOT, APP_DIR))

  const port = await freePort()
  server = spawn('node', ['scripts/serve-csp.ts', UI_DIR, String(port)], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  const base = `http://localhost:${port}`
  for (let i = 0; i < 50; i += 1) {
    if (
      await fetch(base).then(
        (r) => r.ok,
        () => false,
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const browser = await webkit.launch()
  try {
    const results: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      commit: `${sh('git', ['rev-parse', '--short', 'HEAD'])}${sh('git', ['status', '--porcelain']) ? '+dirty' : ''}`,
      quick,
      machine: machine(browser),
      bundle,
    }
    log('startup')
    const starts: Record<string, unknown> = {}
    for (const count of LIBRARIES)
      starts[`${count}Notes`] = await startup(browser, base, library(count))
    results['startup'] = starts
    const open: Record<string, unknown> = {}
    const typing: Record<string, unknown> = {}
    for (const sample of SAMPLES) {
      const key = sample.label.replace(' ', '')
      const run = await openAndType(browser, base, sample.bytes, sample.label)
      open[key] = run.open
      typing[key] = run.typing
    }
    results['open'] = open
    results['typing'] = typing
    const lib: Record<string, unknown> = {}
    for (const count of LIBRARIES) lib[`${count}Notes`] = await lists(browser, base, count)
    results['list'] = lib

    mkdirSync(dirname(resolve(ROOT, out)), { recursive: true })
    writeFileSync(resolve(ROOT, out), `${JSON.stringify(results, null, 2)}\n`)
    log(`wrote ${out}`)
  } finally {
    await browser.close()
  }
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
cleanup()
