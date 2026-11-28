import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { NOTE_STATUSES, TAG_COLORS } from '../../src/core/storage'
import { listFiles } from '../support/git-files'

const TSCONFIGS = [
  'tsconfig.node.json',
  'tsconfig.web.json',
  'tsconfig.ui.json',
  'relay/tsconfig.json',
  'licence/tsconfig.json',
  'share/tsconfig.json',
  'clipper/tsconfig.json',
] as const

interface TsConfig {
  include?: string[]
  exclude?: string[]
}

function matchesPattern(file: string, baseDir: string, pattern: string): boolean {
  const clean = pattern.replace(/^\.\//, '')
  const full = baseDir ? `${baseDir}/${clean}` : clean
  if (full.endsWith('/*.ts')) {
    const dir = full.slice(0, -'/*.ts'.length)
    return dirname(file) === dir && file.endsWith('.ts')
  }
  return file === full || file.startsWith(`${full}/`)
}

it('covers every tracked TypeScript file under pnpm typecheck', () => {
  const configs = TSCONFIGS.map((configPath) => {
    const baseDir = dirname(configPath) === '.' ? '' : dirname(configPath)
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as TsConfig
    return {
      baseDir,
      include: parsed.include ?? [],
      exclude: parsed.exclude ?? [],
    }
  })
  const tsFiles = listFiles('.').filter((file) => /\.(ts|tsx)$/.test(file))
  const uncovered = tsFiles.filter(
    (file) =>
      !configs.some(
        ({ baseDir, include, exclude }) =>
          include.some((pattern) => matchesPattern(file, baseDir, pattern)) &&
          !exclude.some((pattern) => matchesPattern(file, baseDir, pattern)),
      ),
  )
  expect(uncovered).toEqual([])
})

function resolveRelativeTs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const stripped = spec.replace(/\.(ts|tsx)$/, '')
  const base = resolve(dirname(fromFile), stripped)
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) {
      const rel = relative('.', candidate)
      if (/\.(ts|tsx)$/.test(rel)) return rel
    }
  }
  return null
}

function runtimeStronglyConnectedCycles(files: readonly string[]): string[][] {
  const fileSet = new Set(files)
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const stripped = readFileSync(file, 'utf8')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const deps = new Set<string>()
    for (const match of stripped.matchAll(
      /(?:import|export)\s+(type\s+)?([\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g,
    )) {
      if (match[1]) continue
      const clause = (match[2] ?? '').replace(/\s+from\s+$/, '').trim()
      if (clause.startsWith('{') && clause.endsWith('}')) {
        const names = clause
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        if (names.length > 0 && names.every((name) => name.startsWith('type '))) continue
      }
      const resolved = resolveRelativeTs(file, match[3]!)
      if (resolved && fileSet.has(resolved) && resolved !== file) deps.add(resolved)
    }
    graph.set(file, [...deps])
  }

  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []

  const visit = (node: string) => {
    indices.set(node, index)
    low.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!))
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = []
      for (;;) {
        const top = stack.pop()!
        onStack.delete(top)
        component.push(top)
        if (top === node) break
      }
      if (component.length > 1) cycles.push(component.sort())
    }
  }

  for (const file of files) if (!indices.has(file)) visit(file)
  return cycles
}

it('keeps TypeScript modules free of runtime circular dependencies across core, UI, clipper, SDK and Workers', () => {
  const files = listFiles(
    '.',
    'src/core',
    'src/renderer/src',
    'relay/src',
    'licence/src',
    'share/src',
    'clipper',
    'plugin-kit/src',
  ).filter(
    (file) =>
      /\.(ts|tsx)$/.test(file) && !/\.(test|spec)\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts'),
  )
  expect(runtimeStronglyConnectedCycles(files)).toEqual([])
})

it('keeps the Share on Web Worker isolated and openEnvelope zero-import', () => {
  const specifiers = (file: string) =>
    [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1] ?? '',
    )
  const appOffenders = listFiles('.', 'src')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => specifiers(f).some((s) => /(^|\/)share\/src\//.test(s)))
  expect(appOffenders).toEqual([])

  const shareFiles = listFiles('.', 'share/src').filter((f) => f.endsWith('.ts'))
  const shareOffenders = shareFiles.flatMap((file) =>
    specifiers(file)
      .filter((s) => !/^\.\/[a-z-]+\.ts$/.test(s) && s !== '../../licence/src/brand.ts')
      .map((s) => `${file}: ${s}`),
  )
  expect(shareOffenders).toEqual([])
  expect(specifiers('share/src/envelope.ts')).toEqual([])
})

it('keeps NOTE_STATUSES and TAG_COLORS identical across core, Rust storage and plugin-kit', () => {
  const rustRecords = readFileSync('src-tauri/src/storage/records.rs', 'utf8')
  const rustStatuses = [
    ...(
      /pub const NOTE_STATUSES: \[&str; \d+\] = \[([^\]]+)\];/.exec(rustRecords)?.[1] ?? ''
    ).matchAll(/"([^"]+)"/g),
  ].map((m) => m[1])
  expect(rustStatuses).toEqual([...NOTE_STATUSES])

  const rustColors = [
    ...(
      /pub const TAG_COLORS: \[&str; \d+\] = \[([^\]]+)\];/.exec(rustRecords)?.[1] ?? ''
    ).matchAll(/"([^"]+)"/g),
  ].map((m) => m[1])
  expect(rustColors).toEqual([...TAG_COLORS])

  const pluginTypes = readFileSync('plugin-kit/types/index.d.ts', 'utf8')
  const pluginStatuses = [
    ...(/export type DevotNoteStatus = ([^\n]+)/.exec(pluginTypes)?.[1] ?? '').matchAll(
      /'([^']+)'/g,
    ),
  ].map((m) => m[1])
  expect(pluginStatuses).toEqual([...NOTE_STATUSES])
})
