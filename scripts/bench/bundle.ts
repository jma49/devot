// Startup is what the main page and the core worker reach without a dynamic import() (plus
// the fonts its stylesheets name); everything else in the build loads on demand.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

export interface Weight {
  files: number
  bytes: number
  gzip: number
}

export interface BundleReport {
  startupMain: Weight & { js: number; css: number; other: number }
  startupWorker: Weight
  lazy: Weight & { largest: { file: string; bytes: number; gzip: number }[] }
  total: Weight
}

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  )
}

function references(dir: string, file: string): string[] {
  const text = readFileSync(join(dir, file), 'utf8')
  const found: string[] = []
  const add = (target: string | undefined) => {
    if (!target || /^(?:[a-z]+:|data:|#)/i.test(target)) return
    const path = target.startsWith('/')
      ? target.slice(1)
      : join(file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '', target)
    if (existsSync(join(dir, path))) found.push(path.replaceAll('\\', '/'))
  }
  if (file.endsWith('.html')) {
    for (const m of text.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)) add(m[1])
  } else if (file.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) add(m[1])
  } else if (file.endsWith('.js')) {
    // `import"./x.js"` and `from"./x.js"`, not `import("./x.js")`.
    for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*["'](\.[^"']+\.js)["']/g)) add(m[1])
  }
  return found
}

function reach(dir: string, roots: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file) || !existsSync(join(dir, file))) continue
    seen.add(file)
    queue.push(...references(dir, file))
  }
  return seen
}

function weigh(dir: string, files: Iterable<string>): Weight {
  let count = 0
  let bytes = 0
  let gzip = 0
  for (const file of files) {
    const data = readFileSync(join(dir, file))
    count += 1
    bytes += data.length
    gzip += gzipSync(data).length
  }
  return { files: count, bytes, gzip }
}

export function analyzeBundle(dir: string): BundleReport {
  const all = walk(dir).filter((file) => !file.endsWith('.map'))
  const main = reach(dir, ['index.html'])
  const mainFiles = [...main].filter((file) => file !== 'index.html')
  const workerEntry = all.find((file) => /^assets\/core\.worker-[^/]+\.js$/.test(file))
  const worker = workerEntry ? reach(dir, [workerEntry]) : new Set<string>()
  const workerFiles = [...worker].filter((file) => !main.has(file))
  const startup = new Set([...mainFiles, ...workerFiles])
  const lazyFiles = all.filter((file) => !startup.has(file) && !file.endsWith('.html'))
  const sizes = lazyFiles
    .map((file) => ({ file, ...weigh(dir, [file]) }))
    .sort((a, b) => b.bytes - a.bytes)
  const byKind = (ext: string) =>
    mainFiles
      .filter((f) => f.endsWith(ext))
      .reduce((sum, f) => sum + statSync(join(dir, f)).size, 0)
  const js = byKind('.js')
  const css = byKind('.css')
  const startupMain = weigh(dir, mainFiles)
  return {
    startupMain: { ...startupMain, js, css, other: startupMain.bytes - js - css },
    startupWorker: weigh(dir, workerFiles),
    lazy: {
      ...weigh(dir, lazyFiles),
      largest: sizes.slice(0, 8).map(({ file, bytes, gzip }) => ({ file, bytes, gzip })),
    },
    total: weigh(
      dir,
      all.filter((file) => !file.endsWith('.html')),
    ),
  }
}
