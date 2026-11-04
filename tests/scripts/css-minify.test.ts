import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import app from '../../vite.config.ts'

const root = resolve(import.meta.dirname, '../..')
// Vite's own copy, the one that minifies the build's CSS.
const lightningcss = createRequire(createRequire(resolve(root, 'package.json')).resolve('vite'))(
  'lightningcss',
) as {
  Features: { HexAlphaColors: number }
  transform(options: { filename: string; code: Uint8Array; minify: boolean }): { code: Uint8Array }
}

function minified(css: string): string {
  return lightningcss
    .transform({
      ...app.css?.lightningcss,
      filename: 'tokens.css',
      code: Buffer.from(css),
      minify: true,
    })
    .code.toString()
}

it('keeps every token colour exactly as written, with no alpha rounded to a byte', () => {
  expect(app.css?.lightningcss?.include).toBe(lightningcss.Features.HexAlphaColors)
  // #rrggbbaa stores alpha in 1/255 steps: 0.7 would paint as 0.702 and 0.5 as 0.502.
  const css = minified(readFileSync(resolve(root, 'src/renderer/src/theme/tokens.css'), 'utf8'))
  expect(css.match(/#(?:[0-9a-f]{4}|[0-9a-f]{8})\b/gi) ?? []).toEqual([])
  expect(css).toContain('--color-surface-editor-wash:rgba(255,255,255,.7)')
  expect(minified('a{color:rgb(0 0 0 / 0.02)}')).toBe('a{color:rgba(0,0,0,.02)}')
})
