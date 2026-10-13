import { describe, expect, it } from 'vitest'
import menuRs from '../../../src-tauri/src/menu.rs?raw'
import { BOOK_MENU, bookShortcut } from './bookMenu'
import type { MenuGroups } from './contextMenu'
import { COMMANDS, command } from './commands/registry'
import { NOTE_MENU, noteShortcut } from './noteMenu'
import { STATUS_COMMANDS, statusShortcut } from './statusKeys'
import { TAG_MENU } from './tagMenu'

// Shortcuts that work window-wide must not take a key another part of Devot,
// or the macOS menu bar, already uses.

interface Chord {
  ctrl: boolean
  cmd: boolean
  alt: boolean
  shift: boolean
  /** KeyboardEvent.code */
  code: string
}

const codeOf = (key: string): string => {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^\d$/.test(key)) return `Digit${key}`
  return (
    ({ ',': 'Comma', '.': 'Period', '/': 'Slash', Space: 'Space' } as Record<string, string>)[
      key
    ] ?? key
  )
}

/** A Tauri accelerator ("Alt+CmdOrCtrl+Y") or a registry key ("Mod+Shift+X"). */
function chord(spec: string): Chord {
  const parts = spec.includes('+') ? spec.split('+') : spec.split('-')
  const key = parts.at(-1) ?? ''
  const mods = parts.slice(0, -1)
  return {
    ctrl: mods.includes('Ctrl'),
    cmd: mods.some((m) => m === 'Cmd' || m === 'CmdOrCtrl' || m === 'Mod'),
    alt: mods.includes('Alt'),
    shift: mods.includes('Shift'),
    code: codeOf(key),
  }
}

/** A status key: Control+Command and the key. */
const statusChord = (code: string): Chord => ({
  ctrl: true,
  cmd: true,
  alt: false,
  shift: false,
  code,
})

const name = (c: Chord) =>
  [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.cmd && 'Cmd', c.code]
    .filter(Boolean)
    .join('+')

/** The status keys, from the registry: the key pressed with Control and Command. */
const STATUS_KEYS = Object.entries(STATUS_COMMANDS).flatMap(([status, id]) =>
  command(id).keys.map((key) => ({ status, key, code: chord(key).code })),
)
const statusIds = new Set<string>(Object.values(STATUS_COMMANDS))

const event = (c: Chord) => ({
  code: c.code,
  key: c.code.replace(/^(Key|Digit)/, '').toLowerCase(),
  metaKey: c.cmd,
  ctrlKey: c.ctrl,
  altKey: c.alt,
  shiftKey: c.shift,
  repeat: false,
})

type Entry = MenuGroups<string, never>[number][number]
/**
 * Every accelerator in a menu, submenus included, except the status
 * commands' own: the note menu's Status submenu shows those keys.
 */
const menuKeys = (groups: MenuGroups<string, never>) => {
  const keys = (entries: readonly Entry[]): string[] =>
    entries.flatMap((entry) => [
      ...(entry.accelerator && !entry.action.startsWith('status:') ? [entry.accelerator] : []),
      ...keys(entry.submenu ?? []),
    ])
  return keys(groups.flat())
}

