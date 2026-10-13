import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

// The sidebar and the note list show a selection the same way: an accent
// wash, and a solid accent fill with the on-fill colour while the list has
// the keyboard focus. One rule draws each state for both lists.
const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))

const ruleFor = (selector: string, property: string) =>
  rules.filter((r) => r.selector.includes(selector) && r.body.has(property))

it('washes a selected row in the accent in both lists, from one rule', () => {
  const [sidebar] = ruleFor(".books [aria-selected='true'] > .book-row", 'background').filter(
    (r) => !r.selector.includes(':focus-within'),
  )
  expect(sidebar?.body.get('background')).toBe('var(--color-fill-row-selected-unemphasized)')
  expect(sidebar?.selector).toContain(".row[aria-selected='true']")
})

it('fills the focused list selection with the accent in both lists, from one rule', () => {
  const [focused] = ruleFor(".rows:focus-within .row[aria-selected='true']", 'background')
  expect(focused?.body.get('background')).toBe('var(--color-accent-fill)')
  expect(focused?.body.get('color')).toBe('var(--color-accent-on-fill)')
  expect(focused?.selector).toMatch(/^\.sidebar:focus-within/)
  expect(focused?.selector).toContain(".books [aria-selected='true'] > .book-row")
})

it('draws no other fill for a selected row of either list', () => {
  const selectedRow = /(\.row\[aria-selected='true'\]|\[aria-selected='true'\] > \.book-row)\)?$/
  const fills = rules.filter(
    (r) =>
      r.body.has('background') && r.selector.split(',').some((s) => selectedRow.test(s.trim())),
  )
  expect(fills).toHaveLength(2)
})
