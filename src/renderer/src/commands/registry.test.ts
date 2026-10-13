import { afterEach, describe, expect, it } from 'vitest'
import { FORMAT_COMMANDS } from '../editor/formats'
import { INSERT_COMMANDS } from '../editor/insert'
import { TABLE_COMMANDS } from '../editor/tableCommands'
import { en, type MessageKey } from '../i18n/en'
import { keyMatches, normalizeShortcut, shortcutLabel, type KeyPress } from './keys'
import { effectiveKeymap } from './keymap'
import { headingTitle, titleWithKey } from './titles'
import {
  COMMANDS,
  RESERVED_KEYS,
  command,
  commandKeys,
  commandMatches,
  editorCommandKeys,
  editorFormatKeys,
  editorTableKeys,
  formatOf,
  heldCommandKey,
  insertOf,
  scopesOverlap,
  shortcutClashes,
  tableOf,
  setCommandKeys,
  windowCommand,
  type CommandId,
  type CommandScope,
} from './registry'

const press = (code: string, key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('COMMANDS', () => {
  it('declares every command once, with a catalog label and valid keys', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of COMMANDS) {
      expect(Object.hasOwn(en, c.label)).toBe(true)
      // Written in canonical form, so the same key is always the same text.
      for (const key of c.keys) expect(normalizeShortcut(key)).toBe(key)
    }
  })

  it('names a real format in every format command', () => {
    const formats = COMMANDS.flatMap((c) => {
      const format = formatOf(c.id)
      return format === undefined ? [] : [format]
    })
    expect(formats.length).toBeGreaterThan(10)
    for (const format of formats) expect(Object.keys(FORMAT_COMMANDS)).toContain(format)
  })

  it('declares every table command once, in the editor', () => {
    const tables = COMMANDS.filter((c) => c.group === 'table')
    expect(tables.map((c) => tableOf(c.id)).sort()).toEqual(Object.keys(TABLE_COMMANDS).sort())
    for (const c of tables) expect([c.id, c.scope]).toEqual([c.id, 'editor'])
    expect(COMMANDS.filter((c) => c.group !== 'table').map((c) => tableOf(c.id))).toEqual(
      COMMANDS.filter((c) => c.group !== 'table').map(() => undefined),
    )
  })

  it('binds the table keys, which act only in a table', () => {
    expect(editorTableKeys()).toEqual([
      { command: 'nextCell', key: 'Tab' },
      { command: 'previousCell', key: 'Shift-Tab' },
      { command: 'nextRow', key: 'Enter' },
      { command: 'insertRowBelow', key: 'Alt-Enter' },
      { command: 'moveRowUp', key: 'Shift-Mod-Alt-ArrowUp' },
      { command: 'moveRowDown', key: 'Shift-Mod-Alt-ArrowDown' },
      { command: 'alignLeft', key: 'Mod-Alt-ArrowLeft' },
      { command: 'alignCenter', key: 'Mod-Alt-ArrowUp' },
      { command: 'alignRight', key: 'Mod-Alt-ArrowRight' },
      { command: 'alignNone', key: 'Mod-Alt-ArrowDown' },
    ])
    // Moving between cells is what the keys are for; the palette leaves it out.
    for (const id of ['table.nextCell', 'table.previousCell', 'table.nextRow'] as const)
      expect(command(id)).toMatchObject({ palette: false })
    expect(command('table.insertRowBelow')).not.toHaveProperty('palette')
  })

  it('has no two commands on one key where both apply', () => {
    expect(shortcutClashes(COMMANDS)).toEqual([])
  })

  it('finds a clash between scopes that overlap', () => {
    const clash = shortcutClashes([
      { id: 'a', scope: 'window', keys: ['Mod+K'] },
      { id: 'b', scope: 'editor', keys: ['Mod+K'] },
      { id: 'c', scope: 'notebookRow', keys: ['Enter'] },
      { id: 'd', scope: 'noteList', keys: ['Enter'] },
      { id: 'e', scope: 'outsideEditor', keys: ['Mod+E'] },
      { id: 'f', scope: 'editor', keys: ['Mod+E'] },
    ])
    expect(clash).toEqual([{ key: 'Mod+K', ids: ['a', 'b'] }])
  })

  it('knows where scopes overlap', () => {
    const all: CommandScope[] = [
      'window',
      'outsideEditor',
      'editor',
      'panes',
      'sidebar',
      'list',
      'noteList',
      'trashList',
      'notebookRow',
      'tagRow',
    ]
    for (const s of all) expect(scopesOverlap('window', s)).toBe(true)
    for (const s of all) expect(scopesOverlap(s, s)).toBe(true)
    for (const s of all.filter((x) => x !== 'window' && x !== 'editor')) {
      expect(scopesOverlap('outsideEditor', s)).toBe(true)
      expect(scopesOverlap('editor', s)).toBe(false)
    }
    // Any note list is the library's or the Trash's, never both.
    expect(scopesOverlap('list', 'noteList')).toBe(true)
    expect(scopesOverlap('trashList', 'list')).toBe(true)
    expect(scopesOverlap('noteList', 'trashList')).toBe(false)
    // A sidebar row is a notebook or a tag.
    expect(scopesOverlap('notebookRow', 'tagRow')).toBe(false)
    expect(scopesOverlap('noteList', 'notebookRow')).toBe(false)
    expect(scopesOverlap('tagRow', 'list')).toBe(false)
    // The panes are the sidebar's rows and the note list, never the editor.
    expect(scopesOverlap('panes', 'sidebar')).toBe(true)
    expect(scopesOverlap('panes', 'trashList')).toBe(true)
    expect(scopesOverlap('sidebar', 'notebookRow')).toBe(true)
    expect(scopesOverlap('sidebar', 'tagRow')).toBe(true)
    expect(scopesOverlap('sidebar', 'list')).toBe(false)
    expect(scopesOverlap('panes', 'editor')).toBe(false)
  })

  it('declares the keys that move between notes and areas', () => {
    const spec = (id: Parameters<typeof command>[0]) => {
      const c = command(id)
      return [c.scope, ...c.keys]
    }
    // Back and Forward outside the editor (there Cmd+[ and Cmd+] outdent and
    // indent), the next and previous note from anywhere.
    expect(spec('note.back')).toEqual(['outsideEditor', 'Mod+[', 'Mod+ArrowLeft'])
    expect(spec('note.forward')).toEqual(['outsideEditor', 'Mod+]', 'Mod+ArrowRight'])
    expect(spec('note.next')).toEqual(['window', 'Mod+Shift+]'])
    expect(spec('note.previous')).toEqual(['window', 'Mod+Shift+['])
    expect(spec('view.sidebar')).toEqual(['window', 'Mod+/'])
    // Tab and Shift+Tab on a sidebar row or in the list; Control+Tab anywhere,
    // the editor too, where Tab is text and table navigation.
    expect(spec('view.nextAreaInPane')).toEqual(['panes', 'Tab'])
    expect(spec('view.previousAreaInPane')).toEqual(['panes', 'Shift+Tab'])
    expect(spec('view.nextArea')).toEqual(['window', 'Ctrl+Tab'])
    expect(spec('view.previousArea')).toEqual(['window', 'Ctrl+Shift+Tab'])
    expect(command('table.nextCell').keys).toEqual(['Tab'])
    // Return and Cmd+Return in the note list (the Trash's has no title to edit).
    expect(spec('note.editTitle')).toEqual(['noteList', 'Enter'])
    expect(spec('note.editBody')).toEqual(['noteList', 'Mod+Enter'])
  })

  it('runs Back and Forward outside the editor, and the other note keys from the editor too', () => {
    const outside: [KeyPress, string][] = [
      [press('BracketLeft', '[', { metaKey: true }), 'note.back'],
      [press('BracketRight', ']', { metaKey: true }), 'note.forward'],
      [press('ArrowLeft', 'ArrowLeft', { metaKey: true }), 'note.back'],
      [press('ArrowRight', 'ArrowRight', { metaKey: true }), 'note.forward'],
    ]
    for (const [e, id] of outside) {
      expect(windowCommand(e, { inEditor: false })).toBe(id)
      expect(windowCommand(e, { inEditor: true })).toBeUndefined()
    }
    const cases: [KeyPress, string][] = [
      [press('BracketRight', '}', { metaKey: true, shiftKey: true }), 'note.next'],
      [press('BracketLeft', '{', { metaKey: true, shiftKey: true }), 'note.previous'],
      [press('Slash', '/', { metaKey: true }), 'view.sidebar'],
      [press('Tab', 'Tab', { ctrlKey: true }), 'view.nextArea'],
      [press('Tab', 'Tab', { ctrlKey: true, shiftKey: true }), 'view.previousArea'],
    ]
    for (const inEditor of [false, true]) {
      for (const [e, id] of cases) expect(windowCommand(e, { inEditor })).toBe(id)
    }
    // Plain Tab is no window key: it belongs to the panes and the editor.
    expect(windowCommand(press('Tab', 'Tab'), { inEditor: false })).toBeUndefined()
    expect(windowCommand(press('Enter', 'Enter'), { inEditor: false })).toBeUndefined()
  })

  it('declares the keys of the Trash, the tag rows and the list', () => {
    expect(command('trash.deleteForever')).toMatchObject({
      scope: 'trashList',
      keys: ['Mod+Backspace'],
    })
    expect(command('trash.restore').scope).toBe('trashList')
    expect(command('trash.empty').scope).toBe('window')
    expect(command('tag.delete')).toMatchObject({ scope: 'tagRow', keys: ['Backspace', 'Delete'] })
    expect(command('tag.rename')).toMatchObject({ scope: 'tagRow', keys: ['F2'] })
    for (const id of ['tag.filter', 'tag.copyId'] as const) {
      expect(command(id)).toMatchObject({ scope: 'tagRow', keys: [] })
    }
    expect(command('search.fromList')).toMatchObject({ scope: 'list', keys: ['/'] })
  })

  it('gives the notebook and tag rows keys for renaming and moving, and a key for their menu', () => {
    expect(command('notebook.rename').keys).toEqual(['Enter', 'F2'])
    expect(command('notebook.moveUp')).toMatchObject({
      scope: 'notebookRow',
      keys: ['Alt+ArrowUp'],
    })
    expect(command('notebook.moveDown')).toMatchObject({
      scope: 'notebookRow',
      keys: ['Alt+ArrowDown'],
    })
    // Every row action is in the row's menu, which has keys of its own.
    expect(command('sidebar.rowMenu')).toMatchObject({
      scope: 'sidebar',
      keys: ['Shift+F10', 'ContextMenu', 'Ctrl+Enter'],
    })
    for (const e of [
      press('F10', 'F10', { shiftKey: true }),
      press('ContextMenu', 'ContextMenu'),
      press('Enter', 'Enter', { ctrlKey: true }),
    ]) {
      expect(commandMatches('sidebar.rowMenu', e)).toBe(true)
    }
    expect(commandMatches('sidebar.rowMenu', press('F10', 'F10'))).toBe(false)
  })

  it('declares View Image in the editor, without a key', () => {
    expect(command('image.view')).toMatchObject({ scope: 'editor', group: 'image', keys: [] })
  })

  it('sees a new key that would shadow a list, Trash or tag row key', () => {
    const probe = (scope: CommandScope, key: string) =>
      shortcutClashes([...COMMANDS, { id: 'probe', scope, keys: [key] }])
        .filter((c) => c.ids.includes('probe'))
        .map((c) => c.ids.find((id) => id !== 'probe'))
    expect(probe('window', 'Mod+Backspace')).toEqual(['note.trash', 'trash.deleteForever'])
    expect(probe('outsideEditor', '/')).toEqual(['search.fromList'])
    expect(probe('outsideEditor', 'Backspace')).toEqual(['notebook.delete', 'tag.delete'])
    expect(probe('list', 'Mod+Backspace')).toEqual(['note.trash', 'trash.deleteForever'])
    expect(probe('tagRow', 'Enter')).toEqual([])
    // Find and the status keys work everywhere, so nothing may take theirs.
    expect(probe('noteList', 'Mod+G')).toEqual(['find.next'])
    expect(probe('editor', 'Mod+Ctrl+3')).toEqual(['status.onHold'])
    expect(probe('editor', 'Shift+F3')).toEqual(['find.previousInEditor'])
  })

  it('lets Shift+Cmd+C copy a note URI in the list and make a code block in the editor', () => {
    // Each area sees only its own keys, so the two never meet; anything
    // window-wide on that key would.
    expect(command('note.copyUri')).toMatchObject({ scope: 'noteList', keys: ['Mod+Shift+C'] })
    expect(command('format.codeBlock')).toMatchObject({ scope: 'editor', keys: ['Mod+Shift+C'] })
    expect(scopesOverlap('noteList', 'editor')).toBe(false)
    const probe = shortcutClashes([
      ...COMMANDS,
      { id: 'probe', scope: 'window', keys: ['Mod+Shift+C'] },
    ]).filter((c) => c.ids.includes('probe'))
    expect(probe.map((c) => c.ids[0])).toEqual(['note.copyUri', 'format.codeBlock'])
  })

  it('declares find, the status keys and the alerts', () => {
    const keys = (id: Parameters<typeof command>[0]) => command(id).keys
    // Find: window-wide, plus F3 in the editor.
    expect(keys('find.find')).toEqual(['Mod+F'])
    expect(keys('find.replace')).toEqual(['Mod+Alt+F'])
    expect(keys('find.next')).toEqual(['Mod+G'])
    expect(keys('find.previous')).toEqual(['Mod+Shift+G'])
    expect(keys('find.regexp')).toEqual(['Mod+Alt+R'])
    expect(keys('find.caseSensitive')).toEqual(['Mod+Alt+C'])
    for (const c of COMMANDS.filter((x) => x.group === 'find')) {
      expect([c.id, c.scope]).toEqual([c.id, c.id.endsWith('InEditor') ? 'editor' : 'window'])
    }
    expect(keys('find.nextInEditor')).toEqual(['F3'])
    expect(keys('find.previousInEditor')).toEqual(['Shift+F3'])
    // Status: Control+Command+1 to 5, window-wide.
    expect(
      ['none', 'active', 'onHold', 'completed', 'dropped'].map((s) => {
        const c = command(`status.${s}` as Parameters<typeof command>[0])
        return [c.scope, ...c.keys]
      }),
    ).toEqual([1, 2, 3, 4, 5].map((n) => ['window', `Mod+Ctrl+${n}`]))
    // Alerts: editor formats without keys.
    const alerts = COMMANDS.filter((c) => c.id.startsWith('format.alert'))
    expect(alerts.map((c) => [formatOf(c.id), c.scope, c.keys.length])).toEqual(
      ['alertNote', 'alertTip', 'alertImportant', 'alertWarning', 'alertCaution'].map((f) => [
        f,
        'editor',
        0,
      ]),
    )
  })

  it('declares New Note from Template on Cmd+T, window-wide, with no other command on it', () => {
    const c = command('note.newFromTemplate')
    expect([c.scope, c.group, ...c.keys]).toEqual(['window', 'note', 'Mod+T'])
    expect(COMMANDS.filter((x) => (x.keys as readonly string[]).includes('Mod+T'))).toEqual([c])
    expect(command('view.templates').scope).toBe('window')
  })

  it('takes no key macOS keeps for itself', () => {
    const used = COMMANDS.flatMap((c) => c.keys)
    expect(used.filter((k) => RESERVED_KEYS.includes(k))).toEqual([])
  })

  it('keeps the shortcuts the app had', () => {
    const keys = (id: Parameters<typeof command>[0]) => command(id).keys
    expect(keys('search.view')).toEqual(['Mod+Shift+F'])
    expect(keys('search.all')).toEqual(['Mod+Alt+Shift+F'])
    expect(keys('view.focus')).toEqual(['Mod+Shift+D'])
    expect(keys('view.togglePreview')).toEqual(['Mod+E'])
    expect(keys('view.split')).toEqual(['Mod+P'])
    expect(keys('note.history')).toEqual(['Mod+Alt+Y'])
    expect(keys('note.duplicate')).toEqual(['Mod+D'])
    expect(keys('notebook.delete')).toEqual(['Backspace', 'Delete'])
    expect(editorFormatKeys()).toEqual([
      { format: 'heading1', key: 'Mod-1' },
      { format: 'heading2', key: 'Mod-2' },
      { format: 'heading3', key: 'Mod-3' },
      { format: 'heading4', key: 'Mod-4' },
      { format: 'heading5', key: 'Mod-Alt-5' },
      { format: 'heading6', key: 'Mod-Alt-6' },
      { format: 'bold', key: 'Mod-b' },
      { format: 'italic', key: 'Mod-i' },
      { format: 'strikethrough', key: 'Mod-u' },
      { format: 'link', key: 'Mod-Alt-k' },
      { format: 'code', key: 'Mod-Alt-e' },
      { format: 'codeBlock', key: 'Shift-Mod-c' },
      { format: 'bulletList', key: 'Shift-Mod-l' },
      { format: 'numberedList', key: 'Shift-Mod-o' },
      { format: 'taskList', key: 'Shift-Mod-t' },
      { format: 'quote', key: "Mod-'" },
      { format: 'horizontalRule', key: 'Shift-Mod-h' },
    ])
  })

  it('declares the editor commands for rules, new notes from a selection and plain pastes', () => {
    // Highlight has no key; the rule takes Shift+Cmd+H.
    expect(command('format.highlight').keys).toEqual([])
    expect(command('format.horizontalRule')).toMatchObject({
      scope: 'editor',
      keys: ['Mod+Shift+H'],
    })
    expect(formatOf('format.horizontalRule')).toBe('horizontalRule')
    expect(command('note.newFromSelection')).toMatchObject({ scope: 'editor', keys: [] })
    expect(command('edit.pastePlain')).toMatchObject({
      scope: 'editor',
      keys: ['Mod+Alt+Shift+V'],
    })
    expect(editorCommandKeys('edit.pastePlain')).toEqual(['Shift-Mod-Alt-v'])
    // Neither is a format: the Format menu and the format keymap leave them out.
    expect(formatOf('edit.pastePlain')).toBeUndefined()
    expect(formatOf('note.newFromSelection')).toBeUndefined()
    // Typing Cmd+_ (Shift+Cmd+-) is not Decrease Font Size, nor Option+Cmd+V anything else.
    const probe = (key: string) =>
      shortcutClashes([...COMMANDS, { id: 'probe', scope: 'editor', keys: [key] }])
        .filter((c) => c.ids.includes('probe'))
        .map((c) => c.ids.find((id) => id !== 'probe'))
    expect(probe('Mod+Shift+H')).toEqual(['format.horizontalRule'])
    expect(probe('Mod+Alt+Shift+V')).toEqual(['edit.pastePlain'])
    const ruleKey = press('Minus', '_', { metaKey: true, shiftKey: true })
    expect(keyMatches('Mod+Shift+-', ruleKey)).toBe(true)
    expect(keyMatches('Mod+-', ruleKey)).toBe(false)
    expect(windowCommand(ruleKey, { inEditor: true })).toBeUndefined()
    const plainKey = press('KeyV', '\u25ca', { metaKey: true, altKey: true, shiftKey: true })
    expect(keyMatches('Mod+Alt+Shift+V', plainKey)).toBe(true)
  })

  it('declares the insertions of the slash menu as editor commands without keys', () => {
    const inserts = COMMANDS.filter((c) => c.id.startsWith('insert.'))
    expect(inserts.map((c) => [c.id, insertOf(c.id), c.scope, c.group, c.keys.length])).toEqual([
      ['insert.image', 'image', 'editor', 'format', 0],
      ['insert.table', 'table', 'editor', 'format', 0],
      ['insert.noteLink', 'noteLink', 'editor', 'format', 0],
    ])
    for (const c of inserts) expect(INSERT_COMMANDS[insertOf(c.id)!]).toBeTypeOf('function')
    // Not formats: the Format menu and the format keymap leave them out.
    for (const c of inserts) expect(formatOf(c.id)).toBeUndefined()
    expect(insertOf('format.link')).toBeUndefined()
  })

  it('opens the palette with Cmd+K anywhere, the editor too, and Link takes Option+Cmd+K', () => {
    expect(commandKeys('palette.open')).toEqual(['Mod+K'])
    const cmdK = press('KeyK', 'k', { metaKey: true })
    expect(windowCommand(cmdK, { inEditor: true })).toBe('palette.open')
    expect(windowCommand(cmdK, { inEditor: false })).toBe('palette.open')
    expect(command('format.link').keys).toEqual(['Mod+Alt+K'])
    expect(command('view.split').keys).toEqual(['Mod+P'])
  })

  it('finds window commands by key, and only those', () => {
    const cases: [KeyPress, string][] = [
      [press('KeyF', 'f', { metaKey: true, shiftKey: true }), 'search.view'],
      [press('KeyF', 'f', { metaKey: true, shiftKey: true, altKey: true }), 'search.all'],
      [press('KeyD', 'd', { metaKey: true, shiftKey: true }), 'view.focus'],
      [press('KeyY', 'y', { metaKey: true, altKey: true }), 'note.history'],
      [press('KeyN', 'n', { metaKey: true }), 'note.new'],
      [press('KeyF', 'f', { metaKey: true }), 'find.find'],
      [press('KeyC', 'c', { metaKey: true, altKey: true }), 'find.caseSensitive'],
      [press('Digit4', '4', { metaKey: true, ctrlKey: true }), 'status.completed'],
    ]
    for (const [e, id] of cases) expect(windowCommand(e, { inEditor: false })).toBe(id)
    // Note list and editor keys are theirs alone.
    expect(
      windowCommand(press('KeyD', 'd', { metaKey: true }), { inEditor: false }),
    ).toBeUndefined()
    expect(windowCommand(press('KeyM', 'm'), { inEditor: false })).toBeUndefined()
    expect(windowCommand(press('KeyB', 'b', { metaKey: true }), { inEditor: true })).toBeUndefined()
    expect(windowCommand(press('F3', 'F3'), { inEditor: true })).toBeUndefined()
  })
})

