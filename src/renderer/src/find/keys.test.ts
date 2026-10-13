import { describe, expect, it } from 'vitest'
import type { KeyPress } from '../commands/keys'
import { COMMANDS, command, shortcutClashes } from '../commands/registry'
import { noteShortcut } from '../noteMenu'
import { FIND_COMMANDS, findShortcut, type FindAction } from './keys'

const key = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  key: code.replace(/^Key/, '').toLowerCase(),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

/** A key press for a registry shortcut such as `Mod+Alt+F`. */
const pressOf = (shortcut: string): KeyPress => {
  const parts = shortcut.split('+')
  return key(`Key${parts.at(-1)}`, {
    metaKey: parts.includes('Mod'),
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
  })
}

describe('findShortcut', () => {
  it('maps each shortcut to its action', () => {
    const cases: [KeyPress, FindAction][] = [
      [key('KeyF', { metaKey: true }), 'find'],
      [key('KeyF', { metaKey: true, altKey: true }), 'replace'],
      [key('KeyG', { metaKey: true }), 'next'],
      [key('KeyG', { metaKey: true, shiftKey: true }), 'previous'],
      [key('KeyR', { metaKey: true, altKey: true }), 'regexp'],
      [key('KeyC', { metaKey: true, altKey: true }), 'caseSensitive'],
    ]
    for (const [event, action] of cases) expect(findShortcut(event)).toBe(action)
  })

  it('reads its keys from the registry, window-wide', () => {
    for (const [action, id] of Object.entries(FIND_COMMANDS)) {
      const spec = command(id)
      expect(spec.scope).toBe('window')
      for (const shortcut of spec.keys) expect(findShortcut(pressOf(shortcut))).toBe(action)
    }
  })

  it('steps on while a key is held', () => {
    expect(findShortcut(key('KeyG', { metaKey: true, repeat: true }))).toBe('next')
  })

  it('reads a real KeyboardEvent, whose fields are getters', () => {
    const KeyEvent = class {
      get code() {
        return 'KeyF'
      }
      get key() {
        return 'f'
      }
      get metaKey() {
        return true
      }
      get ctrlKey() {
        return false
      }
      get altKey() {
        return true
      }
      get shiftKey() {
        return false
      }
      get repeat() {
        return true
      }
    }
    expect(findShortcut(new KeyEvent())).toBe('replace')
  })

  it('leaves the window and note list shortcuts alone', () => {
    for (const event of [
      // Search the current view, search every note, focus mode, history.
      key('KeyF', { metaKey: true, shiftKey: true }),
      key('KeyF', { metaKey: true, shiftKey: true, altKey: true }),
      key('KeyD', { metaKey: true, shiftKey: true }),
      key('KeyY', { metaKey: true, altKey: true }),
      // Copy Note Link and Copy Note URI.
      key('KeyC', { metaKey: true }),
      key('KeyC', { metaKey: true, shiftKey: true }),
      // Other modifiers and keys.
      key('KeyF'),
      key('KeyF', { ctrlKey: true }),
      key('KeyF', { metaKey: true, ctrlKey: true }),
      key('KeyG', { metaKey: true, altKey: true }),
      key('KeyR', { metaKey: true }),
      key('KeyR', { metaKey: true, altKey: true, shiftKey: true }),
    ]) {
      expect(findShortcut(event)).toBeUndefined()
    }
  })

  it('takes no key a format, a note action or a window shortcut uses', () => {
    // Find works window-wide, so its keys clash with any other command's,
    // wherever that one works.
    const find = new Set<string>(Object.values(FIND_COMMANDS))
    const clashes = shortcutClashes(COMMANDS).filter((c) => c.ids.some((id) => find.has(id)))
    expect(clashes).toEqual([])
    const keys = Object.values(FIND_COMMANDS).flatMap((id) => command(id).keys)
    expect(new Set(keys).size).toBe(keys.length)
    const others = COMMANDS.filter((c) => !find.has(c.id)).flatMap(
      (c) => c.keys as readonly string[],
    )
    expect(keys.filter((k) => others.includes(k))).toEqual([])
  })

  it('is not mistaken for a note list shortcut', () => {
    for (const id of Object.values(FIND_COMMANDS)) {
      for (const shortcut of command(id).keys) {
        expect(noteShortcut({ ...pressOf(shortcut), repeat: false })).toBeUndefined()
      }
    }
  })
})
