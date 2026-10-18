import { afterEach, describe, expect, it } from 'vitest'
import { keyMatches, shortcutAccelerator, shortcutLabel } from './keys'
import {
  EDIT_MENU_KEYS,
  applyPatch,
  assignKey,
  clearKeys,
  effectiveKeymap,
  isCustomized,
  keyClashes,
  keyProblem,
  readOverrides,
  resetAllKeys,
  resetKeys,
  shortcutOfPress,
  type RecordedPress,
} from './keymap'
import {
  COMMANDS,
  RESERVED_KEYS,
  commandKeys,
  defaultKeys,
  editorFormatKeys,
  formatMenuKeys,
  setCommandKeys,
  shortcutClashes,
  windowCommand,
} from './registry'

const press = (code: string, key: string, mods: Partial<RecordedPress> = {}): RecordedPress => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

/** The keymap as commands with their keys, for `shortcutClashes`. */
const asCommands = (keymap: ReturnType<typeof effectiveKeymap>) =>
  COMMANDS.map((c) => ({ id: c.id, scope: c.scope, keys: keymap.get(c.id) ?? [] }))

afterEach(() => setCommandKeys(undefined))

describe('the default keymap', () => {
  it('is every command with its registry keys', () => {
    const keymap = effectiveKeymap({})
    expect(keymap.size).toBe(COMMANDS.length)
    for (const c of COMMANDS) expect(keymap.get(c.id)).toEqual(c.keys)
  })

  it('gives every default key to its own command', () => {
    for (const c of COMMANDS)
      for (const key of c.keys) expect(keyProblem(c.id, key)).toBeUndefined()
  })
})

describe('keyProblem', () => {
  it('refuses what is not a canonical shortcut', () => {
    for (const key of ['', 'Mod+', 'Hyper+K', 'Shift+Mod+K', 'mod+k', 'Mod+KK'])
      expect(keyProblem('format.bold', key)).toBe('invalid')
  })

  it('refuses the keys macOS and the app menu keep, and Escape', () => {
    for (const key of RESERVED_KEYS) {
      expect(keyProblem('format.bold', key)).toBe('reserved')
      expect(keyProblem('note.pin', key)).toBe('reserved')
    }
    for (const key of ['Mod+Q', 'Mod+H', 'Mod+M', 'Mod+W', 'Mod+Tab', 'Mod+Space', 'Mod+,'])
      expect(keyProblem('note.new', key)).toBe('reserved')
    expect(keyProblem('note.new', 'Mod+Escape')).toBe('reserved')
    expect(keyProblem('note.pin', 'Escape')).toBe('reserved')
  })

  it('needs Command or Control where text is typed', () => {
    for (const id of ['note.new', 'palette.open', 'format.bold'] as const) {
      for (const key of ['J', 'Shift+J', 'Alt+J', 'Alt+Shift+1', 'F5', 'Enter', 'Space'])
        expect(keyProblem(id, key)).toBe('needsModifier')
      for (const key of ['Mod+J', 'Ctrl+J', 'Ctrl+Alt+F5', 'Mod+Shift+Enter'])
        expect(keyProblem(id, key)).toBeUndefined()
    }
    // Its own defaults stay allowed: the table keys, F3.
    expect(keyProblem('table.nextCell', 'Tab')).toBeUndefined()
    expect(keyProblem('table.moveRowUp', 'Mod+Alt+Shift+ArrowUp')).toBeUndefined()
    expect(keyProblem('find.nextInEditor', 'F3')).toBeUndefined()
    expect(keyProblem('table.nextCell', 'Enter')).toBe('needsModifier')
  })

  it('leaves the Edit menu keys to the Edit menu where text is typed', () => {
    for (const key of EDIT_MENU_KEYS) {
      expect(keyProblem('note.new', key)).toBe('editMenu')
      expect(keyProblem('format.bold', key)).toBe('editMenu')
    }
    // On a list row Cmd+C copies the note's link, as by default.
    expect(keyProblem('note.copyLink', 'Mod+C')).toBeUndefined()
    expect(keyProblem('note.duplicate', 'Mod+V')).toBeUndefined()
  })

  it('takes any other key on a list or sidebar row', () => {
    for (const key of ['J', 'Shift+J', 'Alt+J', 'F5', 'Enter', 'Backspace', 'Space'])
      for (const id of ['note.pin', 'trash.restore', 'notebook.rename', 'tag.delete'] as const)
        expect(keyProblem(id, key)).toBeUndefined()
  })

  it('leaves the keys that move through lists and text to them', () => {
    for (const key of [
      'ArrowLeft',
      'Alt+ArrowRight',
      'Mod+ArrowUp',
      'Home',
      'Shift+End',
      'PageDown',
    ])
      for (const id of ['notebook.moveToTop', 'note.pin', 'note.new', 'format.bold'] as const)
        expect(keyProblem(id, key)).toBe('navigation')
    // A table row moves on Shift+Option+Cmd+Up by default.
    expect(keyProblem('table.moveRowUp', 'Mod+Alt+Shift+ArrowUp')).toBeUndefined()
  })

  it('needs Command or Control for the panes keys, which work in the editor text too', () => {
    expect(keyProblem('view.nextAreaInPane', 'J')).toBe('needsModifier')
    expect(keyProblem('view.nextAreaInPane', 'Space')).toBe('needsModifier')
    expect(keyProblem('view.nextAreaInPane', 'Tab')).toBeUndefined()
    expect(keyProblem('view.nextAreaInPane', 'Ctrl+J')).toBeUndefined()
  })
})

