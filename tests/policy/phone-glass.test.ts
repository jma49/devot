import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('Reduce Transparency turns phone glass opaque and stops its blur', () => {
  const css = readFileSync('src/renderer/src/phone/phone.css', 'utf8')
  const reduced = css.split('prefers-reduced-transparency: reduce')[1] ?? ''
  expect(reduced).toContain('background: var(--color-phone-glass-opaque)')
  expect(reduced).toContain('backdrop-filter: none')
  expect(reduced).toMatch(/\.phone-topbar-band \{\s*background: var\(--color-phone-background\)/)
})

it('Reduce Transparency drops the rim and the sheen', () => {
  const css = readFileSync('src/renderer/src/phone/phone.css', 'utf8')
  const reduced = css.split('prefers-reduced-transparency: reduce')[1] ?? ''
  expect(reduced).toMatch(/\.phone-glass::before,\s*\.phone-glass::after \{\s*display: none/)
})

it('draws the recipe of the glass spec', () => {
  const css = readFileSync('src/renderer/src/phone/phone.css', 'utf8')
  expect(css).toContain('backdrop-filter: blur(10px) saturate(1.9) brightness(1.04)')
  expect(css).toContain('var(--color-phone-glass-rim-a)')
  expect(css).toContain('var(--color-phone-glass-sheen)')
  expect(css).toContain('filter: brightness(1.05)')
  expect(css).toContain('transform var(--motion-duration-phone-glass-press)')
})

it('lets the iPhone lay out edge to edge', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8')
  expect(html).toContain('viewport-fit=cover')
})
