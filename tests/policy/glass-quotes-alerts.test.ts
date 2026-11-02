import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/preview/content.css', 'utf8'))
const glass = rules.filter((r) => r.selector.includes(":root[data-sidebar-material='on'] .preview"))
const about = (pattern: RegExp) => glass.filter((r) => pattern.test(r.selector))
const declared = (value: string | undefined) =>
  value?.replace(/\(\s+/g, '(').replace(/,?\s+\)/g, ')')
const base = (exact: string) => rules.find((r) => r.selector === exact)

it('draws no Glass quote or alert with a left border', () => {
  const blocks = about(/\.alert|blockquote/)
  expect(blocks.length).toBeGreaterThan(0)
  for (const rule of blocks) {
    const sides = [...rule.body.keys()].filter((name) =>
      /^border-(left|inline-start|inline)(-|$)/.test(name),
    )
    expect({ [rule.selector]: sides }).toEqual({ [rule.selector]: [] })
  }
})

it('takes the alert strengths from the opacity tokens', () => {
  const card = about(/ \.alert$/)[0]
  expect(declared(card?.body.get('background-color'))).toBe(
    'color-mix(in srgb, var(--alert-color) calc(var(--opacity-alert-fill) * 100%), transparent)',
  )
  expect(declared(card?.body.get('box-shadow'))).toBe(
    'inset 0 0 0 1px color-mix(in srgb, var(--alert-color) calc(var(--opacity-alert-edge) * 100%), transparent)',
  )
  expect(card?.body.get('border-radius')).toBe('var(--radius-list-row)')
})

it('draws the quote bar as its own shape, from tokens', () => {
  const bar = about(/blockquote::before$/)[0]
  expect(bar?.body.get('width')).toBe('var(--size-quote-bar)')
  expect(bar?.body.get('border-radius')).toBe('var(--radius-quote-bar)')
  expect(bar?.body.get('background-color')).toBe('var(--color-quote-bar)')
})

it('leaves the rules exported and printed pages use as they were', () => {
  expect(base('.alert')?.body.get('border-left')).toBe('3px solid var(--alert-color)')
  expect(base('.preview blockquote')?.body.get('border-left')).toBe(
    '3px solid var(--color-quote-bar)',
  )
  expect(rules.some((r) => r.selector.startsWith('.preview blockquote::before'))).toBe(false)
})
