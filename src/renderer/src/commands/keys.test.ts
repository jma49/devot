import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetKeys,
  isShortcut,
  keyMatches,
  normalizeShortcut,
  parseShortcut,
  pressedKey,
  rememberKey,
  shortcutAccelerator,
  shortcutCodeMirror,
  shortcutLabel,
  type KeyPress,
} from './keys'

const press = (code: string, key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...mods,
})

describe('parseShortcut', () => {
  it('reads modifiers in any order and a key', () => {
    expect(parseShortcut('Shift+Mod+d')).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: 'D',
    })
    expect(parseShortcut('Backspace')).toEqual({
      mod: false,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'Backspace',
    })
  })

  it('refuses what is not a shortcut', () => {
    for (const bad of [
      '',
      'Mod+',
      'Mod',
      'Hyper+K',
      'Mod+Mod+K',
      'Mod+KK',
      'Mod+F13',
      'Mod+\u00e9',
    ]) {
      expect(isShortcut(bad)).toBe(false)
      expect(() => parseShortcut(bad)).toThrow('E_SHORTCUT_INVALID')
    }
  })

  it('writes one canonical form', () => {
    expect(normalizeShortcut('shift+alt+mod+f')).toBe('Mod+Alt+Shift+F')
    expect(normalizeShortcut('Ctrl+Mod+Space')).toBe('Mod+Ctrl+Space')
    expect(normalizeShortcut('Mod+.')).toBe('Mod+.')
  })
})

describe('keyMatches', () => {
  it('matches letters and digits by their physical key, with exactly the modifiers', () => {
    expect(keyMatches('Mod+Shift+D', press('KeyD', 'd', { metaKey: true, shiftKey: true }))).toBe(
      true,
    )
    expect(
      keyMatches('Mod+Alt+1', press('Digit1', '\u00a1', { metaKey: true, altKey: true })),
    ).toBe(true)
    expect(keyMatches('Mod+D', press('KeyD', 'd', { metaKey: true, shiftKey: true }))).toBe(false)
    expect(keyMatches('Mod+Shift+D', press('KeyD', 'd', { metaKey: true }))).toBe(false)
    expect(keyMatches('Mod+D', press('KeyD', 'd', { ctrlKey: true }))).toBe(false)
    expect(keyMatches('M', press('KeyM', 'm', { shiftKey: true }))).toBe(false)
  })

  it('matches named keys and punctuation', () => {
    expect(keyMatches('Mod+Backspace', press('Backspace', 'Backspace', { metaKey: true }))).toBe(
      true,
    )
    expect(keyMatches('Enter', press('Enter', 'Enter'))).toBe(true)
    expect(keyMatches('Enter', press('NumpadEnter', 'Enter'))).toBe(true)
    expect(keyMatches('Mod+.', press('Period', '.', { metaKey: true }))).toBe(true)
    expect(keyMatches('Space', press('Space', ' '))).toBe(true)
  })

  it('matches the menu key, which is a named key of its own', () => {
    expect(keyMatches('ContextMenu', press('ContextMenu', 'ContextMenu'))).toBe(true)
    expect(keyMatches('Shift+F10', press('F10', 'F10', { shiftKey: true }))).toBe(true)
    expect(keyMatches('ContextMenu', press('F10', 'F10'))).toBe(false)
  })

  it('reads the key name when the physical key is not given', () => {
    expect(keyMatches('M', { ...press('', 'm'), code: undefined })).toBe(true)
    expect(keyMatches('Delete', { ...press('', 'Delete'), code: undefined })).toBe(true)
  })

  it('ignores auto-repeat, unless asked for it', () => {
    expect(keyMatches('P', press('KeyP', 'p', { repeat: true }))).toBe(false)
    expect(keyMatches('P', press('KeyP', 'p', { repeat: true }), true)).toBe(true)
    expect(keyMatches('P', press('KeyQ', 'q', { repeat: true }), true)).toBe(false)
  })
})

