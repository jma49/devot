import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { expect, it } from 'vitest'
import { buildMermaidFrame, MERMAID_FRAME_SCRIPT } from '../../scripts/vite/mermaid-frame'

// The frame is sandboxed: anything it fetches with CORS (module scripts, import(), crossorigin
// stylesheets) is refused, so it must load as one classic script and nothing else.

const root = join(import.meta.dirname, '../..')

it('the Mermaid frame is one classic script with nothing left to fetch', async () => {
  const { code, modules } = await buildMermaidFrame()
  expect(() => new Script(code)).not.toThrow()
  expect(code).not.toMatch(/\bimport\s*\(/)
  expect(code).not.toContain('import.meta')
  expect([...modules].some((id) => id.endsWith('/mermaid-frame.ts'))).toBe(true)
  for (const name of ['mermaid', '@plantuml/core', 'markmap-lib', 'markmap-view']) {
    expect([...modules].some((id) => id.includes(`/node_modules/${name}/`))).toBe(true)
  }
}, 180_000)

it('the frame page loads only that script, as a classic script', () => {
  const html = readFileSync(join(root, 'src/renderer/mermaid.html'), 'utf8')
  const tags = [...html.matchAll(/<(script|link)\b[^>]*>/g)].map((match) => match[0])
  expect(tags).toEqual([`<script src="/${MERMAID_FRAME_SCRIPT}" vite-ignore>`])
})
