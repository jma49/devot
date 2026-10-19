// Sort keys for a hand-made order (fractional indexing). Keys sort by plain string comparison (code units, the same as SQLite's BINARY collation and Rust's byte
// order: keys are ASCII). There is always a key between two others, so moving an item rewrites only that item's key.
//
// Format: an integer part, then an optional fraction, both in base 62 (0-9, A-Z, a-z). The integer part's first character gives its length: 'a' to 'z' are 2 to 27
// characters (positive), 'Z' to 'A' are 2 to 27 (negative). The fraction never ends in '0', so every number has one spelling. The first key is 'a0'.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length
const SMALLEST = `A${'0'.repeat(26)}`

export const MAX_SORT_KEY_LENGTH = 1024

const digit = (c: string | undefined): number => (c === undefined ? -1 : DIGITS.indexOf(c))

function integerLength(head: string | undefined): number {
  if (head !== undefined && head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2
  if (head !== undefined && head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2
  return 0
}

export function isSortKey(key: string): boolean {
  if (key.length > MAX_SORT_KEY_LENGTH) return false
  const length = integerLength(key[0])
  if (length === 0 || key.length < length) return false
  if (key === SMALLEST) return false
  for (let i = 1; i < key.length; i += 1) if (digit(key[i]) < 0) return false
  return key.length === length || !key.endsWith('0')
}

function check(key: string | null): void {
  if (key !== null && !isSortKey(key)) throw new Error('E_SORT_KEY_INVALID')
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Keep the common prefix, padding `a` with zeros.
    let n = 0
    while ((a[n] ?? '0') === b[n]) n += 1
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const low = a ? digit(a[0]) : 0
  const high = b !== null ? digit(b[0]) : BASE
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!
  // Adjacent digits: a shorter `b` is between them already, or go one deeper.
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[low]! + midpoint(a.slice(1), null)
}

function increment(integer: string): string | null {
  const head = integer[0]!
  const digits = [...integer.slice(1)]
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const d = digit(digits[i]) + 1
    if (d < BASE) {
      digits[i] = DIGITS[d]!
      return head + digits.join('')
    }
    digits[i] = '0'
  }
  if (head === 'Z') return 'a0'
  if (head === 'z') return null
  const next = String.fromCharCode(head.charCodeAt(0) + 1)
  if (next > 'a') digits.push('0')
  else digits.pop()
  return next + digits.join('')
}

function decrement(integer: string): string | null {
  const head = integer[0]!
  const digits = [...integer.slice(1)]
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const d = digit(digits[i]) - 1
    if (d >= 0) {
      digits[i] = DIGITS[d]!
      return head + digits.join('')
    }
    digits[i] = 'z'
  }
  if (head === 'a') return 'Zz'
  if (head === 'A') return null
  const next = String.fromCharCode(head.charCodeAt(0) - 1)
  if (next < 'Z') digits.push('z')
  else digits.pop()
  return next + digits.join('')
}

/** Null stands for the start or the end of the list. Throws E_SORT_KEY_INVALID for a malformed key and E_SORT_KEY_ORDER unless `a` < `b`. */
export function keyBetween(a: string | null, b: string | null): string {
  check(a)
  check(b)
  if (a !== null && b !== null && a >= b) throw new Error('E_SORT_KEY_ORDER')
  if (a === null && b === null) return 'a0'
  if (a === null) {
    const integer = b!.slice(0, integerLength(b![0]))
    const fraction = b!.slice(integer.length)
    if (integer === SMALLEST) return integer + midpoint('', fraction)
    if (integer < b!) return integer
    // Never null: only the smallest integer has nothing below it.
    const less = decrement(integer)!
    return less === SMALLEST ? less + midpoint('', null) : less
  }
  const integer = a.slice(0, integerLength(a[0]))
  const fraction = a.slice(integer.length)
  if (b === null) {
    const more = increment(integer)
    return more === null ? integer + midpoint(fraction, null) : more
  }
  const integerB = b.slice(0, integerLength(b[0]))
  if (integer === integerB) return integer + midpoint(fraction, b.slice(integer.length))
  const more = increment(integer)
  if (more !== null && more < b) return more
  return integer + midpoint(fraction, null)
}

export function sequentialKeys(n: number): string[] {
  const keys: string[] = []
  let previous: string | null = null
  for (let i = 0; i < n; i += 1) {
    previous = keyBetween(previous, null)
    keys.push(previous)
  }
  return keys
}

/** Plain string order, never locale-aware. */
export const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
