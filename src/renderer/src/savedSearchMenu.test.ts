import { describe, expect, it } from 'vitest'
import { shownGroups } from './contextMenu'
import {
  SAVED_SEARCH_COMMANDS,
  SAVED_SEARCH_MENU,
  SEARCH_FIELD_MENU,
  savedSearchShortcut,
} from './savedSearchMenu'

const key = (name: string) => ({
  key: name,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
})

describe('SAVED_SEARCH_MENU', () => {
  it('lists Rename and Edit, then Delete in its own group', () => {
    expect(
      shownGroups(SAVED_SEARCH_MENU, { id: 's' }).map((group) => group.map((e) => e.action)),
    ).toEqual([['rename', 'edit'], ['delete']])
  })

  it('keeps every action on a registry command, with the row keys', () => {
    expect(SAVED_SEARCH_COMMANDS).toEqual({
      rename: 'savedSearch.rename',
      edit: 'savedSearch.edit',
      delete: 'savedSearch.delete',
    })
    expect(savedSearchShortcut(key('F2'))).toBe('rename')
    expect(savedSearchShortcut(key('Backspace'))).toBe('delete')
    expect(savedSearchShortcut(key('Delete'))).toBe('delete')
    expect(savedSearchShortcut(key('a'))).toBeUndefined()
  })
})

describe('SEARCH_FIELD_MENU', () => {
  it('offers Save Search', () => {
    expect(
      shownGroups(SEARCH_FIELD_MENU, { query: 'tag:x' }).flatMap((g) => g.map((e) => e.action)),
    ).toEqual(['save'])
  })
})
