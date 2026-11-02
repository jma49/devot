import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('Reduce Transparency turns phone glass opaque and stops its blur', () => {
  const css = readFileSync('src/renderer/src/phone/phone.css', 'utf8')
  const reduced = css.split('prefers-reduced-transparency: reduce')[1] ?? ''
  expect(reduced).toContain('background: var(--color-phone-glass-opaque)')
  expect(reduced).toContain('backdrop-filter: none')
})

it('lets the iPhone lay out edge to edge, and keeps pinch zoom', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8')
  expect(html).toContain('viewport-fit=cover')
  expect(html).not.toMatch(/user-scalable|maximum-scale/)
})
