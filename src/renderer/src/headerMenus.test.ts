import { describe, expect, it } from 'vitest'
import { shownGroups } from './contextMenu'
import { CHIP_MENU, NOTEBOOK_MENU } from './headerMenus'
import { t } from './i18n'

describe('the tag chip menu', () => {
  it('has Tag Settings and Remove Tag, Filter by Tag, Copy Tag ID, in groups', () => {
    const groups = shownGroups(CHIP_MENU, { tagId: 'a', filtered: false }).map((g) =>
      g.map((e) => (typeof e.label === 'function' ? '' : t(e.label))),
    )
    expect(groups).toEqual([['Tag Settings…', 'Remove Tag'], ['Filter by Tag'], ['Copy Tag ID']])
  })

  it('checks Filter by Tag while the list is filtered by the tag', () => {
    const filter = CHIP_MENU.flat().find((e) => e.action === 'filter')
    expect(filter?.checked?.({ tagId: 'a', filtered: true })).toBe(true)
    expect(filter?.checked?.({ tagId: 'a', filtered: false })).toBe(false)
  })
})

describe('the notebook label menu', () => {
  it('has Open Notebook and Copy Notebook ID', () => {
    const groups = shownGroups(NOTEBOOK_MENU, { bookId: 'b' }).map((g) =>
      g.map((e) => (typeof e.label === 'function' ? '' : t(e.label))),
    )
    expect(groups).toEqual([['Open Notebook'], ['Copy Notebook ID']])
  })
})
