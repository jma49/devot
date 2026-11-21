import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))
const wrapOf = (selector: string) =>
  rules.find((r) => r.selector === selector && r.body.has('text-wrap'))?.body.get('text-wrap')

describe('interface text wrapping (design/layout.md, Interface text)', () => {
  it.each([
    '.confirm-message',
    '.sheet-title',
    '.list-empty-message',
    '.list-empty-tip',
    '.empty-pane-hint',
  ])('balances the lines of the short or centred text %s', (selector) => {
    expect(wrapOf(selector)).toBe('balance')
  })

  it.each([
    '.confirm-detail',
    '.sheet-detail',
    '.sheet-error',
    '.notice-text',
    '.setting-description',
    '.settings-footnote > span',
    '.settings-note',
    '.settings-section .settings-card > p',
  ])('keeps a lone word or character off the last line of %s', (selector) => {
    expect(wrapOf(selector)).toBe('pretty')
  })
})
