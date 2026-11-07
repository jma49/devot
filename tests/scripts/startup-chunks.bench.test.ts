import { join } from 'node:path'
import { build, type Plugin } from 'vite'
import { beforeAll, expect, it, vi } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// What a window parses before its first paint, and the worker before `init` answers (#742).
// The budgets hold the gain: raise one only with a reason in the pull request.
const MAIN_EAGER_BUDGET = 2_350_000
const WORKER_EAGER_BUDGET = 950_000

// The window never parses or converts Markdown itself: the core worker does.
const MARKDOWN_STACK =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:unified|remark-[^/]+|micromark[^/]*|mdast-util-[^/]+|hast-util-from-html|hast-util-to-mdast|parse5|yaml)\/|\/src\/core\/(?:import|htmlImport|templates|frontMatter)\.ts$/
const SERVER_RENDERING =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?react-dom\/(?:server|cjs\/react-dom-server)/
const WORKER_LAZY =
  /\/src\/core\/(?:sync\/engine|mirror|import|htmlImport|export|htmlExport|ai)\.ts$/

interface Chunk {
  name: string
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
  expect(bytesOf(chunks)).toBeLessThan(MAIN_EAGER_BUDGET)
})

it('the core worker loads sync, the mirror, import, export and AI only when they are used', () => {
  const chunks = eager(worker, 'core.worker')
  expect(modulesOf(chunks, WORKER_LAZY)).toEqual([])
  expect(bytesOf(chunks)).toBeLessThan(WORKER_EAGER_BUDGET)
  // The lazy parts are still built, so the check above has something to check.
  expect(modulesOf([...worker.values()], WORKER_LAZY).length).toBeGreaterThan(0)
})
