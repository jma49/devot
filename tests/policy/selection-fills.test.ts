import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))

const ruleFor = (selector: string, property: string) =>
  rules.filter((r) => r.selector.includes(selector) && r.body.has(property))

const selectedRow = /(\.row\[aria-selected='true'\]|\[aria-selected='true'\] > \.book-row)\s*\)?$/
const selectedFills = rules.filter(
  (r) => r.body.has('background') && r.selector.split(',').some((s) => selectedRow.test(s.trim())),
)

it('draws the sidebar selection neutral and the note list selection in the accent, focused or not', () => {
  expect(selectedFills).toHaveLength(2)
  const sidebar = selectedFills.find((r) => r.selector.includes('.book-row'))
  expect(sidebar?.selector).toMatch(/^\.sidebar /)
  expect(sidebar?.body.get('background')).toBe('var(--color-fill-row-selected)')
  const list = selectedFills.find((r) => r.selector.includes('.row['))
  expect(list?.selector).toBe(".row[aria-selected='true']")
  expect(list?.body.get('background')).toMatch(/var\(--color-accent-fill\)/)
  expect(list?.body.get('background')).toMatch(/var\(--opacity-list-selected\)/)
})

it('draws no keyboard bar or other fill for a selection that has or loses the keyboard', () => {
  for (const pane of [
    '.sidebar:focus-within',
    '.sidebar:not(:focus-within)',
    '.rows:focus-within',
    '.rows:not(:focus-within)',
  ]) {
    expect(ruleFor(pane, 'background')).toEqual([])
    expect(ruleFor(pane, 'box-shadow')).toEqual([])
  }
})

const hoverFills = rules.filter((r) => r.selector.includes(':hover') && r.body.has('background'))

it('washes a hovered sidebar or note row in the inactive selection fill, leaving selected and drop rows alone', () => {
  const [hover] = hoverFills.filter((r) => r.selector.includes('.row:not'))
  expect(hover?.body.get('background')).toBe('var(--color-fill-row-selected-inactive)')
  expect(hover?.body.get('transition-duration')).toBe('var(--motion-duration-hover)')
  for (const row of ['.source:not(', '.book-row:not(', '.row:not(']) {
    expect(hover?.selector).toContain(row)
  }
  expect(hover?.selector).toContain("[aria-selected='true']")
  expect(hover?.selector).toContain("[aria-pressed='true']")
  expect(hover?.selector).toContain('.drop-fill')
})

it('draws the tree guide per row, broken clear of a chevron, and not per group', () => {
  const guides = rules.filter((r) => r.selector.includes("ul[role='group'] > li"))
  const plain = guides.find((r) => !r.selector.includes('aria-expanded'))
  const broken = guides.find((r) => r.selector.includes('aria-expanded'))
  expect(plain?.body.get('inset-block')).toBe('0')
  expect(broken?.body.get('--guide-gap')).toBe('calc(var(--size-icon-sm) / 2 + var(--space-1))')
  expect(broken?.body.get('background')).toContain('transparent')
  const groups = rules.filter((r) => /ul\[role='group'\]::before/.test(r.selector))
  expect(groups.map((r) => r.selector)).toEqual([
    ".books ul[role='group'] ul[role='group']::before",
  ])
})
