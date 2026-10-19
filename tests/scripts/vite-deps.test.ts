import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// Vite's dependency scan reads the page entries and follows their imports,
// but not `new Worker(new URL(...))`: a package only the core worker imports
// is found when the worker first loads, and Vite then re-bundles and reloads
// every open page. A cold start (CI, a fresh checkout) hit that in the UI
// tests' first specs. `optimizeDeps.entries` names the worker too, so the
// scan finds every package the UI imports before the first page loads.

const root = join(import.meta.dirname, '../..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

function importedPackages(dependencies: string[]): string[] {
  const code = [...sources(join(root, 'src/renderer')), ...sources(join(root, 'src/core'))]
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
  return dependencies.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    return new RegExp(
      `(?:^|\\n)\\s*(?:import|export)\\s(?!type\\s)[^;]*?from\\s'${escaped}(?:/[^']*)?'|import\\('${escaped}(?:/[^']*)?'\\)`,
    ).test(code)
  })
}

it('the dependency scan finds the packages only the core worker imports', async () => {
  const { dependencies } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  // The MCP server and the database adapter run in Node, never in the UI.
  const nodeOnly = ['@modelcontextprotocol/sdk', 'better-sqlite3']
  const expected = importedPackages(Object.keys(dependencies).filter((n) => !nodeOnly.includes(n)))
  expect(expected).toEqual(
    expect.arrayContaining(['rehype-raw', 'rehype-sanitize', 'remark-rehype']),
  )

  const server = await createServer({
    configFile: join(root, 'vite.ui-test.config.ts'),
    cacheDir: tempDir('devot-vite-cache-'),
    server: { port: 0, strictPort: false, hmr: false, ws: false },
    logLevel: 'silent',
  })
  try {
    await server.listen()
    const optimizer = server.environments['client']!.depsOptimizer!
    await optimizer.scanProcessing
    const found = Object.keys(optimizer.metadata.discovered)
    const missing = expected.filter(
      (name) => !found.some((id) => id === name || id.startsWith(`${name}/`)),
    )
    expect(missing).toEqual([])
  } finally {
    await server.close()
  }
}, 60_000)
