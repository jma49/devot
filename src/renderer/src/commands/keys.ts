// The key model: shortcuts written the same way on every platform, such as
// `Mod+Shift+D`. `Mod` is Command on macOS. Modifiers come first, in any
// order (`normalizeShortcut` gives the canonical one: Mod, Ctrl, Alt, Shift),
// then one key: a letter, a digit, a punctuation mark or a named key.

/** A parsed shortcut. */
export interface Shortcut {
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** A letter (upper case), a digit, a punctuation mark or a name in `NAMED`. */
  key: string
}

/** The parts of a key press a shortcut is matched against. */
export interface KeyPress {
  /** The physical key (`KeyD`), which Option and Shift on digits and punctuation fall back to. */
  code?: string | undefined
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

/** Named keys and what macOS shows for them. */
const NAMED: Readonly<Record<string, string>> = {
  Enter: '\u21a9',
  Backspace: '\u232b',
  Delete: '\u2326',
  Escape: '\u238b',
  Tab: '\u21e5',
  Space: 'Space',
  ArrowUp: '\u2191',
  ArrowDown: '\u2193',
  ArrowLeft: '\u2190',
  ArrowRight: '\u2192',
  Home: '\u2196',
  End: '\u2198',
  PageUp: '\u21de',
  PageDown: '\u21df',
  // The menu key (it opens the context menu where a keyboard has one).
  ContextMenu: 'Menu',
  // Function keys show as themselves.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`])),
}

/** Punctuation keys by their physical key. */
const PUNCTUATION: Readonly<Record<string, string>> = {
  '.': 'Period',
  ',': 'Comma',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
}

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const

function keyName(token: string): string | undefined {
  if (/^[a-z]$/i.test(token)) return token.toUpperCase()
  if (/^[0-9]$/.test(token) || Object.hasOwn(PUNCTUATION, token)) return token
  return Object.hasOwn(NAMED, token) ? token : undefined
}

/** Shortcuts read so far: a key press is matched against many of them. */
const parsed = new Map<string, Readonly<Shortcut>>()

/** Reads a shortcut; throws `E_SHORTCUT_INVALID` for anything else. */
export function parseShortcut(text: string): Shortcut {
  const known = parsed.get(text)
  if (known) return { ...known }
  const out = readShortcut(text)
  parsed.set(text, Object.freeze({ ...out }))
  return out
}

function readShortcut(text: string): Shortcut {
  const parts = text.split('+')
  // `Mod++` is not a shortcut: `+` is the separator.
  const last = parts.pop() ?? ''
  const key = keyName(last)
  const out: Shortcut = { mod: false, ctrl: false, alt: false, shift: false, key: key ?? '' }
  if (key === undefined) throw new Error('E_SHORTCUT_INVALID')
  for (const part of parts) {
    const name = MODIFIERS.find((m) => m.toLowerCase() === part.toLowerCase())
    const field =
      name === undefined ? undefined : (name.toLowerCase() as keyof Omit<Shortcut, 'key'>)
    if (field === undefined || out[field]) throw new Error('E_SHORTCUT_INVALID')
    out[field] = true
  }
  return out
}

export function isShortcut(text: string): boolean {
  try {
    parseShortcut(text)
    return true
  } catch {
    return false
  }
}

/** The canonical way to write a shortcut: `Mod+Ctrl+Alt+Shift+Key`. */
export function normalizeShortcut(text: string): string {
  const s = parseShortcut(text)
  return [s.mod && 'Mod', s.ctrl && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', s.key]
    .filter(Boolean)
    .join('+')
}

/** What the keypad's keys are in the shortcut notation (digits are read separately). */
const NUMPAD: Readonly<Record<string, string>> = {
  NumpadDecimal: '.',
  NumpadDivide: '/',
  NumpadSubtract: '-',
  NumpadEqual: '=',
  // Command and the keypad's plus grow the font, as Command and the main row's `=` do.
  NumpadAdd: '=',
}

/** The key a physical key has on a US keyboard, the fallback when the character is not known. */
function positionalKey(code: string): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code)?.[1]
  if (letter) return letter
  const digit = /^Digit([0-9])$/.exec(code)?.[1]
  if (digit) return digit
  for (const [key, name] of Object.entries(PUNCTUATION)) if (name === code) return key
  return undefined
}

/**
 * What each physical key types on the keyboard layout in use, learned from
 * the key presses seen (`rememberKey`): the character of a press with
 * neither Option nor Shift. The characters of the presses that have one of
 * them are not the key's own, and the page cannot ask the system for the
 * layout, so the key's position stands in until the key has been seen.
 */
const typed = new Map<string, string>()

