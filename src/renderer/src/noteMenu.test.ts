import { describe, expect, it } from 'vitest'
import { shownGroups } from './contextMenu'
import {
  actionChangesNotes,
  EXPORT_ACTIONS,
  NOTE_MENU,
  noteClipboardText,
  noteLinks,
  noteShortcut,
  type NoteAction,
  type NoteMenuAction,
  type NoteMenuTarget,
} from './noteMenu'

const ID = '0192a6f0-0000-7000-8000-00000000000a'

type Keys = Parameters<typeof noteShortcut>[0]
const key = (code: string, mods: Partial<Keys> = {}): Keys => ({
  code,
  key: code === 'Backspace' || code === 'Enter' ? code : code.replace('Key', '').toLowerCase(),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...mods,
})

describe('noteShortcut', () => {
  it('maps each shortcut to its action', () => {
    const cases: [Keys, NoteAction][] = [
      [key('KeyM'), 'move'],
      [key('KeyD', { metaKey: true }), 'duplicate'],
      [key('KeyP'), 'pin'],
      [key('KeyC', { metaKey: true }), 'copyLink'],
      [key('KeyC', { metaKey: true, shiftKey: true }), 'copyUri'],
      [key('Backspace', { metaKey: true }), 'trash'],
      [key('KeyY', { metaKey: true, altKey: true }), 'history'],
      [key('KeyP', { metaKey: true, shiftKey: true }), 'print'],
      [key('Enter', { shiftKey: true }), 'openWindow'],
    ]
    for (const [event, action] of cases) expect(noteShortcut(event)).toBe(action)
  })

  it('ignores other modifiers, other keys and auto-repeat', () => {
    for (const event of [
      key('KeyM', { shiftKey: true }),
      key('KeyM', { metaKey: true }),
      key('KeyP', { altKey: true }),
      key('KeyD'),
      key('KeyD', { ctrlKey: true }),
      key('KeyC'),
      key('KeyC', { metaKey: true, altKey: true }),
      key('Backspace'),
      key('KeyX', { metaKey: true }),
      key('KeyH', { shiftKey: true }),
      key('KeyH', { metaKey: true, shiftKey: true }),
      key('KeyY', { altKey: true }),
      key('KeyY', { metaKey: true }),
      key('KeyY', { metaKey: true, altKey: true, shiftKey: true }),
      key('KeyP', { repeat: true }),
      key('KeyP', { metaKey: true }),
    ]) {
      expect(noteShortcut(event)).toBeUndefined()
    }
  })

  it('agrees with the accelerators the menu shows', () => {
    // The board's status moves are the board's own keys (NoteBoard.tsx).
    const shown = NOTE_MENU.flat().flatMap((item) =>
      item.accelerator && !item.action.startsWith('status')
        ? [[item.action, item.accelerator] as const]
        : [],
    )
    for (const [action, accelerator] of shown) {
      const parts = accelerator.split('+')
      const last = parts.at(-1)
      const code = last === 'Backspace' || last === 'Enter' ? last : `Key${last}`
      const event = key(code, {
        metaKey: parts.includes('CmdOrCtrl'),
        shiftKey: parts.includes('Shift'),
        altKey: parts.includes('Alt'),
      })
      expect(noteShortcut(event)).toBe(action)
    }
  })
})

