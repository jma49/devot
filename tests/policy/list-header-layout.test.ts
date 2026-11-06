import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))
const rule = (selector: string) => rules.find((r) => r.selector === selector)

describe('the note list header layout', () => {
  it('starts the name at the toggle and lets it truncate', () => {
    const title = rule('.list .list-header .toolbar-title')!
    expect(title.body.get('justify-content')).toBe('flex-start')
    expect(title.body.get('min-width')).toBe('0')
    expect(title.body.get('padding-inline')).toBe('var(--space-5) var(--space-3)')
    expect(rule('.list-header .headline')!.body.get('text-overflow')).toBe('ellipsis')
    const glass = rule(":root[data-sidebar-material='on'] .list .list-header .toolbar-title")!
    expect(glass.body.get('align-items')).toBe('flex-start')
  })

  it('makes New Note a round tool of the list action size', () => {
    const create = rule('.list-filter .list-create')!
    expect(create.body.get('width')).toBe('var(--size-list-action)')
    expect(create.body.get('height')).toBe('var(--size-list-action)')
    expect(create.body.get('border-radius')).toBe('var(--radius-capsule)')
    expect(rule('.list-filter-search')!.body.get('gap')).toBe('var(--space-3)')
  })
})