/** The key a character is in the shortcut notation, if it has one. */
function keyOfCharacter(ch: string, shift: boolean): string | undefined {
  if (/^[a-z]$/i.test(ch)) return ch.toUpperCase()
  // Shift and `=` makes a plus on a US keyboard; a plus key of its own makes it on others.
  if (ch === '+') return '='
  if (shift) return undefined
  return /^[0-9]$/.test(ch) || Object.hasOwn(PUNCTUATION, ch) ? ch : undefined
}

/** The named key a press is, if it is one (the keypad's Enter is Enter). */
function namedKey(e: Pick<KeyPress, 'code' | 'key'>): string | undefined {
  if (e.code === 'NumpadEnter') return 'Enter'
  if (e.code && Object.hasOwn(NAMED, e.code)) return e.code
  const name = e.key === ' ' ? 'Space' : e.key
  return Object.hasOwn(NAMED, name) ? name : undefined
}

/**
 * The key of a press in the shortcut notation, read as the menu bar reads
 * it: from the character the key types on the layout in use, so Cmd+Q is Q
 * on a French keyboard (where Q is on the A key) and Cmd+Z is Z on a
 * Dvorak one. A press whose character is not the key's own (Option, or
 * Shift on a digit or punctuation key) is read from the character that
 * physical key was seen to type, else from its US position. The keypad's
 * keys are read from the key, whatever the layout. undefined for a press
 * the notation cannot write.
 */
export function pressedKey(
  e: Pick<KeyPress, 'code' | 'key' | 'altKey' | 'shiftKey'>,
): string | undefined {
  const named = namedKey(e)
  if (named !== undefined) return named
  const pad = e.code?.startsWith('Numpad') ? e.code : undefined
  if (pad !== undefined) return /^Numpad([0-9])$/.exec(pad)?.[1] ?? NUMPAD[pad]
  if (!e.altKey) {
    const key = keyOfCharacter(e.key, e.shiftKey)
    if (key !== undefined) return key
  }
  if (!e.code) return e.altKey ? undefined : keyOfCharacter(e.key, false)
  return typed.get(e.code) ?? positionalKey(e.code)
}

/**
 * Learns which character a physical key types from a key press (see
 * `typed`), so a later press with Option or Shift on it is read right.
 */
export function rememberKey(e: Pick<KeyPress, 'code' | 'key' | 'altKey' | 'shiftKey'>): void {
  if (!e.code || e.altKey || e.shiftKey || positionalKey(e.code) === undefined) return
  const key = keyOfCharacter(e.key, false)
  if (key !== undefined) typed.set(e.code, key)
}

/** Forgets what `rememberKey` learned. */
export function forgetKeys(): void {
  typed.clear()
}

/**
 * Whether a key press is this shortcut: the same key with exactly its
 * modifiers. The key is the character the press types, as the menu bar
 * matches it (`pressedKey`). Auto-repeat never matches, unless `repeats`.
 */
export function keyMatches(shortcut: string, e: KeyPress, repeats = false): boolean {
  if (e.repeat && !repeats) return false
  const s = parseShortcut(shortcut)
  if (e.metaKey !== s.mod || e.ctrlKey !== s.ctrl || e.altKey !== s.alt || e.shiftKey !== s.shift)
    return false
  return pressedKey(e) === s.key
}

/** The shortcut as macOS shows it: `\u2303\u2325\u21e7\u2318` then the key. */
export function shortcutLabel(shortcut: string): string {
  const s = parseShortcut(shortcut)
  return (
    (s.ctrl ? '\u2303' : '') +
    (s.alt ? '\u2325' : '') +
    (s.shift ? '\u21e7' : '') +
    (s.mod ? '\u2318' : '') +
    (NAMED[s.key] ?? s.key)
  )
}

/** The shortcut as a native menu accelerator (Tauri): `Alt+CmdOrCtrl+Y`. */
export function shortcutAccelerator(shortcut: string): string {
  const s = parseShortcut(shortcut)
  return [s.ctrl && 'Ctrl', s.shift && 'Shift', s.alt && 'Alt', s.mod && 'CmdOrCtrl', s.key]
    .filter(Boolean)
    .join('+')
}

/** The shortcut in CodeMirror's key notation: `Shift-Mod-x`. */
export function shortcutCodeMirror(shortcut: string): string {
  const s = parseShortcut(shortcut)
  const key = /^[A-Z]$/.test(s.key) ? s.key.toLowerCase() : s.key
  return [s.shift && 'Shift', s.mod && 'Mod', s.ctrl && 'Ctrl', s.alt && 'Alt', key]
    .filter(Boolean)
    .join('-')
}
