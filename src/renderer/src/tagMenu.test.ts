import { describe, expect, it } from 'vitest'
import { shownGroups } from './contextMenu'
import { TAG_COMMANDS, TAG_MENU, tagShortcut, type TagMenuTarget } from './tagMenu'

const actions = (target: TagMenuTarget) =>
  shownGroups(TAG_MENU, target).map((group) => group.map((entry) => entry.action))
const entry = (target: TagMenuTarget, action: string) =>
  shownGroups(TAG_MENU, target)
    .flat()
    .find((each) => each.action === action)

describe('TAG_MENU', () => {
  it('lists Tag Settings, Filter by Tag, Pin Tag, Copy Tag ID and Delete Tag, each in its group', () => {
    expect(actions({ id: 't', color: null, filtered: false })).toEqual([
      ['settings'],
      ['filter', 'pin'],
      ['copyId'],
      ['delete'],
    ])
  })

  it('labels Pin Tag or Unpin Tag from pinned state', () => {
    const unpinned = entry({ id: 't', color: null, filtered: false, pinned: false }, 'pin')
    const pinned = entry({ id: 't', color: null, filtered: false, pinned: true }, 'pin')
    const labelOf = (item: typeof unpinned, target: TagMenuTarget) =>
      typeof item?.label === 'function' ? item.label(target) : item?.label
    expect(labelOf(unpinned, { id: 't', color: null, filtered: false, pinned: false })).toBe(
      'tagMenu.pin',
    )
    expect(labelOf(pinned, { id: 't', color: null, filtered: false, pinned: true })).toBe(
      'tagMenu.unpin',
    )
  })

  it('checks whether the list is filtered by the tag', () => {
    const on = { id: 't', color: null, filtered: true }
    const off = { ...on, filtered: false }
    expect(entry(on, 'filter')?.checked?.(on)).toBe(true)
    expect(entry(off, 'filter')?.checked?.(off)).toBe(false)
  })

  it('leaves Delete Tag out in a workspace', () => {
    expect(actions({ id: 't', color: null, filtered: false, inWorkspace: true }).flat()).toEqual([
      'settings',
      'filter',
      'pin',
      'copyId',
    ])
  })

  it('keeps every action on a registry command, with the row keys', () => {
    expect(TAG_COMMANDS).toMatchObject({ delete: 'tag.delete', rename: 'tag.rename' })
    expect(
      tagShortcut({
        key: 'Backspace',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe('delete')
    expect(
      tagShortcut({ key: 'F2', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
    ).toBe('rename')
  })
})