describe('effectiveKeymap', () => {
  it('puts the user keys in place of the defaults', () => {
    const keymap = effectiveKeymap({ 'view.focus': ['Mod+Alt+J'], 'note.copyId': ['Mod+Alt+I'] })
    expect(keymap.get('view.focus')).toEqual(['Mod+Alt+J'])
    expect(keymap.get('note.copyId')).toEqual(['Mod+Alt+I'])
    expect(keymap.get('note.new')).toEqual(['Mod+N'])
    // No key at all.
    expect(effectiveKeymap({ 'format.bold': [] }).get('format.bold')).toEqual([])
  })

  it('ignores unknown commands and keys a command may not take', () => {
    const keymap = effectiveKeymap({
      'nope.command': ['Mod+J'],
      'note.new': ['Mod+Q', 'J', 'Mod+Alt+N', 'Mod+Alt+N', 'garbage'],
    } as Record<string, string[]>)
    expect(keymap.get('note.new')).toEqual(['Mod+Alt+N'])
    expect([...keymap.keys()]).not.toContain('nope.command')
    expect(readOverrides({ 'note.new': 'Mod+J', 'note.pin': [1, 'Q'] })).toEqual({
      'note.pin': ['Q'],
    })
    // A list with no usable key leaves the defaults; an empty one means no key.
    expect(readOverrides({ 'note.new': ['J'], 'note.copyLink': [] })).toEqual({
      'note.copyLink': [],
    })
    expect(effectiveKeymap({ 'note.new': ['J'] }).get('note.new')).toEqual(['Mod+N'])
    expect(readOverrides(null)).toEqual({})
    expect(readOverrides(['note.new'])).toEqual({})
  })

  it('keeps at most four keys per command', () => {
    const keys = ['Mod+Alt+1', 'Mod+Alt+2', 'Mod+Alt+3', 'Mod+Alt+4', 'Mod+Alt+5'].map((k) =>
      k.replace('Alt', 'Ctrl'),
    )
    expect(effectiveKeymap({ 'note.new': keys }).get('note.new')).toHaveLength(4)
  })

  it('lets a user key win over a default one where both apply', () => {
    // Cmd+K is the palette's by default.
    const keymap = effectiveKeymap({ 'format.bold': ['Mod+K'] })
    expect(keymap.get('format.bold')).toEqual(['Mod+K'])
    expect(keymap.get('palette.open')).toEqual([])
    expect(shortcutClashes(asCommands(keymap))).toEqual([])
    // Where scopes never meet, both keep it.
    const apart = effectiveKeymap({ 'format.bold': ['Mod+Shift+C'] })
    expect(apart.get('note.copyUri')).toEqual(['Mod+Shift+C'])
  })

  it('gives a key two users set to the command declared first', () => {
    const keymap = effectiveKeymap({ 'view.focus': ['Mod+Alt+J'], 'note.new': ['Mod+Alt+J'] })
    expect(keymap.get('note.new')).toEqual(['Mod+Alt+J'])
    expect(keymap.get('view.focus')).toEqual([])
    expect(shortcutClashes(asCommands(keymap))).toEqual([])
  })
})

