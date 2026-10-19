import { describe, expect, it } from 'vitest'
import { shortcutCodeMirror } from '../commands/keys'
import { COMMANDS, editorFormatKeys } from '../commands/registry'
import { NOTE_MENU } from '../noteMenu'

function normal(key: string): string {
  const parts = key.split('-')
  const name = parts.pop() ?? ''
  return [...parts.sort(), name.toLowerCase()].join('-')
}

const fromAccelerator = (accelerator: string) =>
  normal(accelerator.replace(/CmdOrCtrl/g, 'Mod').replace(/\+/g, '-'))

// Shortcuts that act wherever the focus is: the menu bar's items
// (src-tauri/src/menu.rs: Settings, Hide, Hide Others, Quit, the standard
// Edit and Window items, Enter Full Screen) and the registry's window-wide
// commands (search, focus mode, find, the status keys, ...).
const APP_WIDE = [
  'Mod-,',
  'Mod-h',
  'Alt-Mod-h',
  'Mod-q',
  'Mod-z',
  'Shift-Mod-z',
  'Mod-x',
  'Mod-c',
  'Mod-v',
  'Mod-a',
  'Mod-m',
  'Mod-w',
  'Ctrl-Mod-f',
  ...COMMANDS.filter((c) => c.scope === 'window').flatMap((c) =>
    c.keys.map((key: string) => shortcutCodeMirror(key)),
  ),
].map(normal)

const formatKeys = editorFormatKeys().map(({ format, key }) => [format, normal(key)] as const)

describe('format shortcuts', () => {
  it('are each used once', () => {
    const keys = formatKeys.map(([, key]) => key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('leave the shortcuts that work everywhere in the window alone', () => {
    expect(APP_WIDE).toEqual(
      expect.arrayContaining(['Mod-f', 'Ctrl-Mod-1', 'Shift-Mod-f'].map(normal)),
    )
    expect(formatKeys.filter(([, key]) => APP_WIDE.includes(key))).toEqual([])
  })

  it('share keys with the note list only where the focus tells them apart', () => {
    // Shift+Cmd+C copies a note's URI on a note list row and wraps a code
    // block in the editor: each handler only sees keys in its own area.
    const listKeys = NOTE_MENU.flat().flatMap((item) =>
      item.accelerator ? [fromAccelerator(item.accelerator)] : [],
    )
    expect(formatKeys.filter(([, key]) => listKeys.includes(key))).toEqual([
      ['codeBlock', normal('Shift-Mod-c')],
    ])
  })
})
