import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))

const ruleFor = (selector: string, property: string) =>
  rules.filter((r) => r.selector.includes(selector) && r.body.has(property))

it('washes a selected sidebar row in the accent, as the note list does', () => {
  const [sidebar] = ruleFor(".books [aria-selected='true'] > .book-row", 'background').filter(
    (r) => !r.selector.includes(':focus-within'),
  )
  expect(sidebar?.body.get('background')).toMatch(/var\(--color-accent-fill\)/)
  expect(sidebar?.body.get('background')).toMatch(/var\(--opacity-list-selected\)/)
})

it('bars the focused sidebar selection and draws no solid fill', () => {
  const [focused] = ruleFor('.sidebar:focus-within', 'box-shadow')
  expect(focused?.body.get('box-shadow')).toBe(
    'inset var(--size-list-focus-bar) 0 0 var(--color-accent-fill)',
  )
  expect(focused?.selector).toContain(".books [aria-selected='true'] > .book-row")
  expect(ruleFor('.sidebar:focus-within', 'background')).toEqual([])
})

it('washes a selected note row in the accent and bars the open row while the list has the keyboard', () => {
  const [row] = rules.filter((r) =>
    r.selector.split(',').some((s) => s.trim() === ".row[aria-selected='true']"),
  )
  expect(row?.body.get('background')).toMatch(/var\(--color-accent-fill\)/)
  expect(row?.body.get('background')).toMatch(/var\(--opacity-list-selected\)/)
  const [bar] = ruleFor('.rows:focus-within .row[data-open]', 'box-shadow')
  expect(bar?.body.get('box-shadow')).toBe(
    'inset var(--size-list-focus-bar) 0 0 var(--color-accent-fill)',
  )
})

it('draws the selection of a pane without the keyboard in the neutral inactive fill', () => {
  for (const pane of ['.sidebar:not(:focus-within)', '.rows:not(:focus-within)']) {
    const [neutral] = ruleFor(pane, 'background')
    expect(neutral?.body.get('background')).toBe('var(--color-fill-row-selected-inactive)')
  }
})

const GLASS = ":root[data-sidebar-material='on']"
const selectedRow = /(\.row\[aria-selected='true'\]|\[aria-selected='true'\] > \.book-row)\s*\)?$/
const selectedFills = rules.filter(
  (r) => r.body.has('background') && r.selector.split(',').some((s) => selectedRow.test(s.trim())),
)

it('draws no other fill for a selected row of either list', () => {
  expect(selectedFills.filter((r) => !r.selector.includes(GLASS))).toHaveLength(2)
})

it('in the Glass style, draws the sidebar selection neutral and the note list selection in the accent, focused or not', () => {
  const glass = selectedFills.filter((r) => r.selector.includes(GLASS))
  expect(glass).toHaveLength(2)
  const sidebar = glass.find((r) => r.selector.includes('.book-row'))
  expect(sidebar?.body.get('background')).toBe('var(--color-fill-row-selected)')
  const list = glass.find((r) => r.selector.includes('.row['))
  expect(list?.selector).toContain('.rows:not(:focus-within)')
  expect(list?.body.get('background')).toMatch(/var\(--color-accent-fill\)/)
})