describe('assigning keys', () => {
  it('replaces the command keys with the recorded one', () => {
    const keymap = effectiveKeymap({})
    const change = assignKey('view.fontBigger', 'Mod+Alt+=', keymap)
    expect(change).toEqual({ patch: { 'view.fontBigger': ['Mod+Alt+='] }, takes: [] })
  })

  it('takes the key from commands that have it where both apply', () => {
    const keymap = effectiveKeymap({})
    // The palette (window) and Bold (editor) overlap; Copy Note URI (note list) does not.
    const change = assignKey('format.bold', 'Mod+K', keymap)
    expect(change.takes).toEqual(['palette.open'])
    expect(change.patch).toEqual({ 'format.bold': ['Mod+K'], 'palette.open': [] })
    const next = effectiveKeymap(applyPatch({}, change.patch))
    expect(next.get('palette.open')).toEqual([])
    expect(shortcutClashes(asCommands(next))).toEqual([])

    expect(assignKey('format.bold', 'Mod+Shift+C', keymap).takes).toEqual(['format.codeBlock'])
    expect(assignKey('note.pin', 'Mod+Shift+C', keymap).takes).toEqual(['note.copyUri'])
    // A command with two keys keeps the other.
    const font = assignKey('note.new', 'Mod+Shift+=', keymap)
    expect(font.patch['view.fontBigger']).toEqual(['Mod+='])
  })

  it('finds clashes only where scopes overlap', () => {
    const keymap = effectiveKeymap({})
    expect(keyClashes('note.pin', 'Mod+Backspace', keymap)).toEqual(['note.trash'])
    expect(keyClashes('trash.restore', 'Mod+Backspace', keymap)).toEqual(['trash.deleteForever'])
    expect(keyClashes('notebook.rename', 'Mod+Backspace', keymap)).toEqual([])
    expect(keyClashes('note.new', 'Mod+K', keymap)).toEqual(['palette.open'])
    expect(keyClashes('note.new', 'Mod+Alt+K', keymap)).toEqual(['format.link'])
    expect(keyClashes('format.link', 'Mod+Alt+K', keymap)).toEqual([])
  })

  it('writes the defaults as no change', () => {
    const overrides = applyPatch(
      {},
      assignKey('format.bold', 'Mod+Alt+B', effectiveKeymap({})).patch,
    )
    expect(isCustomized('format.bold', overrides)).toBe(true)
    // Recording the default key again is the default again.
    expect(assignKey('format.bold', 'Mod+B', effectiveKeymap(overrides)).patch).toEqual({
      'format.bold': null,
    })
  })

  it('clears a command, and resets one or all', () => {
    expect(clearKeys('format.bold')).toEqual({ 'format.bold': [] })
    // A command without default keys has nothing to clear.
    expect(clearKeys('note.copyId')).toEqual({ 'note.copyId': null })

    let overrides = applyPatch({}, assignKey('format.bold', 'Mod+K', effectiveKeymap({})).patch)
    // Resetting the palette takes Cmd+K back from Bold.
    const reset = resetKeys('palette.open', effectiveKeymap(overrides))
    expect(reset).toEqual({
      patch: { 'palette.open': null, 'format.bold': [] },
      takes: ['format.bold'],
    })
    overrides = applyPatch(overrides, reset.patch)
    expect(effectiveKeymap(overrides).get('palette.open')).toEqual(['Mod+K'])
    expect(effectiveKeymap(overrides).get('format.bold')).toEqual([])

    expect(resetAllKeys(overrides)).toEqual({ 'format.bold': null })
    expect(applyPatch(overrides, resetAllKeys(overrides))).toEqual({})
  })
})

describe('the keys in effect', () => {
  it('are what the window, the editor, the Format menu and menus read', () => {
    const keymap = effectiveKeymap({
      'view.focus': ['Mod+Alt+J'],
      'format.bold': ['Mod+Alt+B'],
      'format.italic': [],
    })
    setCommandKeys(keymap)
    expect(commandKeys('view.focus')).toEqual(['Mod+Alt+J'])
    expect(defaultKeys('view.focus')).toEqual(['Mod+Shift+D'])
    const meta = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
    expect(
      windowCommand({ ...meta, code: 'KeyJ', key: 'j', altKey: true }, { inEditor: true }),
    ).toBe('view.focus')
    expect(
      windowCommand({ ...meta, code: 'KeyD', key: 'd', shiftKey: true }, { inEditor: true }),
    ).toBeUndefined()
    expect(editorFormatKeys()).toContainEqual({ format: 'bold', key: 'Mod-Alt-b' })
    expect(editorFormatKeys().filter((k) => k.format === 'italic')).toEqual([])
    expect(formatMenuKeys()['format.bold']).toBe('Alt+CmdOrCtrl+B')
    expect(formatMenuKeys()).not.toHaveProperty('format.italic')

    setCommandKeys(undefined)
    expect(commandKeys('view.focus')).toEqual(['Mod+Shift+D'])
  })
})

