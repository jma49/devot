import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { sizes } from '../../src/renderer/src/theme/tokens'
import { cssRules } from '../support/css-rules'

it('keeps capsule controls opaque and sizes them from their own tokens', () => {
  const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))
  const thumb = rules.find((r) => r.selector === '.slider::-webkit-slider-thumb')
  expect(thumb?.body.get('background')).toBe('var(--color-switch-handle)')
  expect(thumb?.body.get('width')).toBe('var(--size-glass-slider-knob-width)')
  expect(sizes).toMatchObject({
    'radius.glass-card': '18px',
    'size.glass-switch-width': '44px',
    'size.glass-switch-knob-width': '26px',
    'size.glass-slider-knob-width': '32px',
  })
})