describe('labels with shortcuts', () => {
  // Button tooltips name the key in effect of their command.
  const titles: [MessageKey, CommandId][] = [
    ['mode.focusTitle', 'view.focus'],
    ['history.buttonTitle', 'note.history'],
    ['format.boldTitle', 'format.bold'],
    ['format.italicTitle', 'format.italic'],
    ['format.strikethroughTitle', 'format.strikethrough'],
    ['format.linkTitle', 'format.link'],
    ['format.codeTitle', 'format.code'],
    ['format.codeBlockTitle', 'format.codeBlock'],
    ['format.bulletListTitle', 'format.bulletList'],
    ['format.numberedListTitle', 'format.numberedList'],
    ['format.taskListTitle', 'format.taskList'],
    ['format.quoteTitle', 'format.quote'],
    ['find.nextTitle', 'find.next'],
    ['find.previousTitle', 'find.previous'],
    ['find.regexpTitle', 'find.regexp'],
    ['find.matchCaseTitle', 'find.caseSensitive'],
    ['command.backTitle', 'note.back'],
    ['command.forwardTitle', 'note.forward'],
    ['sidebar.hideTitle', 'view.sidebar'],
    ['sidebar.showTitle', 'view.sidebar'],
  ]
  afterEach(() => setCommandKeys(undefined))

  it('name the default keys', () => {
    for (const [key, id] of titles) {
      const first = command(id).keys[0]
      expect(first).toBeDefined()
      expect(titleWithKey(key, id)).toBe(`${en[key]} (${shortcutLabel(first!)})`)
      // The catalog's title names no key of its own.
      expect(en[key]).not.toMatch(/[\u2318\u2325\u21e7\u2303]/)
    }
    expect(headingTitle()).toBe(`Heading (${shortcutLabel('Mod+1')})`)
  })

  it('follow the keys in effect', () => {
    setCommandKeys(
      effectiveKeymap({
        'view.focus': ['Mod+Alt+J'],
        'format.bold': [],
      }),
    )
    expect(titleWithKey('mode.focusTitle', 'view.focus')).toBe('Focus Mode (\u2325\u2318J)')
    expect(titleWithKey('format.boldTitle', 'format.bold')).toBe('Bold')
    // Six headings on one chord with the digits 1 to 6 are shown as a range.
    const chord = Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((n) => [`format.heading${n}`, [`Mod+Alt+${n}`]]),
    )
    setCommandKeys(effectiveKeymap(chord))
    expect(headingTitle()).toBe(`Heading (${shortcutLabel('Mod+Alt+1')}\u20266)`)
    setCommandKeys(effectiveKeymap({ ...chord, 'format.heading3': ['Mod+Ctrl+3'] }))
    expect(headingTitle()).toBe(`Heading (${shortcutLabel('Mod+Alt+1')})`)
    setCommandKeys(effectiveKeymap({ 'format.heading1': [] }))
    expect(headingTitle()).toBe('Heading')
  })
})

