import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { beforeAll, expect, it } from 'vitest'
import {
  buildMermaidFrame,
  DIAGRAM_ENGINES,
  engineScript,
  MERMAID_FRAME_SCRIPT,
} from '../../scripts/vite/mermaid-frame'

// The frame is sandboxed: anything it fetches with CORS (module scripts, import(), crossorigin
// stylesheets) is refused, so everything it runs loads as classic scripts.

const root = join(import.meta.dirname, '../..')

const ENGINE_PACKAGES = {
  mermaid: ['mermaid'],
  plantuml: ['@plantuml/core'],
  markmap: ['markmap-lib', 'markmap-view'],
}

// Mermaid's engine was 5.1 MB of a 9.3 MB script when every engine shared one.
const FRAME_BUDGET = 16 * 1024
const MERMAID_BUDGET = 5.6 * 1024 * 1024

let built: Awaited<ReturnType<typeof buildMermaidFrame>>

const hasPackage = (modules: Set<string>, name: string) =>
  [...modules].some((id) => id.includes(`/node_modules/${name}/`))

beforeAll(async () => {
  built = await buildMermaidFrame()
}, 180_000)

it('builds the frame and each diagram engine as a classic script with nothing left to fetch', () => {
  expect([...built.keys()]).toEqual([MERMAID_FRAME_SCRIPT, ...DIAGRAM_ENGINES.map(engineScript)])
  for (const { code } of built.values()) {
    expect(() => new Script(code)).not.toThrow()
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toContain('import.meta')
  }
})

it('loads no diagram engine until a diagram asks for one', () => {
  const frame = built.get(MERMAID_FRAME_SCRIPT)!
  expect([...frame.modules].some((id) => id.endsWith('/mermaid-frame.ts'))).toBe(true)
  expect([...frame.modules].filter((id) => id.includes('/node_modules/'))).toEqual([])
  expect(frame.code.length).toBeLessThan(FRAME_BUDGET)
  for (const kind of DIAGRAM_ENGINES) expect(frame.code).toContain(engineScript(kind))
})

it('puts each engine in a script of its own', () => {
  for (const kind of DIAGRAM_ENGINES) {
    const { modules } = built.get(engineScript(kind))!
    for (const [other, packages] of Object.entries(ENGINE_PACKAGES)) {
      for (const name of packages) expect(hasPackage(modules, name)).toBe(other === kind)
    }
  }
})

it('loads the frame and Mermaid alone for the first Mermaid diagram', () => {
  const first = built.get(MERMAID_FRAME_SCRIPT)!.code.length
  const mermaid = built.get(engineScript('mermaid'))!.code.length
  expect(first + mermaid).toBeLessThan(MERMAID_BUDGET)
})

it('the frame page loads only the frame script, as a classic script', () => {
  const html = readFileSync(join(root, 'src/renderer/mermaid.html'), 'utf8')
  const tags = [...html.matchAll(/<(script|link)\b[^>]*>/g)].map((match) => match[0])
  expect(tags).toEqual([`<script src="/${MERMAID_FRAME_SCRIPT}" vite-ignore>`])
})
