import { join } from 'node:path'
import { build, type Plugin } from 'vite'
import { beforeAll, expect, it, vi } from 'vitest'
import { tempDir } from '../support/temp-dirs'
import { messages as browserExtensions } from '../../src/renderer/src/i18n/en/browserExtensions'

// What a window parses before its first paint, and the worker before `init` answers (#742).
// The budgets hold the gain: raise one only with a reason in the pull request.
const MAIN_EAGER_BUDGET = 2_403_300
const WORKER_EAGER_BUDGET = 968_100

// The window never parses or converts Markdown itself: the core worker does.
const MARKDOWN_STACK =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:unified|remark-[^/]+|micromark[^/]*|mdast-util-[^/]+|hast-util-from-html|hast-util-to-mdast|parse5|yaml)\/|\/src\/core\/(?:import|htmlImport|templates|frontMatter)\.ts$/
const SERVER_RENDERING =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?react-dom\/(?:server|cjs\/react-dom-server)/
const BROWSER_ONLY = /\/src\/renderer\/src\/i18n\/(?:en|zh-Hans)\/clipper\.ts$/
const EXTENSION_SETTINGS =
  /\/src\/renderer\/src\/(?:settings\/(?:HttpApiSection\.tsx|httpApi\.ts)|i18n\/(?:en|zh-Hans)\/browserExtensions\.ts)$/
const VIM = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@replit\/codemirror-vim\//
const WORKER_LAZY =
  /\/src\/(?:core\/(?:sync\/engine|mirror|import|htmlImport|export|htmlExport|ai|plugins\/(?:import|protocol))|renderer\/src\/importWorker)\.ts$/
const IMPORT_UI = /\/src\/(?:core\/import(?:Tree|Layout)\.ts|renderer\/src\/ImportDialog\.tsx)$/

interface Chunk {
  name: string
  code: string
  bytes: number
  isEntry: boolean
  imports: string[]
  modules: string[]
}

const root = join(import.meta.dirname, '../..')
const main = new Map<string, Chunk>()
const worker = new Map<string, Chunk>()

function record(into: Map<string, Chunk>): Plugin {
  return {
    name: 'record-chunks',
    generateBundle(_, bundle) {
      for (const [file, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue
        into.set(file, {
          name: chunk.name,
          code: chunk.code,
          bytes: Buffer.byteLength(chunk.code),
          isEntry: chunk.isEntry,
          imports: chunk.imports,
          modules: Object.keys(chunk.modules),
        })
      }
    },
  }
}

/** The entry and every chunk it imports statically: what loads before the entry runs. */
function eager(chunks: Map<string, Chunk>, name: string): Chunk[] {
  const entry = [...chunks].find(([, chunk]) => chunk.isEntry && chunk.name === name)?.[0]
  expect(entry).toBeDefined()
  const seen = new Set<string>()
  const queue = [entry!]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file) || !chunks.has(file)) continue
    seen.add(file)
    queue.push(...chunks.get(file)!.imports)
  }
  return [...seen].map((file) => chunks.get(file)!)
}

const bytesOf = (chunks: Chunk[]) => chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)
/** The packages, or the repository's own files, of the modules `pattern` matches. */
const modulesOf = (chunks: Chunk[], pattern: RegExp) => [
  ...new Set(
    chunks.flatMap((chunk) =>
      chunk.modules
        .filter((id) => pattern.test(id))
        .map(
          (id) =>
            /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id)?.[1] ?? id.slice(root.length + 1),
        ),
    ),
  ),
]

beforeAll(async () => {
  // Vitest runs with NODE_ENV=test, which would build React's development bundle.
  vi.stubEnv('NODE_ENV', 'production')
  await build({
    configFile: join(root, 'vite.config.ts'),
    cacheDir: tempDir('devot-vite-cache-'),
    logLevel: 'silent',
    plugins: [record(main)],
    worker: { plugins: () => [record(worker)] },
    build: { outDir: tempDir('devot-startup-build-'), emptyOutDir: true },
  })
  vi.unstubAllEnvs()
}, 180_000)

it('the main window loads no Markdown parsing or server rendering before its first paint', () => {
  const chunks = eager(main, 'main')
  expect(modulesOf(chunks, MARKDOWN_STACK)).toEqual([])
  expect(modulesOf(chunks, SERVER_RENDERING)).toEqual([])
  expect(modulesOf(chunks, BROWSER_ONLY)).toEqual([])
  expect(modulesOf(chunks, EXTENSION_SETTINGS)).toEqual([])
  expect(
    chunks.some((chunk) => chunk.code.includes(browserExtensions['browserExtensions.hint'])),
  ).toBe(false)
  expect(modulesOf(chunks, IMPORT_UI)).toEqual([])
  expect(modulesOf([...main.values()], IMPORT_UI).length).toBeGreaterThan(0)
  expect(modulesOf(chunks, /\/src\/renderer\/src\/TemplatePicker\.tsx$/)).toEqual([])
  expect(modulesOf(chunks, VIM)).toEqual([])
  expect(modulesOf([...main.values()], VIM)).toEqual(['@replit/codemirror-vim'])
  expect(bytesOf(chunks)).toBeLessThan(MAIN_EAGER_BUDGET)
})

it('the Settings window loads extension-registration controls and their messages', () => {
  const chunks = eager(main, 'settings')
  expect(modulesOf(chunks, EXTENSION_SETTINGS)).toHaveLength(3)
  expect(
    chunks.some((chunk) => chunk.code.includes(browserExtensions['browserExtensions.hint'])),
  ).toBe(true)
})

it('the core worker loads sync, the mirror, import, export and AI only when they are used', () => {
  const chunks = eager(worker, 'core.worker')
  expect(modulesOf(chunks, WORKER_LAZY)).toEqual([])
  expect(modulesOf(chunks, BROWSER_ONLY)).toEqual([])
  expect(bytesOf(chunks)).toBeLessThan(WORKER_EAGER_BUDGET)
  // The lazy parts are still built, so the check above has something to check.
  expect(modulesOf([...worker.values()], WORKER_LAZY).length).toBeGreaterThan(0)
})