describe('the font size keys', () => {
  it('are Cmd+= (with or without Shift, as Cmd++ is typed), Cmd+- and Cmd+0, window-wide', () => {
    expect(commandKeys('view.fontBigger')).toEqual(['Mod+=', 'Mod+Shift+='])
    expect(commandKeys('view.fontSmaller')).toEqual(['Mod+-'])
    expect(commandKeys('view.fontReset')).toEqual(['Mod+0'])
    const plus = press('Equal', '+', { metaKey: true, shiftKey: true })
    expect(windowCommand(plus, { inEditor: true })).toBe('view.fontBigger')
    expect(windowCommand(press('Minus', '-', { metaKey: true }), { inEditor: false })).toBe(
      'view.fontSmaller',
    )
    expect(windowCommand(press('Digit0', '0', { metaKey: true }), { inEditor: true })).toBe(
      'view.fontReset',
    )
  })
})

describe('keyMatches over the registry', () => {
  it('matches each key of each command', () => {
    for (const c of COMMANDS) {
      for (const key of c.keys) {
        const [last = ''] = key.split('+').slice(-1)
        const code = /^[A-Z]$/.test(last)
          ? `Key${last}`
          : /^[0-9]$/.test(last)
            ? `Digit${last}`
            : ({
                '.': 'Period',
                '/': 'Slash',
                '=': 'Equal',
                '-': 'Minus',
                '[': 'BracketLeft',
                ']': 'BracketRight',
              }[last] ?? last)
        const e = press(code, last.length === 1 ? last.toLowerCase() : last, {
          metaKey: key.includes('Mod+'),
          altKey: key.includes('Alt+'),
          shiftKey: key.includes('Shift+'),
          ctrlKey: key.includes('Ctrl+'),
        })
        expect(keyMatches(key, e)).toBe(true)
      }
    }
  })
})

