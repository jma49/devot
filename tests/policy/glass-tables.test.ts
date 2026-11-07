import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/preview/content.css', 'utf8'))
it('rounds only tables in the app and uses separators instead of cell grids', () => {
  const glass = rules.filter((r) =>
    r.selector.startsWith(".preview:is([data-devot-part='preview'], .gallery-page)"),
  )
  const table = glass.find((r) => r.selector.endsWith(' table'))
  expect(table?.body.get('border-radius')).toBe('var(--radius-list-row)')
  expect(table?.body.get('border-collapse')).toBe('separate')
  expect(glass.filter((r) => /th|td/.test(r.selector)).every((r) => !r.body.has('border'))).toBe(
    true,
  )
})

it('scrolls every table on screen sideways in its own box, its cells keeping their words whole', () => {
  const table = rules.filter((r) => r.selector === '.preview table')
  expect(table.some((r) => r.body.get('overflow-x') === 'auto')).toBe(true)
  const cells = rules.find(
    (r) => r.selector === '.preview :is(th, td)' && r.body.has('overflow-wrap'),
  )
  expect(cells?.body.get('overflow-wrap')).toBe('break-word')
})

it('keeps cell words whole on paper too: the cell rule sits outside the screen-only block', () => {
  const css = readFileSync('src/renderer/src/preview/content.css', 'utf8')
  const screenBlock = css.slice(css.indexOf('@media screen'))
  const end = screenBlock.indexOf('\n}\n')
  expect(screenBlock.slice(0, end)).not.toContain('overflow-wrap')
  expect(css).toMatch(/\.preview :is\(th, td\) \{\s*overflow-wrap: break-word;/)
})
