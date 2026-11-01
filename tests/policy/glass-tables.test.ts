import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/preview/content.css', 'utf8'))
it('rounds only Glass tables and uses separators instead of cell grids', () => {
  const glass = rules.filter((r) =>
    r.selector.includes(":root[data-sidebar-material='on'] .preview"),
  )
  const table = glass.find((r) => r.selector.endsWith(' table'))
  expect(table?.body.get('border-radius')).toBe('var(--radius-list-row)')
  expect(table?.body.get('border-collapse')).toBe('separate')
  expect(table?.body.get('overflow-x')).toBe('auto')
  expect(glass.filter((r) => /th|td/.test(r.selector)).every((r) => !r.body.has('border'))).toBe(
    true,
  )
})
