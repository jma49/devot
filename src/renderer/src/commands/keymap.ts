// The keymap: the registry's default keys with the user's changes on top
// (Settings > Keyboard Shortcuts). A change is stored as a command's whole
// list of keys (an empty list: no key); a command without one has its
// defaults. Everything that binds or shows a key reads the result through
// `commandKeys` (registry.ts), so this is the one place the two are merged.
//
// What a command may take (`keyProblem`):
// - a key in the registry's notation, never one macOS or the app menu keeps
//   (`RESERVED_KEYS`), nor Escape, which closes and cancels everywhere, nor
//   an arrow key, Home, End, Page Up or Page Down, which move through lists,
//   the sidebar and text with any modifiers;
// - in the window, outside the editor, in the editor and in the panes (whose
//   Tab also leaves the editor), where text is typed, a key with Command or
//   Control, and not an Edit menu key (Undo, Redo, Cut, Copy, Paste, Select
//   All): keys without them type text there;
// - on a list or sidebar row any other key, as the defaults do (M, P, Delete).
// A command's own default keys are always allowed (the table keys Tab,
// Return and Option+Up, F3).
//
// Two commands may not share a key where their scopes overlap. Taking a key
// another command has takes it away from that command (`assignKey`), after
// asking; in a stored keymap that still has such a clash (a file edited by
// hand, or a later Devot with a new default), a key the user set wins over a
// default one, and between two keys the user set, the command declared
// first keeps it.
import { isShortcut, normalizeShortcut, parseShortcut, pressedKey } from './keys'
import {
  COMMANDS,
  RESERVED_KEYS,
  command,
  scopesOverlap,
  type CommandId,
  type CommandScope,
} from './registry'

/** The user's changes: a command's keys in place of its defaults. */
export type ShortcutOverrides = Readonly<Record<string, readonly string[]>>

/** A change to the overrides: new keys for a command, or null for its defaults. */
export type ShortcutPatch = Readonly<Record<string, readonly string[] | null>>

/** Every command's keys in effect. */
export type Keymap = ReadonlyMap<CommandId, readonly string[]>

/** At most this many keys per command (Rust refuses more). */
export const MAX_KEYS_PER_COMMAND = 4

/** Why a command cannot take a key. */
export type KeyProblem = 'invalid' | 'reserved' | 'navigation' | 'editMenu' | 'needsModifier'

/** Keys the Edit menu has (Undo, Redo, Cut, Copy, Paste, Select All). */
export const EDIT_MENU_KEYS: readonly string[] = [
  'Mod+Z',
  'Mod+Shift+Z',
  'Mod+X',
  'Mod+C',
  'Mod+V',
  'Mod+A',
]

/**
 * Scopes where text is typed (the editor, the title, fields) or that hold
 * them; the panes' keys also work in the editor's text (after Escape).
 */
const TYPING_SCOPES: ReadonlySet<CommandScope> = new Set([
  'window',
  'outsideEditor',
  'editor',
  'panes',
])

/** Keys that move through lists, the sidebar and text, whatever the modifiers. */
const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

const isCommandId = (id: string): id is CommandId => COMMANDS.some((c) => c.id === id)

/** Why `id` cannot take `key`, or undefined when it can. */
export function keyProblem(id: CommandId, key: string): KeyProblem | undefined {
  if (!isShortcut(key) || normalizeShortcut(key) !== key) return 'invalid'
  const spec = command(id)
  if (spec.keys.includes(key)) return undefined
  const s = parseShortcut(key)
  if (RESERVED_KEYS.includes(key) || s.key === 'Escape') return 'reserved'
  if (NAVIGATION_KEYS.has(s.key)) return 'navigation'
  if (!TYPING_SCOPES.has(spec.scope)) return undefined
  if (EDIT_MENU_KEYS.includes(key)) return 'editMenu'
  return s.mod || s.ctrl ? undefined : 'needsModifier'
}

/** Whether two commands' keys can both be live at once. */
const overlap = (a: CommandId, b: CommandId) => scopesOverlap(command(a).scope, command(b).scope)

/**
 * The keys a stored list gives `id`: valid ones, each once, at most four;
 * undefined (the defaults) when it is no list, or none of its keys is usable
 * (an empty list stays: no key).
 */
function usableKeys(id: CommandId, keys: unknown): string[] | undefined {
  if (!Array.isArray(keys)) return undefined
  const out: string[] = []
  for (const key of keys) {
    if (typeof key !== 'string' || keyProblem(id, key) !== undefined || out.includes(key)) continue
    if (out.length < MAX_KEYS_PER_COMMAND) out.push(key)
  }
  return out.length > 0 || keys.length === 0 ? out : undefined
}

/** The overrides as read from storage: known commands with a list of keys. */
export function readOverrides(value: unknown): ShortcutOverrides {
  const out: Record<string, readonly string[]> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [id, keys] of Object.entries(value)) {
    if (!isCommandId(id)) continue
    const usable = usableKeys(id, keys)
    if (usable) out[id] = usable
  }
  return out
}

