import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { normalizeShortcut, shortcutAccelerator } from '../../src/renderer/src/commands/keys'
import { EDIT_MENU_KEYS } from '../../src/renderer/src/commands/keymap'
import {
  COMMANDS,
  NATIVE_MENU_COMMANDS,
  QUICK_CAPTURE_KEY,
  RESERVED_KEYS,
  command,
  commandMenuKeys,
  formatMenuKeys,
  formatOf,
  type CommandId,
} from '../../src/renderer/src/commands/registry'
import { en, type MessageKey } from '../../src/renderer/src/i18n/en'

// Rust builds menu accelerators from the registry's default keys and the window sets the effective ones
// (`command_menu_set`); defaults must match, and the menu's own keys (Quit, Settings) must stay clear of every command.
const MENU = readFileSync('src-tauri/src/menu.rs', 'utf8')

const ids = new Map(
  [...MENU.matchAll(/pub const (\w+_ID): &str = "([^"]+)";/g)].map((m) => [m[1]!, m[2]!]),
)

const accelerators = [
  ...MENU.matchAll(/MenuItemBuilder::with_id\((\w+),[^)]*\)\s*\.accelerator\("([^"]+)"\)/g),
].map((m) => ({ id: ids.get(m[1]!) ?? m[1]!, accelerator: m[2]! }))

const asShortcut = (accelerator: string) =>
  normalizeShortcut(
    accelerator
      .split('+')
      .map((part) => (part === 'CmdOrCtrl' ? 'Mod' : part))
      .join('+'),
  )

it('reads the menu', () => {
  expect(accelerators.map((a) => a.id)).toEqual(
    expect.arrayContaining([
      'devot.quit',
      'devot.settings',
      'devot.history',
      'devot.palette',
      'devot.sidebar',
    ]),
  )
})

it('shows each command at its registry key', () => {
  for (const [id, commandId] of Object.entries(NATIVE_MENU_COMMANDS)) {
    const item = accelerators.find((a) => a.id === id)
    const key = command(commandId).keys[0]
    expect(item?.accelerator).toBe(key === undefined ? undefined : shortcutAccelerator(key))
  }
})

it('keeps its own keys apart from the commands, and reserved', () => {
  const own = accelerators
    .filter((a) => !Object.hasOwn(NATIVE_MENU_COMMANDS, a.id))
    .map((a) => asShortcut(a.accelerator))
  expect(own).toEqual(['Mod+Q', 'Mod+,', 'Mod+Shift+N'])
  for (const key of own) expect(RESERVED_KEYS).toContain(key)
  const used = COMMANDS.flatMap((c) => c.keys as readonly string[])
  expect(used.filter((key) => own.includes(key))).toEqual([])
})

// Quick capture's global shortcut (menu bar mode) is registered in Rust; while it is on, the system
// gives that key to Devot in every app, Devot's own windows included, so no command may have it.
it('keeps the quick capture shortcut in line with Rust and clear of every command', () => {
  const rust = /pub const QUICK_CAPTURE_SHORTCUT: &str = "([^"]+)";/.exec(
    readFileSync('src-tauri/src/menu_bar.rs', 'utf8'),
  )?.[1]
  expect(rust).toBe(shortcutAccelerator(QUICK_CAPTURE_KEY))
  expect(RESERVED_KEYS).toContain(QUICK_CAPTURE_KEY)
  const used = COMMANDS.flatMap((c) => c.keys as readonly string[])
  expect(used).not.toContain(QUICK_CAPTURE_KEY)
  expect(accelerators.map((a) => asShortcut(a.accelerator))).not.toContain(QUICK_CAPTURE_KEY)
})

