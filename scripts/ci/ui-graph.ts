import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import {
  DIAGRAM_ENGINES,
  engineEntry,
  MERMAID_FRAME_ENTRY,
  MERMAID_FRAME_SCRIPT,
} from '../vite/mermaid-frame-entry.ts'

// The UI's module graph, read with patterns rather than a parser so the change detection needs no
// installed packages. Reading too many edges only runs more specs; a missed edge would skip specs,
// so tests/scripts/ui-graph.test.ts fails when any UI source is unreachable from a page.

const SOURCES = ['src/**/*.{ts,tsx,css,md,svg}', 'design/app-icon/*.svg']
const SPECS = ['tests/ui/**/*.ts', 'tests/ui-csp/**/*.ts']
// Scripts a Vite plugin builds from a module of its own, which a page loads by their built name.
const BUILT_SCRIPTS = new Map([[MERMAID_FRAME_SCRIPT, MERMAID_FRAME_ENTRY]])
// Built scripts a module loads by name at run time, as if it imported their modules.
const LOADED_SCRIPTS = new Map([[MERMAID_FRAME_ENTRY, DIAGRAM_ENGINES.map(engineEntry)]])
const IGNORED = /\.(?:bench\.)?test\.[cm]?[jt]sx?$|\.d\.ts$/

const SPECIFIERS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bnew URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
]

export interface UiGraph {
  /** Pages the app serves (src/renderer/*.html) and the module each starts. */
  pages: Map<string, string>
  /** For each file, the files that import it. */
  importers: Map<string, Set<string>>
  files: Set<string>
}

function resolveSpecifier(root: string, from: string, specifier: string): string | undefined {
  const path = specifier.split('?')[0] ?? ''
  if (!path.startsWith('.')) return undefined
  const base = normalize(join(dirname(from), path))
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]
  if (base.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'))
  return candidates.find(
    (file) => existsSync(join(root, file)) && statSync(join(root, file)).isFile(),
  )
}

export function uiGraph(root: string): UiGraph {
  const pages = new Map<string, string>()
  for (const page of globSync('src/renderer/*.html', { cwd: root })) {
    for (const [, src] of readFileSync(join(root, page), 'utf8').matchAll(
      /<script[^>]*\bsrc="\/([^"]+)"/g,
    )) {
      pages.set(page, BUILT_SCRIPTS.get(src ?? '') ?? normalize(join('src/renderer', src ?? '')))
    }
  }
  const files = new Set(
    [...globSync(SOURCES, { cwd: root }), ...globSync(SPECS, { cwd: root })].filter(
      (file) => !IGNORED.test(file),
    ),
  )
  const importers = new Map<string, Set<string>>()
  const link = (target: string, importer: string) => {
    files.add(target)
    const set = importers.get(target) ?? new Set<string>()
    set.add(importer)
    importers.set(target, set)
  }
  for (const [loader, modules] of LOADED_SCRIPTS) {
    if (!files.has(loader)) continue
    for (const module of modules) if (existsSync(join(root, module))) link(module, loader)
  }
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    const text = readFileSync(join(root, file), 'utf8')
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of text.matchAll(pattern)) {
        const target = resolveSpecifier(root, file, specifier ?? '')
        if (target) link(target, file)
      }
    }
  }
  return { pages, importers, files }
}

/**
 * Where a change to `file` can show in the browser: the page modules it reaches through the files
 * that import it, the `boundaries` it reaches only through (a lazily loaded part, such as the phone
 * layout), and the spec files that import it themselves. Undefined when the graph has no such file.
 */
export function uiReach(graph: UiGraph, file: string, boundaries: string[] = []) {
  if (!graph.files.has(file)) return undefined
  const entries = new Set(graph.pages.values())
  const reached = {
    pages: new Set<string>(),
    boundaries: new Set<string>(),
    specs: new Set<string>(),
  }
  const seen = new Set<string>()
  const queue = [file]
  while (queue.length) {
    const current = queue.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    if (entries.has(current)) reached.pages.add(current)
    if (/^tests\/ui(?:-csp)?\/.+\.spec\.ts$/.test(current)) reached.specs.add(current)
    if (boundaries.includes(current)) {
      reached.boundaries.add(current)
      continue
    }
    for (const importer of graph.importers.get(current) ?? []) queue.push(importer)
  }
  return reached
}