/** Accelerators of the native menu bar's own items (src-tauri/src/menu.rs). */
const nativeMenu = [...menuRs.matchAll(/\.accelerator\("([^"]+)"\)/g)].map((m) => m[1] ?? '')

/** Keys the standard menu items and macOS itself use. */
const system = [
  'Ctrl+Cmd+F', // View > Enter Full Screen
  'Ctrl+Cmd+Q', // Lock Screen
  'Ctrl+Cmd+Space', // Emoji & Symbols
  'Ctrl+Cmd+D', // Look Up
  'Cmd+Z',
  'Shift+Cmd+Z',
  'Cmd+X',
  'Cmd+C',
  'Cmd+V',
  'Cmd+A',
  'Cmd+M',
  'Cmd+W',
  'Cmd+H',
  'Alt+Cmd+H',
]

const others = [
  // Every other command, wherever it works: the window's, the editor's, the lists'.
  ...COMMANDS.filter((c) => !statusIds.has(c.id)).flatMap((c) =>
    c.keys.map((spec: string) => ({ from: c.id, spec })),
  ),
  ...menuKeys(NOTE_MENU as MenuGroups<string, never>).map((spec) => ({ from: 'note menu', spec })),
  ...menuKeys(BOOK_MENU as MenuGroups<string, never>).map((spec) => ({ from: 'book menu', spec })),
  ...menuKeys(TAG_MENU as MenuGroups<string, never>).map((spec) => ({ from: 'tag menu', spec })),
  ...nativeMenu.map((spec) => ({ from: 'menu bar', spec })),
  ...system.map((spec) => ({ from: 'system', spec })),
]

describe('status shortcuts', () => {
  it('Control+Command+1 to 5 set none, active, on hold, completed and dropped', () => {
    expect(STATUS_KEYS.map((k) => [name(statusChord(k.code)), k.status])).toEqual([
      ['Ctrl+Cmd+Digit1', 'none'],
      ['Ctrl+Cmd+Digit2', 'active'],
      ['Ctrl+Cmd+Digit3', 'on_hold'],
      ['Ctrl+Cmd+Digit4', 'completed'],
      ['Ctrl+Cmd+Digit5', 'dropped'],
    ])
    for (const { code, status } of STATUS_KEYS) {
      expect(statusShortcut(event(statusChord(code)))).toBe(status)
    }
    // Declared in the registry as window-wide Control+Command chords.
    for (const { key } of STATUS_KEYS) expect(name(chord(key))).toMatch(/^Ctrl\+Cmd\+Digit\d$/)
    for (const id of Object.values(STATUS_COMMANDS)) expect(command(id).scope).toBe('window')
  })

  it('ignores other modifiers, other digits and auto-repeat', () => {
    const one = chord('Ctrl+Cmd+1')
    for (const keys of [
      { ...one, ctrl: false },
      { ...one, cmd: false },
      { ...one, alt: true },
      { ...one, shift: true },
      { ...one, code: 'Digit6' },
      { ...one, code: 'Digit0' },
      { ...one, code: 'KeyA' },
    ]) {
      expect([name(keys), statusShortcut(event(keys))]).toEqual([name(keys), undefined])
    }
    expect(statusShortcut({ ...event(one), repeat: true })).toBeUndefined()
  })

  it('also takes the keypad digits, which type the same characters', () => {
    for (const [digit, { status }] of STATUS_KEYS.entries()) {
      const pad = { ...statusChord(`Numpad${digit + 1}`), digit: String(digit + 1) }
      expect(statusShortcut({ ...event(pad), key: pad.digit })).toBe(status)
    }
    // The keypad's 6 is not a status key.
    expect(statusShortcut({ ...event(statusChord('Numpad6')), key: '6' })).toBeUndefined()
  })

  it('takes no key the editor, a menu, the window or the system uses', () => {
    // Make sure the lists were read.
    expect(nativeMenu).toContain('CmdOrCtrl+Q')
    expect(others.length).toBeGreaterThan(20)
    const taken = new Map(others.map(({ from, spec }) => [name(chord(spec)), from]))
    for (const { code } of STATUS_KEYS) {
      const mine = name(statusChord(code))
      expect([mine, taken.get(mine)]).toEqual([mine, undefined])
    }
    // Nor does a status shortcut fire for any of those keys.
    for (const { from, spec } of others) {
      expect([from, spec, statusShortcut(event(chord(spec)))]).toEqual([from, spec, undefined])
    }
  })

  it('is not read as a note list or notebook shortcut', () => {
    for (const { code } of STATUS_KEYS) {
      const e = event(statusChord(code))
      expect(noteShortcut(e)).toBeUndefined()
      expect(bookShortcut(e)).toBeUndefined()
    }
  })
})