// The Format menu holds no keys itself: the UI sets them from the registry (`formatMenuKeys`) while the editor has the keyboard.
const FORMAT_MENU = readFileSync('src-tauri/src/format_menu.rs', 'utf8')
const STRINGS = new Map(
  [
    ...readFileSync('src-tauri/src/strings.rs', 'utf8').matchAll(
      /pub const (\w+): &str = "([^"]*)";/g,
    ),
  ].map((m) => [m[1]!, m[2]!]),
)
// rustfmt may break a long item over several lines.
const formatItems = [...FORMAT_MENU.matchAll(/\bitem\(\s*"([^"]+)",\s*strings::(\w+),?\s*\)/g)].map(
  (m) => ({
    id: m[1]!,
    label: STRINGS.get(m[2]!),
  }),
)
const formatCommands = COMMANDS.filter((c) => formatOf(c.id) !== undefined).map((c) => c.id)

it('has a Format menu item for each format command', () => {
  expect(formatCommands.length).toBeGreaterThan(20)
  expect(formatItems.map((item) => item.id).sort()).toEqual([...formatCommands].sort())
})

it('labels the Format menu as the app labels the formats', () => {
  for (const { id, label } of formatItems) {
    // Alerts sit in an Alert submenu, under the toolbar pop-up's names.
    const alert = /^format\.alert(\w+)$/.exec(id)?.[1]
    const key: MessageKey = alert
      ? (`alert.${alert.toLowerCase()}` as MessageKey)
      : command(id as CommandId).label
    expect({ id, label }).toEqual({ id, label: en[key] })
  }
})

it('sets the Format menu keys from the registry only', () => {
  // Its code (before its tests) sets no accelerator of its own.
  expect(FORMAT_MENU.split('#[cfg(test)]')[0]).not.toMatch(/\.accelerator\(/)
  const keys = formatMenuKeys()
  for (const id of formatCommands) {
    const key = command(id).keys[0]
    expect({ id, key: keys[id] }).toEqual({
      id,
      key: key === undefined ? undefined : shortcutAccelerator(key),
    })
  }
})

// `format_menu_set` refuses the whole map when one key is unreadable or taken by another menu bar item
// (`MENU_BAR_KEYS`), leaving the menu greyed out and Cmd+I lost.
const menuBarKeys = [
  ...(/const MENU_BAR_KEYS: &\[&str\] = &\[([\s\S]*?)\n\];/.exec(FORMAT_MENU)?.[1] ?? '').matchAll(
    /"([^"]+)"/g,
  ),
].map((m) => m[1]!)

it('keeps the Format menu keys off the menu bar keys', () => {
  expect(menuBarKeys).toEqual(
    expect.arrayContaining(['CmdOrCtrl+Q', 'CmdOrCtrl+Z', 'CmdOrCtrl+A', 'Ctrl+CmdOrCtrl+F']),
  )
  for (const { id, accelerator } of accelerators) {
    expect({ id, listed: menuBarKeys.includes(accelerator) }).toEqual({
      id,
      listed: !Object.hasOwn(NATIVE_MENU_COMMANDS, id),
    })
  }
  // No command can take a key where text is typed (a list row may copy with Cmd+C, as by default):
  // each is reserved or an Edit menu key.
  for (const key of menuBarKeys.map(asShortcut))
    expect([...RESERVED_KEYS, ...EDIT_MENU_KEYS]).toContain(key)
  const taken = new Set(menuBarKeys.map(asShortcut))
  for (const [id, accelerator] of Object.entries(formatMenuKeys())) {
    expect({ id, accelerator, taken: taken.has(asShortcut(accelerator)) }).toEqual({
      id,
      accelerator,
      taken: false,
    })
    // Rust accepts only keys with Command or Control.
    expect(accelerator.split('+').slice(0, -1)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(CmdOrCtrl|Ctrl)$/)]),
    )
  }
})

// Shared with format_menu.rs's tests (run through `plan`), so the two sides cannot drift apart.
const FORMAT_MENU_KEYS = 'src-tauri/tests/fixtures/format-menu-keys.json'

