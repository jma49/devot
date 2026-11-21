import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))

describe('Chinese type (design/layout.md, Chinese type)', () => {
  it('gives Han titles no negative tracking and nothing under caption size', () => {
    const root = rules.find((r) => r.selector === ':root:lang(zh)')!
    expect(root.body.get('--note-heading-glass-title-tracking')).toBe('0')
    expect(root.body.get('--font-size-caption2')).toBe('var(--font-size-caption)')
  })

  it('gives prose over several lines more leading', () => {
    const prose = rules.find((r) => r.selector.startsWith(':lang(zh) :is('))!
    expect(prose.body.get('line-height')).toBe('1.5')
    for (const selector of ['.setting-description', '.confirm-detail', '.notice-text']) {
      expect(prose.selector).toContain(selector)
    }
  })
})