describe('heldCommandKey', () => {
  const held = (code: string, key: string, mods: Partial<KeyPress> = {}) =>
    heldCommandKey(press(code, key, { repeat: true, ...mods }))

  it('is a held key of a command with Command or Control on it', () => {
    // Select All, Copy Note Link and a window key.
    expect(held('KeyA', 'a', { metaKey: true })).toBe(true)
    expect(held('KeyC', 'c', { metaKey: true })).toBe(true)
    expect(held('KeyN', 'n', { metaKey: true })).toBe(true)
    expect(held('Digit1', '1', { metaKey: true, ctrlKey: true })).toBe(true)
  })

  it('is not a first press, a key without them, another key or an editor command', () => {
    expect(heldCommandKey(press('KeyA', 'a', { metaKey: true }))).toBe(false)
    expect(held('ArrowDown', 'ArrowDown', { shiftKey: true })).toBe(false)
    expect(held('Backspace', 'Backspace')).toBe(false)
    expect(held('KeyA', 'a')).toBe(false)
    expect(held('KeyQ', 'q', { metaKey: true })).toBe(false)
    // Bold belongs to the editor, which repeats it as it likes.
    expect(held('KeyB', 'b', { metaKey: true })).toBe(false)
  })

  it('follows the keys in effect and the keyboard layout', () => {
    // French: the A key types Q; Select All is on the key that types A.
    expect(held('KeyQ', 'a', { metaKey: true })).toBe(true)
    expect(held('KeyA', 'q', { metaKey: true })).toBe(false)
  })
})