it('sends the Format menu the keys its Rust tests accept', () => {
  expect(formatMenuKeys()).toEqual(JSON.parse(readFileSync(FORMAT_MENU_KEYS, 'utf8')))
  expect(FORMAT_MENU).toContain(`include_str!("../tests/fixtures/format-menu-keys.json")`)
})

// View > Hide Sidebar reads Show Sidebar while hidden, as the UI's command label does.
it('labels View > Hide Sidebar as the app labels the command', () => {
  expect(MENU).toMatch(/MenuItemBuilder::with_id\(SIDEBAR_ID, strings::HIDE_SIDEBAR\)/)
  expect(STRINGS.get('HIDE_SIDEBAR')).toBe(en['command.hideSidebar'])
  expect(STRINGS.get('SHOW_SIDEBAR')).toBe(en['command.showSidebar'])
  expect(command('view.sidebar').label).toBe('command.hideSidebar')
})

// These items take the keys in effect from the main window (`command_menu_set`), which accepts only the
// commands Rust lists, with keys `format_menu_set` would read.
it('sets the command items keys Rust accepts', () => {
  const items = [
    ...MENU.matchAll(/CommandItem \{\s*place: MenuPlace::\w+,\s*command: "([^"]+)"/g),
  ].map((m) => m[1])
  expect(items).toContain('view.syncScroll')
  expect(items).toContain('app.backups')
  expect(items.sort()).toEqual(Object.values(NATIVE_MENU_COMMANDS).sort())
  const keys = commandMenuKeys()
  expect(Object.keys(keys).sort()).toEqual(items)
  for (const [id, accelerator] of Object.entries(keys)) {
    const key = command(id as CommandId).keys[0]
    expect({ id, accelerator }).toEqual({
      id,
      accelerator: key === undefined ? null : shortcutAccelerator(key),
    })
  }
  expect(commandMenuKeys(() => [])).toEqual(Object.fromEntries(items.map((id) => [id, null])))
  // A key the user gives the check item reaches it as the others' do.
  expect(commandMenuKeys(() => ['Mod+Shift+J'])['view.syncScroll']).toBe(
    shortcutAccelerator('Mod+Shift+J'),
  )
})

// Rust builds items into `CommandMenu` in `COMMAND_ITEMS` order.
it('keeps every command item to set its key', () => {
  const kept = /\.zip\(\[([\s\S]*?)\]\)/.exec(MENU)?.[1] ?? ''
  expect(
    [...kept.matchAll(/CommandMenuItem::(\w+)\((\w+)\.clone\(\)\)/g)].map((m) => m.slice(1)),
  ).toEqual([
    ['Plain', 'history'],
    ['Plain', 'palette'],
    ['Plain', 'sidebar'],
    ['Plain', 'toggle_preview'],
    ['Plain', 'split'],
    ['Check', 'sync_scroll'],
    ['Plain', 'backups'],
  ])
})

// Rust refuses the keys the registry reserves, so the two lists are one.
it('reserves the same keys in Rust', () => {
  const rust = readFileSync('src-tauri/src/keyboard_shortcuts.rs', 'utf8')
  const reserved = [
    ...(/pub const RESERVED: &\[&str\] = &\[([\s\S]*?)\n\];/.exec(rust)?.[1] ?? '').matchAll(
      /"([^"]+)"/g,
    ),
  ].map((m) => m[1])
  expect(reserved).toEqual(RESERVED_KEYS)
})

// File > New Window is a menu item of Rust's own (it opens the window without asking a page), and
// the palette's New Window runs the same.
it('labels File > New Window as the app labels the command', () => {
  expect(MENU).toMatch(/MenuItemBuilder::with_id\(NEW_WINDOW_ID, strings::NEW_WINDOW\)/)
  expect(STRINGS.get('NEW_WINDOW')).toBe(en['command.newWindow'])
  expect(command('app.newWindow').keys).toEqual([])
})
