import { build } from 'vite'
import { expect, it } from 'vitest'

const MAX_CHUNK_BYTES = 200 * 1024

it('the notebook glyph chunk holds its catalog, not all of Lucide', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      lib: { entry: 'src/renderer/src/icons/lucideNotebook.ts', formats: ['es'] },
      rollupOptions: { external: ['react', 'react/jsx-runtime'] },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]) as {
    output: { type: string; code?: string }[]
  }[]
  const bytes = outputs
    .flatMap((o) => o.output)
    .reduce((sum, file) => sum + (file.code?.length ?? 0), 0)
  expect(bytes).toBeGreaterThan(0)
  expect(bytes).toBeLessThan(MAX_CHUNK_BYTES)
}, 60_000)
