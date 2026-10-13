import { describe, expect, it } from 'vitest'
import { BOOK_MENU, bookShortcut, type BookAction, type BookMenuTarget } from './bookMenu'
import { shownGroups } from './contextMenu'

type Keys = Parameters<typeof bookShortcut>[0]
const key = (name: string, mods: Partial<Keys> = {}): Keys => ({
  key: name,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...mods,
})

const top = { id: 'a', parentId: null, aiAccess: false, previousId: null, nextId: null }
const nested = { id: 'b', parentId: 'a', aiAccess: true, previousId: null, nextId: null }
const actions = (book: BookMenuTarget) =>
  shownGroups(BOOK_MENU, book).map((group) => group.map((entry) => entry.action))

describe('BOOK_MENU', () => {
  it('groups the actions; Move to Top Level only for a nested notebook', () => {
    expect(actions(top)).toEqual([
      ['newInside'],
      ['rename'],
      ['aiAccess'],
      ['exportMarkdown', 'exportHtml'],
      ['delete'],
    ])
    expect(actions(nested)).toEqual([
      ['newInside'],
      ['rename', 'moveToTop'],
      ['aiAccess'],
      ['exportMarkdown', 'exportHtml'],
      ['delete'],
    ])
  })

  it('offers Move Up and Move Down only when there is a sibling that way', () => {
    expect(actions({ ...top, nextId: 'c' })).toEqual([
      ['newInside'],
      ['rename', 'moveDown'],
      ['aiAccess'],
      ['exportMarkdown', 'exportHtml'],
      ['delete'],
    ])
    expect(actions({ ...nested, previousId: 'c', nextId: 'd' })[1]).toEqual([
      'rename',
      'moveUp',
      'moveDown',
      'moveToTop',
    ])
  })

  it('checks Allow AI Access for the notebook that has it on', () => {
    const entry = BOOK_MENU.flat().find((e) => e.action === 'aiAccess')
    expect(entry?.checked?.(top)).toBe(false)
    expect(entry?.checked?.(nested)).toBe(true)
  })

  it('labels every item from the catalog', () => {
    expect(BOOK_MENU.flat().map((entry) => entry.label)).toEqual([
      'bookMenu.newInside',
      'bookMenu.rename',
      'bookMenu.moveUp',
      'bookMenu.moveDown',
      'bookMenu.moveToTop',
      'bookMenu.aiAccess',
      'bookMenu.exportMarkdown',
      'bookMenu.exportHtml',
      'bookMenu.delete',
    ])
  })
})

describe('bookShortcut', () => {
  it('renames with Return or F2, moves with Option and the arrows, and deletes with Delete or Backspace', () => {
    const cases: [Keys, BookAction][] = [
      [key('Enter'), 'rename'],
      [key('F2'), 'rename'],
      [key('ArrowUp', { altKey: true }), 'moveUp'],
      [key('ArrowDown', { altKey: true }), 'moveDown'],
      [key('Backspace'), 'delete'],
      [key('Delete'), 'delete'],
    ]
    for (const [event, action] of cases) expect(bookShortcut(event)).toBe(action)
  })

  it('ignores modifiers, other keys and auto-repeat', () => {
    for (const event of [
      key('Enter', { metaKey: true }),
      key('Enter', { shiftKey: true }),
      key('Backspace', { metaKey: true }),
      key('Backspace', { altKey: true }),
      key('ArrowUp'),
      key('ArrowUp', { altKey: true, shiftKey: true }),
      key('F2', { metaKey: true }),
      key('Delete', { ctrlKey: true }),
      key('Backspace', { repeat: true }),
      key('n'),
      key('Escape'),
    ]) {
      expect(bookShortcut(event)).toBeUndefined()
    }
  })

  it('agrees with the accelerators the menu shows', () => {
    const shown = BOOK_MENU.flat().flatMap((entry) =>
      entry.accelerator ? [[entry.action, entry.accelerator] as const] : [],
    )
    expect(shown).toEqual([
      ['rename', 'Enter'],
      ['moveUp', 'Alt+ArrowUp'],
      ['moveDown', 'Alt+ArrowDown'],
      ['delete', 'Backspace'],
    ])
    for (const [action, accelerator] of shown) {
      const name = accelerator.split('+').pop() ?? accelerator
      expect(bookShortcut(key(name, { altKey: accelerator.startsWith('Alt+') }))).toBe(action)
    }
  })
})