describe('the default keys', () => {
  it('give formatting, views and editing their keys', () => {
    const keys = (id: CommandId) => command(id).keys
    const table: [CommandId, string[]][] = [
      ['palette.open', ['Mod+K']],
      ['format.link', ['Mod+Alt+K']],
      ['view.split', ['Mod+P']],
      ['view.togglePreview', ['Mod+E']],
      ['format.heading1', ['Mod+1']],
      ['format.heading2', ['Mod+2']],
      ['format.heading3', ['Mod+3']],
      ['format.heading4', ['Mod+4']],
      ['format.heading5', ['Mod+Alt+5']],
      ['format.heading6', ['Mod+Alt+6']],
      ['format.strikethrough', ['Mod+U']],
      ['format.bulletList', ['Mod+Shift+L']],
      ['format.numberedList', ['Mod+Shift+O']],
      ['format.taskList', ['Mod+Shift+T']],
      ['format.quote', ["Mod+'"]],
      ['format.horizontalRule', ['Mod+Shift+H']],
      ['format.highlight', []],
      ['format.codeBlock', ['Mod+Shift+C']],
      ['format.code', ['Mod+Alt+E']],
      ['note.move', ['M']],
      ['note.moveAnywhere', ['Mod+Ctrl+M']],
      ['view.focusNoteList', ['Mod+Ctrl+L']],
      ['view.nextSidebarRow', ['Mod+Shift+J']],
      ['view.previousSidebarRow', ['Mod+Shift+K']],
      ['note.back', ['Mod+[', 'Mod+ArrowLeft']],
      ['note.forward', ['Mod+]', 'Mod+ArrowRight']],
      ['edit.plainNewline', ['Shift+Enter']],
      ['edit.lineBelow', ['Mod+Enter']],
      ['edit.lineAbove', ['Mod+Shift+Enter']],
      ['edit.deleteLine', ['Mod+D']],
      ['edit.selectLine', ['Mod+L']],
      ['edit.moveLineUp', ['Alt+ArrowUp']],
      ['edit.moveLineDown', ['Alt+ArrowDown']],
      ['edit.copyLineUp', ['Alt+Shift+ArrowUp']],
      ['edit.copyLineDown', ['Alt+Shift+ArrowDown']],
      ['edit.outdent', ['Mod+[']],
      ['edit.indent', ['Mod+]']],
      ['edit.openLink', ['Ctrl+Shift+O']],
      ['edit.sortLines', ['F5']],
      ['edit.sortLinesReverse', ['Shift+F5']],
      ['edit.sortLinesCase', ['Ctrl+F5']],
      ['edit.sortLinesCaseReverse', ['Ctrl+Shift+F5']],
      ['edit.joinLines', ['Ctrl+J']],
      ['table.alignLeft', ['Mod+Alt+ArrowLeft']],
      ['table.alignRight', ['Mod+Alt+ArrowRight']],
      ['table.alignCenter', ['Mod+Alt+ArrowUp']],
      ['table.alignNone', ['Mod+Alt+ArrowDown']],
    ]
    for (const [id, expected] of table) expect([id, keys(id)]).toEqual([id, expected])
    // Full screen is the system's own (Control+Command+F, a reserved key).
    expect(RESERVED_KEYS).toContain('Mod+Ctrl+F')
  })

  it('keep the user keys as they are when a default changes', () => {
    // Strikethrough was Shift+Cmd+X; a user who kept that key still has it.
    const keymap = effectiveKeymap({ 'format.strikethrough': ['Mod+Shift+X'] })
    expect(keymap.get('format.strikethrough')).toEqual(['Mod+Shift+X'])
    expect(keymap.get('format.bold')).toEqual(['Mod+B'])
    // A user key on a new default key of another command wins over that default.
    expect(effectiveKeymap({ 'format.bold': ['Mod+U'] }).get('format.strikethrough')).toEqual([])
  })
})
