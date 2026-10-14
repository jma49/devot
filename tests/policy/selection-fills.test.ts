import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

// The sidebar shows a selection as an accent wash, and a solid accent fill
// with the on-fill colour while it has the keyboard focus. The note list
// washes its selection in the accent, focused or not, and marks the open
// note's row with an accent bar while it has the keyboard.
const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))

const ruleFor = (selector: string, property: string) =>
  rules.filter((r) => r.selector.includes(selector) && r.body.has(property))

it('washes a selected sidebar row in the accent', () => {
  const [sidebar] = ruleFor(".books [aria-selected='true'] > .book-row", 'background').filter(
    (r) => !r.selector.includes(':focus-within'),
  )
  expect(sidebar?.body.get('background')).toBe('var(--color-fill-row-selected-unemphasized)')
})

it('fills the focused sidebar selection with the accent', () => {
  const [focused] = ruleFor('.sidebar:focus-within', 'background')
  expect(focused?.body.get('background')).toBe('var(--color-accent-fill)')
  expect(focused?.body.get('color')).toBe('var(--color-accent-on-fill)')
  expect(focused?.selector).toContain(".books [aria-selected='true'] > .book-row")
})

it('washes a selected note row in the accent, focused or not, and bars the open row', () => {
  const [row] = rules.filter((r) => r.selector === ".row[aria-selected='true']")
  expect(row?.body.get('background')).toMatch(/var\(--color-accent-fill\)/)
  expect(row?.body.get('background')).toMatch(/var\(--opacity-list-selected\)/)
  expect(
    rules.filter((r) => r.selector.includes(".rows:focus-within .row[aria-selected='true']")),
  ).toEqual([])
  const [bar] = ruleFor('.rows:focus-within .row[data-open]', 'box-shadow')
  expect(bar?.body.get('box-shadow')).toBe(
    'inset var(--size-list-focus-bar) 0 0 var(--color-accent-fill)',
  )
})

it('draws no other fill for a selected row of either list', () => {
  const selectedRow = /(\.row\[aria-selected='true'\]|\[aria-selected='true'\] > \.book-row)\)?$/
  const fills = rules.filter(
    (r) =>
      r.body.has('background') && r.selector.split(',').some((s) => selectedRow.test(s.trim())),
  )
  expect(fills).toHaveLength(2)
})