/** Every command's keys: its defaults, or the user's keys in their place. */
export function effectiveKeymap(overrides: ShortcutOverrides): Keymap {
  const read = readOverrides(overrides)
  const user: [CommandId, string[]][] = []
  const kept: [CommandId, string][] = []
  // The user's keys first, in registry order: a key another of them took
  // already (where both apply) is dropped.
  for (const c of COMMANDS) {
    const keys = read[c.id]
    if (!keys) continue
    const own = keys.filter((key) => !kept.some(([id, k]) => k === key && overlap(id, c.id)))
    for (const key of own) kept.push([c.id, key])
    user.push([c.id, own])
  }
  const userKeys = new Map(user)
  return new Map(
    COMMANDS.map((c): [CommandId, readonly string[]] => [
      c.id,
      userKeys.get(c.id) ??
        (c.keys as readonly string[]).filter(
          (key) => !kept.some(([id, k]) => k === key && overlap(id, c.id)),
        ),
    ]),
  )
}

/** The commands other than `id` that have `key` where `id`'s keys apply too. */
export function keyClashes(id: CommandId, key: string, keymap: Keymap): CommandId[] {
  return COMMANDS.flatMap((c) =>
    c.id !== id && overlap(id, c.id) && (keymap.get(c.id) ?? []).includes(key) ? [c.id] : [],
  )
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i])

/** A patch with each command's keys, written as null where they are its defaults. */
function patchFor(changes: ReadonlyMap<CommandId, readonly string[]>): ShortcutPatch {
  const out: Record<string, readonly string[] | null> = {}
  for (const [id, keys] of changes) out[id] = sameKeys(keys, command(id).keys) ? null : [...keys]
  return out
}

/** Without the keys `id` takes from them, the commands it clashes with. */
function takeFrom(
  id: CommandId,
  keys: readonly string[],
  keymap: Keymap,
  into: Map<CommandId, readonly string[]>,
): CommandId[] {
  const losers: CommandId[] = []
  for (const key of keys) {
    for (const other of keyClashes(id, key, keymap)) {
      const now = into.get(other) ?? keymap.get(other) ?? []
      into.set(
        other,
        now.filter((k) => k !== key),
      )
      if (!losers.includes(other)) losers.push(other)
    }
  }
  return losers
}

/** A change and the commands it takes a key from. */
export interface KeyChange {
  patch: ShortcutPatch
  /** Commands that lose a key to it (the user is asked first). */
  takes: CommandId[]
}

/**
 * `id` gets `key` as its one key (a recorded key replaces the command's
 * keys); commands that have it where `id`'s keys apply lose it.
 */
export function assignKey(id: CommandId, key: string, keymap: Keymap): KeyChange {
  const changes = new Map<CommandId, readonly string[]>([[id, [key]]])
  const takes = takeFrom(id, [key], keymap, changes)
  return { patch: patchFor(changes), takes }
}

/** `id` gets no key. */
export function clearKeys(id: CommandId): ShortcutPatch {
  return patchFor(new Map([[id, []]]))
}

/** `id` gets its default keys back, taking them from commands that have them now. */
export function resetKeys(id: CommandId, keymap: Keymap): KeyChange {
  const defaults = command(id).keys
  const changes = new Map<CommandId, readonly string[]>([[id, defaults]])
  const takes = takeFrom(id, defaults, keymap, changes)
  return { patch: patchFor(changes), takes }
}

/** Every command back to its defaults. */
export function resetAllKeys(overrides: ShortcutOverrides): ShortcutPatch {
  return Object.fromEntries(Object.keys(overrides).map((id) => [id, null]))
}

/** The overrides with a patch applied. */
export function applyPatch(overrides: ShortcutOverrides, patch: ShortcutPatch): ShortcutOverrides {
  const out: Record<string, readonly string[]> = { ...overrides }
  for (const [id, keys] of Object.entries(patch)) {
    if (keys === null) delete out[id]
    else out[id] = keys
  }
  return out
}

/** Whether a command has keys of the user's own. */
export function isCustomized(id: CommandId, overrides: ShortcutOverrides): boolean {
  return Object.hasOwn(overrides, id)
}

/** The parts of a key press that make a shortcut. */
export interface RecordedPress {
  code?: string | undefined
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * The shortcut a key press makes, in canonical form (Command is `Mod`), or
 * undefined for a press that makes none (a modifier on its own, a key the
 * notation cannot write). The key is the character the press types, as the
 * menu bar reads it (`pressedKey`).
 */
export function shortcutOfPress(e: RecordedPress): string | undefined {
  const key = pressedKey(e)
  if (key === undefined) return undefined
  return [e.metaKey && 'Mod', e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key]
    .filter(Boolean)
    .join('+')
}