describe('shortcutOfPress', () => {
  it('reads a key press in canonical form, by physical key', () => {
    expect(shortcutOfPress(press('KeyB', 'b', { metaKey: true }))).toBe('Mod+B')
    expect(
      shortcutOfPress(
        press('KeyX', '\u02db', { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }),
      ),
    ).toBe('Mod+Ctrl+Alt+Shift+X')
    expect(shortcutOfPress(press('Digit1', '\u00a1', { altKey: true, metaKey: true }))).toBe(
      'Mod+Alt+1',
    )
    expect(shortcutOfPress(press('BracketLeft', '{', { metaKey: true, shiftKey: true }))).toBe(
      'Mod+Shift+[',
    )
    expect(shortcutOfPress(press('Slash', '/', {}))).toBe('/')
    expect(shortcutOfPress(press('NumpadEnter', 'Enter', { metaKey: true }))).toBe('Mod+Enter')
    expect(shortcutOfPress(press('F5', 'F5', { shiftKey: true }))).toBe('Shift+F5')
    expect(shortcutOfPress(press('Space', ' ', { ctrlKey: true }))).toBe('Ctrl+Space')
    expect(shortcutOfPress(press('', 'k', { metaKey: true }))).toBe('Mod+K')
  })

  it('reads the character a key types, as the menu bar does', () => {
    // French: Q is on the A key, so this is Quit and is refused as reserved.
    const quit = shortcutOfPress(press('KeyA', 'q', { metaKey: true }))
    expect(quit).toBe('Mod+Q')
    expect(RESERVED_KEYS).toContain(quit)
    // German: Minus is on the US slash key and Plus on the right bracket key.
    expect(shortcutOfPress(press('Slash', '-', { metaKey: true }))).toBe('Mod+-')
    expect(shortcutOfPress(press('BracketRight', '+', { metaKey: true }))).toBe('Mod+=')
    // Dvorak: Z is on the slash key.
    expect(shortcutOfPress(press('Slash', 'z', { metaKey: true }))).toBe('Mod+Z')
  })

  it('reads the keypad', () => {
    expect(shortcutOfPress(press('NumpadEqual', '=', { metaKey: true }))).toBe('Mod+=')
    expect(shortcutOfPress(press('NumpadSubtract', '-', { metaKey: true }))).toBe('Mod+-')
    expect(shortcutOfPress(press('Numpad0', '0', { metaKey: true }))).toBe('Mod+0')
    expect(shortcutOfPress(press('Numpad1', '1', { metaKey: true, ctrlKey: true }))).toBe(
      'Mod+Ctrl+1',
    )
  })

  it('makes nothing of a modifier alone or a key it cannot write', () => {
    for (const code of ['MetaLeft', 'ShiftRight', 'AltLeft', 'ControlLeft', 'CapsLock', 'F13'])
      expect(shortcutOfPress(press(code, code, { metaKey: true }))).toBeUndefined()
    expect(shortcutOfPress(press('IntlBackslash', '\u00a7'))).toBeUndefined()
  })

  it('reads every default key back from the press that makes it', () => {
    const codes: Record<string, string> = {
      '.': 'Period',
      '/': 'Slash',
      '=': 'Equal',
      '-': 'Minus',
      '[': 'BracketLeft',
      ']': 'BracketRight',
      '\\': 'Backslash',
    }
    for (const c of COMMANDS) {
      for (const key of c.keys as readonly string[]) {
        const last = key.split('+').at(-1)!
        const code = /^[A-Z]$/.test(last)
          ? `Key${last}`
          : /^[0-9]$/.test(last)
            ? `Digit${last}`
            : (codes[last] ?? last)
        const e = press(code, last, {
          metaKey: key.includes('Mod+'),
          ctrlKey: key.includes('Ctrl+'),
          altKey: key.includes('Alt+'),
          shiftKey: key.includes('Shift+'),
        })
        expect(shortcutOfPress(e)).toBe(key)
        expect(keyMatches(key, e)).toBe(true)
      }
    }
  })
})

describe('display', () => {
  it('shows a recorded key as macOS does, and as a menu accelerator', () => {
    const key = shortcutOfPress(press('KeyJ', 'j', { metaKey: true, altKey: true }))!
    expect(shortcutLabel(key)).toBe('\u2325\u2318J')
    expect(shortcutAccelerator(key)).toBe('Alt+CmdOrCtrl+J')
  })
})
