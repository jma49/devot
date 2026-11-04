import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { boundaries } from '../../scripts/ci/ui-plan.ts'
import { uiGraph, uiReach } from '../../scripts/ci/ui-graph.ts'
import { listFiles } from '../support/git-files'
import { tempDir } from '../support/temp-dirs'

function repo(files: Record<string, string>): string {
  const root = tempDir('devot-ui-graph-')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const page = (module: string) =>
  `<!doctype html><script type="module" src="/src/${module}"></script>`

it('follows every import form the UI uses, up to the page that loads it', () => {
  const root = repo({
    'src/renderer/index.html': page('main.tsx'),
    'src/renderer/src/main.tsx': [
      "import './app.css'",
      'import {',
      '  a,',
      "} from './multi'",
      "export { b } from './reexport'",
      "const lazy = () => import('./lazy')",
      "new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' })",
      "import text from './welcome/welcome.md?raw'",
      "import { c } from './folder'",
    ].join('\n'),
    'src/renderer/src/app.css': '',
    'src/renderer/src/multi.ts': '',
    'src/renderer/src/reexport.ts': '',
    'src/renderer/src/lazy.tsx': '',
    'src/renderer/src/core.worker.ts': "import '../../core/index'",
    'src/core/index.ts': '',
    'src/renderer/src/welcome/welcome.md': '',
    'src/renderer/src/folder/index.ts': '',
    'src/renderer/src/unused.ts': "import './multi'",
    'src/renderer/src/main.test.ts': "import './unused'",
  })
  const graph = uiGraph(root)
  expect([...graph.pages]).toEqual([['src/renderer/index.html', 'src/renderer/src/main.tsx']])
  for (const file of [
    'app.css',
    'multi.ts',
    'reexport.ts',
    'lazy.tsx',
    'core.worker.ts',
    '../../core/index.ts',
    'welcome/welcome.md',
    'folder/index.ts',
  ]) {
    const path = join('src/renderer/src', file)
    expect({ path, pages: [...(uiReach(graph, path)?.pages ?? [])] }).toEqual({
      path,
      pages: ['src/renderer/src/main.tsx'],
    })
  }
  // Only a unit test imports it, and unit tests are not part of the UI.
  expect(uiReach(graph, 'src/renderer/src/unused.ts')?.pages.size).toBe(0)
  expect(uiReach(graph, 'src/renderer/src/main.test.ts')).toBeUndefined()
})

it('stops at a lazily loaded boundary and names the specs that import a file themselves', () => {
  const root = repo({
    'src/renderer/index.html': page('main.tsx'),
    'src/renderer/src/main.tsx': "import './shared'\nconst Phone = () => import('./phone/App')",
    'src/renderer/src/shared.ts': '',
    'src/renderer/src/phone/App.tsx': "import './screen'\nimport '../shared'",
    'src/renderer/src/phone/screen.tsx': '',
    'tests/ui/limits.spec.ts': "import { max } from '../../src/renderer/src/phone/screen'",
  })
  const graph = uiGraph(root)
  const reach = uiReach(graph, 'src/renderer/src/phone/screen.tsx', [
    'src/renderer/src/phone/App.tsx',
  ])
  expect(reach).toEqual({
    pages: new Set(),
    boundaries: new Set(['src/renderer/src/phone/App.tsx']),
    specs: new Set(['tests/ui/limits.spec.ts']),
  })
  expect(
    uiReach(graph, 'src/renderer/src/shared.ts', ['src/renderer/src/phone/App.tsx'])?.pages,
  ).toEqual(new Set(['src/renderer/src/main.tsx']))
})

it('reaches every UI source in the repository from a page, a lazy boundary or a spec', () => {
  // A source the graph cannot reach would let a pull request that changes it skip its specs.
  const root = resolve(import.meta.dirname, '../..')
  const graph = uiGraph(root)
  expect(graph.pages.size).toBeGreaterThanOrEqual(6)
  const sources = listFiles('.', 'src').filter(
    (file) => /\.(?:tsx?|css|md)$/.test(file) && !/\.(?:bench\.)?test\.tsx?$|\.d\.ts$/.test(file),
  )
  expect(sources.length).toBeGreaterThan(300)
  const modules = boundaries.map(({ module }) => module)
  const unreached = sources.filter((file) => {
    const reach = uiReach(graph, file, modules)
    return !reach || reach.pages.size + reach.boundaries.size + reach.specs.size === 0
  })
  // Shared by unit tests only.
  expect(unreached).toEqual(['src/renderer/src/menuLines.ts'])
})

it('names as phone specs exactly the specs that load the phone layout', () => {
  const phone = boundaries.find(({ module }) => module.includes('/phone/'))!
  const specs = listFiles('.', 'tests').filter((file) =>
    /^tests\/ui(?:-csp)?\/.+\.spec\.ts$/.test(file),
  )
  const usesPhone = specs.filter((file) => /\biPhone\b/.test(readFileSync(file, 'utf8')))
  expect(usesPhone.length).toBeGreaterThan(3)
  expect(specs.filter((file) => phone.specs.test(file))).toEqual(usesPhone)
  // The page loads the phone layout only through the lazy import; a static one would skip desktop specs.
  const graph = uiGraph(resolve(import.meta.dirname, '../..'))
  expect([...(graph.importers.get(phone.module) ?? [])]).toEqual(['src/renderer/src/main.tsx'])
  expect(readFileSync('src/renderer/src/main.tsx', 'utf8')).toMatch(
    /lazy\(\(\) => import\('\.\/phone\/PhoneApp'\)/,
  )
})
