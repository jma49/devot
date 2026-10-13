import { describe, expect, it } from 'vitest'
import { shownGroups } from './contextMenu'
import {
  EXPORT_ACTIONS,
  NOTE_MENU,
  noteClipboardText,
  noteLinks,
  noteShortcut,
  type NoteAction,
  type NoteMenuTarget,
} from './noteMenu'

const ID = '0192a6f0-0000-7000-8000-00000000000a'

type Keys = Parameters<typeof noteShortcut>[0]
const key = (code: string, mods: Partial<Keys> = {}): Keys => ({
  code,
  key: code === 'Backspace' ? 'Backspace' : code.replace('Key', '').toLowerCase(),
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
      // Cmd+P is the command palette.
      key('KeyP', { metaKey: true }),
    ]) {
      expect(noteShortcut(event)).toBeUndefined()
    }
  })

  it('agrees with the accelerators the menu shows', () => {
    const shown = NOTE_MENU.flat().flatMap((item) =>
      item.accelerator ? [[item.action, item.accelerator] as const] : [],
    )
    for (const [action, accelerator] of shown) {
      const parts = accelerator.split('+')
      const code = parts.at(-1) === 'Backspace' ? 'Backspace' : `Key${parts.at(-1)}`
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
    expect(NOTE_MENU.flat().find((item) => item.action === 'print')?.accelerator).toBe(
      'Shift+CmdOrCtrl+P',
    )
  })

  it('acts on several notes with plural labels, a Status submenu and the tag items', () => {
    const many = target([ID, 'b', 'c'], { status: 'active' })
    expect(shown(many)).toEqual([
      ['move'],
      ['pin'],
      ['status', 'addTag', 'removeTag'],
      ['copyLink'],
      ['trash'],
    ])
    expect(labels(many)).toEqual([
      'batch.move',
      'batch.pin',
      'note.statusLabel',
      'batch.addTag',
      'batch.removeTag',
      'batch.copyLinks',
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

  it('hides the export and print items for several notes or templates', () => {
    for (const many of [target([ID, 'b']), target([ID, 'b'], { templates: true })]) {
      const actions = shown(many).flat()
      for (const action of EXPORT_ACTIONS) expect(actions).not.toContain(action)
    }
    // One template exports like a note.
    expect(shown(target([ID], { templates: true })).flat()).toEqual(
      expect.arrayContaining([...EXPORT_ACTIONS]),
    )
  })

  it('offers Remove Tag only when one of the notes has a tag', () => {
    expect(shown(target([ID, 'b'], { tagged: false }))[2]).toEqual(['status', 'addTag'])
  })

  it('offers no status or tags for several templates', () => {
    expect(shown(target([ID, 'b'], { templates: true }))).toEqual([
      ['move'],
      ['pin'],
      ['copyLink'],
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