describe('NOTE_MENU', () => {
  const target = (ids: string[], more: Partial<NoteMenuTarget> = {}): NoteMenuTarget => ({
    ids,
    pinned: false,
    status: null,
    templates: false,
    tagged: true,
    ...more,
  })
  const shown = (t: NoteMenuTarget) =>
    shownGroups(NOTE_MENU, t).map((group) => group.map((item) => item.action))
  const labels = (t: NoteMenuTarget) =>
    shownGroups(NOTE_MENU, t)
      .flat()
      .map((item) => (typeof item.label === 'function' ? item.label(t) : item.label))

  it('groups the items for one note; of the export items only Print has a shortcut', () => {
    const one = target([ID])
    expect(shown(one)).toEqual([
      ['openWindow'],
      ['move', 'history'],
      ['duplicate', 'pin'],
      ['copyLink', 'copyUri', 'copyId'],
      ['exportHtml', 'copyHtml', 'copySimpleHtml', 'exportMarkdown', 'exportPdf', 'print'],
      ['trash'],
    ])
    expect(
      shownGroups(NOTE_MENU, one)
        .flat()
        .filter((item) => !item.accelerator)
        .map((item) => item.action),
    ).toEqual(['copyId', 'exportHtml', 'copyHtml', 'copySimpleHtml', 'exportMarkdown', 'exportPdf'])
    expect(NOTE_MENU.flat().find((item) => item.action === 'openWindow')?.accelerator).toBe(
      'Shift+Enter',
    )
    expect(NOTE_MENU.flat().find((item) => item.action === 'print')?.accelerator).toBe(
      'Shift+CmdOrCtrl+P',
    )
  })

  it('moves the notes to the next or previous status on a board, with its keys', () => {
    expect(shown(target([ID], { board: true }))[3]).toEqual(['statusNext', 'statusPrevious'])
    expect(shown(target([ID, 'b'], { board: true }))[2]).toEqual([
      'status',
      'statusNext',
      'statusPrevious',
      'addTag',
      'removeTag',
    ])
    const accelerators = Object.fromEntries(
      NOTE_MENU.flat().map((item) => [item.action, item.accelerator]),
    )
    expect(accelerators['statusNext']).toBe('Ctrl+CmdOrCtrl+ArrowRight')
    expect(accelerators['statusPrevious']).toBe('Ctrl+CmdOrCtrl+ArrowLeft')
    expect(actionChangesNotes('statusNext')).toBe(true)
  })

  it('acts on several notes with plural labels, a Status submenu and the tag items', () => {
    const many = target([ID, 'b', 'c'], { status: 'active' })
    expect(shown(many)).toEqual([
      ['move'],
      ['pin'],
      ['status', 'addTag', 'removeTag'],
      ['copyLink'],
      ['exportHtml', 'exportMarkdown'],
      ['trash'],
    ])
    expect(labels(many)).toEqual([
      'batch.move',
      'batch.pin',
      'note.statusLabel',
      'batch.addTag',
      'batch.removeTag',
      'batch.copyLinks',
      'noteMenu.exportSelectionHtml',
      'noteMenu.exportSelectionMarkdown',
      'batch.trash',
    ])
    expect(labels({ ...many, pinned: true })).toContain('batch.unpin')
    const status = NOTE_MENU.flat().find((item) => item.action === 'status')
    expect(status?.submenu?.map((item) => [item.action, item.checked?.(many)])).toEqual([
      ['status:none', false],
      ['status:active', true],
      ['status:on_hold', false],
      ['status:completed', false],
      ['status:dropped', false],
    ])
  })

  it('keeps only Export as Markdown and HTML for several notes or templates', () => {
    for (const many of [target([ID, 'b']), target([ID, 'b'], { templates: true })]) {
      const actions = shown(many).flat()
      expect(EXPORT_ACTIONS.filter((action) => actions.includes(action))).toEqual([
        'exportHtml',
        'exportMarkdown',
      ])
    }
    expect(labels(target([ID])).filter((l) => l.startsWith('noteMenu.export'))).toEqual([
      'noteMenu.exportHtml',
      'noteMenu.exportMarkdown',
      'noteMenu.exportPdf',
    ])
    expect(shown(target([ID], { templates: true })).flat()).toEqual(
      expect.arrayContaining([...EXPORT_ACTIONS]),
    )
  })

  it('offers Remove Tag only when one of the notes has a tag', () => {
    expect(shown(target([ID, 'b'], { tagged: false }))[2]).toEqual(['status', 'addTag'])
  })

  it('opens one note in a window of its own, never a template', () => {
    expect(shown(target([ID])).flat()).toContain('openWindow')
    expect(shown(target([ID], { templates: true })).flat()).not.toContain('openWindow')
    expect(shown(target([ID, 'b'])).flat()).not.toContain('openWindow')
  })

  it('offers no status or tags for several templates', () => {
    expect(shown(target([ID, 'b'], { templates: true }))).toEqual([
      ['move'],
      ['pin'],
      ['copyLink'],
      ['exportHtml', 'exportMarkdown'],
      ['trash'],
    ])
  })
})

describe('noteLinks', () => {
  it('puts one link per line, in the order given', () => {
    expect(
      noteLinks([
        { id: ID, title: 'One' },
        { id: 'b', title: '' },
      ]),
    ).toBe(`[One](devot://note/${ID})\n[Untitled](devot://note/b)`)
  })
})

describe('noteClipboardText', () => {
  it('writes the link, the URI or the ID', () => {
    const note = { id: ID, title: 'Plan [v2]' }
    expect(noteClipboardText('copyLink', note)).toBe(`[Plan \\[v2\\]](devot://note/${ID})`)
    expect(noteClipboardText('copyUri', note)).toBe(`devot://note/${ID}`)
    expect(noteClipboardText('copyId', note)).toBe(ID)
  })

  it('names an untitled note as the list does', () => {
    expect(noteClipboardText('copyLink', { id: ID, title: '' })).toBe(
      `[Untitled](devot://note/${ID})`,
    )
  })
})

describe('the note actions that change notes', () => {
  it('are moving, pinning, tagging, the status, duplicating and trashing; reading and exporting are not', () => {
    const changing: NoteMenuAction[] = [
      'move',
      'pin',
      'addTag',
      'removeTag',
      'duplicate',
      'trash',
      'status',
      'status:active',
    ]
    expect(changing.filter((action) => !actionChangesNotes(action))).toEqual([])
    const reading: NoteMenuAction[] = [
      'openWindow',
      'history',
      'copyLink',
      'copyId',
      ...EXPORT_ACTIONS,
    ]
    expect(reading.filter(actionChangesNotes)).toEqual([])
  })
})