// The menu bar matches the character a key types, not its place on a US
// keyboard; so must the shortcuts, or the page runs one command and the menu
// would have run another.
describe('keyMatches on other keyboard layouts', () => {
  afterEach(forgetKeys)
  const cmd = { metaKey: true }

  it('French: Command+Q is Q, which is on the A key', () => {
    const quit = press('KeyA', 'q', cmd)
    expect(keyMatches('Mod+Q', quit)).toBe(true)
    expect(keyMatches('Mod+A', quit)).toBe(false)
    expect(keyMatches('Mod+A', press('KeyQ', 'a', cmd))).toBe(true)
    expect(keyMatches('Mod+Q', press('KeyQ', 'a', cmd))).toBe(false)
  })

  it('German: Command+Minus and Command+Plus are the keys that type them', () => {
    // Minus is on the US slash key, plus on the US right bracket key.
    expect(keyMatches('Mod+-', press('Slash', '-', cmd))).toBe(true)
    expect(keyMatches('Mod+/', press('Slash', '-', cmd))).toBe(false)
    expect(keyMatches('Mod+=', press('BracketRight', '+', cmd))).toBe(true)
    expect(keyMatches('Mod+]', press('BracketRight', '+', cmd))).toBe(false)
    // Z is on the US Y key.
    expect(keyMatches('Mod+Z', press('KeyY', 'z', cmd))).toBe(true)
    expect(keyMatches('Mod+Y', press('KeyY', 'z', cmd))).toBe(false)
  })

  it('Dvorak: Command+Z and Command+N are the keys that type them', () => {
    expect(keyMatches('Mod+Z', press('Slash', 'z', cmd))).toBe(true)
    expect(keyMatches('Mod+/', press('Slash', 'z', cmd))).toBe(false)
    expect(keyMatches('Mod+N', press('KeyL', 'n', cmd))).toBe(true)
    expect(keyMatches('Mod+L', press('KeyL', 'n', cmd))).toBe(false)
  })

  it('reads a letter however Shift or Caps Lock changes its case', () => {
    expect(keyMatches('Mod+Shift+D', press('KeyD', 'D', { ...cmd, shiftKey: true }))).toBe(true)
    expect(keyMatches('Mod+D', press('KeyD', 'D', cmd))).toBe(true)
  })

  it('reads Shift and punctuation from the key, as US keyboards type it', () => {
    expect(keyMatches('Mod+Shift+]', press('BracketRight', '}', { ...cmd, shiftKey: true }))).toBe(
      true,
    )
    expect(keyMatches('Mod+Shift+=', press('Equal', '+', { ...cmd, shiftKey: true }))).toBe(true)
    expect(keyMatches('Mod+Shift+8', press('Digit8', '*', { ...cmd, shiftKey: true }))).toBe(true)
  })

  it('reads a press with Option from what that key was seen to type', () => {
    // Option changes the character (Option+Y is a yen sign), so it says
    // nothing about the key. Until the key is seen, its US position does.
    const optionY = press('KeyF', '\u00a5', { ...cmd, altKey: true })
    expect(keyMatches('Mod+Alt+F', optionY)).toBe(true)
    rememberKey(press('KeyF', 'y'))
    expect(keyMatches('Mod+Alt+Y', optionY)).toBe(true)
    expect(keyMatches('Mod+Alt+F', optionY)).toBe(false)
    // Another layout: the same key types something else.
    rememberKey(press('KeyF', 'f'))
    expect(keyMatches('Mod+Alt+F', optionY)).toBe(true)
  })

  it("learns nothing from presses whose character is not the key's own", () => {
    rememberKey(press('KeyF', '\u00a5', { altKey: true }))
    rememberKey(press('Digit1', '!', { shiftKey: true }))
    rememberKey(press('Numpad1', '1'))
    rememberKey(press('KeyF', 'Dead'))
    expect(pressedKey(press('KeyF', '\u00a5', { altKey: true }))).toBe('F')
    expect(pressedKey(press('Digit1', '!', { shiftKey: true }))).toBe('1')
  })

  it('reads a key that types no ASCII character from its position (Cmd on a Cyrillic layout)', () => {
    expect(keyMatches('Mod+A', press('KeyA', '\u0444', cmd))).toBe(true)
    expect(keyMatches('Mod+Alt+1', press('Digit1', '&', { ...cmd, altKey: true }))).toBe(true)
  })

  it('matches the keypad by its keys, whatever the layout', () => {
    expect(keyMatches('Mod+=', press('NumpadEqual', '=', cmd))).toBe(true)
    expect(keyMatches('Mod+-', press('NumpadSubtract', '-', cmd))).toBe(true)
    expect(keyMatches('Mod+0', press('Numpad0', '0', cmd))).toBe(true)
    expect(keyMatches('Mod+.', press('NumpadDecimal', '.', cmd))).toBe(true)
    expect(keyMatches('Mod+/', press('NumpadDivide', '/', cmd))).toBe(true)
    // The keypad's plus grows the font like Command and the main row's equals sign.
    expect(keyMatches('Mod+=', press('NumpadAdd', '+', cmd))).toBe(true)
    expect(keyMatches('Mod+Ctrl+1', press('Numpad1', '1', { ...cmd, ctrlKey: true }))).toBe(true)
    expect(keyMatches('Mod+Ctrl+1', press('Numpad2', '2', { ...cmd, ctrlKey: true }))).toBe(false)
    // Whatever Option does to the character.
    expect(keyMatches('Mod+Alt+1', press('Numpad1', '\u00a1', { ...cmd, altKey: true }))).toBe(true)
  })
})

describe('shortcut forms', () => {
  it('shows a shortcut with the macOS symbols', () => {
    expect(shortcutLabel('Mod+Shift+D')).toBe('\u21e7\u2318D')
    expect(shortcutLabel('Mod+Alt+Shift+F')).toBe('\u2325\u21e7\u2318F')
    expect(shortcutLabel('Mod+Ctrl+Space')).toBe('\u2303\u2318Space')
    expect(shortcutLabel('Mod+Backspace')).toBe('\u2318\u232b')
    expect(shortcutLabel('Enter')).toBe('\u21a9')
    expect(shortcutLabel('ContextMenu')).toBe('Menu')
    expect(shortcutLabel('M')).toBe('M')
  })

  it('writes native menu accelerators', () => {
    expect(shortcutAccelerator('Mod+Alt+Y')).toBe('Alt+CmdOrCtrl+Y')
    expect(shortcutAccelerator('Mod+Shift+C')).toBe('Shift+CmdOrCtrl+C')
    expect(shortcutAccelerator('Mod+Backspace')).toBe('CmdOrCtrl+Backspace')
    expect(shortcutAccelerator('Mod+Ctrl+Alt+Shift+K')).toBe('Ctrl+Shift+Alt+CmdOrCtrl+K')
    expect(shortcutAccelerator('Enter')).toBe('Enter')
  })

  it('writes CodeMirror key names', () => {
    expect(shortcutCodeMirror('Mod+B')).toBe('Mod-b')
    expect(shortcutCodeMirror('Mod+Shift+X')).toBe('Shift-Mod-x')
    expect(shortcutCodeMirror('Mod+Alt+1')).toBe('Mod-Alt-1')
    expect(shortcutCodeMirror('Mod+Ctrl+Space')).toBe('Mod-Ctrl-Space')
  })
})
