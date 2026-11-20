import { writeFileSync, readFileSync } from 'node:fs'
import { webkit } from '@playwright/test'
import { build, type Rolldown } from 'vite'
import { buildMermaidFrame, engineScript } from '../vite/mermaid-frame.ts'
import { sizes } from '../../src/renderer/src/theme/tokens.ts'
import type { DiagramKind, RenderRequest } from '../../src/renderer/src/preview/mermaid-protocol.ts'

const fixtures = new URL('../../tests/fixtures/', import.meta.url)
const corpus = JSON.parse(readFileSync(new URL('diagram-corpus.json', fixtures), 'utf8')) as {
  name: string
  kind: DiagramKind
  source: string
}[]
const bundles = await buildMermaidFrame()
const theme = await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    write: false,
    lib: {
      entry: 'src/renderer/src/preview/mermaid-theme.ts',
      formats: ['iife'],
      name: 'devotCorpusTheme',
    },
  },
})
const browser = await webkit.launch()
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body></body></html>')
  const chunk = (Array.isArray(theme) ? theme : [theme])
    .flatMap((output) => (output as Rolldown.RolldownOutput).output)
    .find((item) => item.type === 'chunk')!
  await page.addScriptTag({ content: chunk.code })
  const palette = await page.evaluate(
    () =>
      (globalThis as unknown as { devotCorpusTheme: { exportPalette: RenderRequest['palette'] } })
        .devotCorpusTheme.exportPalette,
  )
  for (const kind of new Set(corpus.map((item) => item.kind))) {
    await page.addScriptTag({ content: bundles.get(engineScript(kind))!.code })
  }
  const drawings = []
  for (const item of corpus) {
    const request: RenderRequest = {
      type: 'render',
      ...item,
      id: drawings.length + 1,
      appearance: 'light',
      fontFamily: sizes['font.family.ui'],
      fontSize: sizes['font.size.footnote'],
      palette,
      width: 800,
    }
    const svg = await page.evaluate(async (input) => {
      const engines = (
        globalThis as unknown as Record<
          symbol,
          Record<string, (r: unknown) => Promise<{ type: string; svg: string }>>
        >
      )[Symbol.for('devot.diagram-engines')]!
      const drawing = await engines[input.kind!]!(input)
      if (drawing.type !== 'rendered') throw new Error(`E_DIAGRAM_CORPUS: ${input.id}`)
      return drawing.svg
    }, request)
    drawings.push({ ...item, svg })
    console.log(`Rendered ${item.name}`)
  }
  const attributes = await page.evaluate((outputs) => {
    const found: Record<string, Set<string>> = {}
    for (const { svg } of outputs) {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      for (const node of doc.querySelectorAll('*')) {
        const names = (found[node.localName] ??= new Set())
        for (const attr of node.attributes) names.add(attr.name)
      }
    }
    return Object.fromEntries(
      Object.entries(found)
        .sort()
        .map(([tag, attrs]) => [tag, [...attrs].sort()]),
    )
  }, drawings)
  writeFileSync(new URL('diagram-svg.json', fixtures), JSON.stringify(drawings, null, 2) + '\n')
  writeFileSync(
    new URL('diagram-svg-attributes.json', fixtures),
    JSON.stringify(attributes, null, 2) + '\n',
  )
  console.log(JSON.stringify(attributes, null, 2))
} finally {
  await browser.close()
}
