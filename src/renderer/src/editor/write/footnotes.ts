// Footnote numbers as the preview gives them: a label counts once it has a
// definition, numbered in the order of its first reference outside code and
// escapes, references in the note's text first and those inside definitions
// after (the preview numbers those as it draws the footnotes at the end). Read
// from the text, since a definition can lie past what the parser has reached.
// What each line adds is kept with the state its reading starts in, so an edit
// reads again only its lines and those after them whose state it changed.
// The same reading finds the labels of link reference definitions, so a
// reference link with no definition can show as the literal text it is.
import type { Text, Transaction } from '@codemirror/state'

export const FOOTNOTE_REF = /^\[\^([^\]\s]+)\]$/
export const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?/

/** Quote marks, list marks and indents before a line's text. */
const CONTAINERS = /^(?:[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)))*[ \t]*/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const INDENTED = /^(?: {4}|\t)/
const REFERENCE = /\[\^([^\]\s]+)\]/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?[^`]\1(?!`)/g

export const footnoteKey = (label: string) => label.toLowerCase()

/** A link label as CommonMark matches it: case folded, its runs of white space as one space. */
export const linkKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase()

const LINK_DEFINITION = /^\[((?:[^[\]\\]|\\.){1,999})\]:/

/** What one line adds: the labels it defines and the references in the text and in definitions. */
interface Found {
  line: number
  /** A link reference definition's label, by `linkKey`. */
  link?: string
  defined: string[]
  inText: string[]
  inDefinitions: string[]
}

interface Index {
  /** The reading's state at the start of each line, by line number; see `reader`. */
  states: Int32Array
  /** The lines that add something, in order. */
  found: Found[]
  numbers: ReadonlyMap<string, number>
  links: ReadonlySet<string>
}

const cache = new WeakMap<Text, Index>()

const BLANK_BEFORE = 1
const IN_CODE = 2
const IN_LIST = 4
const IN_DEFINITION = 8
const TILDE = 16
/** A fence's length is kept from this bit up; none while outside a fence. */
const FENCE_SHIFT = 5

/** Whether the character at `at` is escaped by an odd run of backslashes before it. */
function escaped(text: string, at: number): boolean {
  let slashes = 0
  for (let i = at - 1; i >= 0 && text.charAt(i) === '\\'; i--) slashes++
  return slashes % 2 === 1
}

/** Reads one line in state `state`, returns the state after it and adds what the line adds to `found`. */
function readLine(line: string, number: number, state: number, found: Found[]): number {
  const fence = state >> FENCE_SHIFT
  const marker = FENCE.exec(line)?.[1]
  if (fence > 0) {
    const kind = state & TILDE ? '~' : '`'
    return marker && marker[0] === kind && marker.length >= fence ? state & ~TILDE & 15 : state
  }
  if (line.trim() === '') return (state | BLANK_BEFORE) & ~IN_DEFINITION
  if (marker) {
    return (
      (state & ~BLANK_BEFORE) | (marker[0] === '~' ? TILDE : 0) | (marker.length << FENCE_SHIFT)
    )
  }
  const blankBefore = (state & BLANK_BEFORE) !== 0
  let inList = (state & IN_LIST) !== 0
  if (LIST_ITEM.test(line)) inList = true
  else if (!INDENTED.test(line) && blankBefore) inList = false
  const inCode = INDENTED.test(line) && !inList && (blankBefore || (state & IN_CODE) !== 0)
  let inDefinition = (state & IN_DEFINITION) !== 0
  const next = () =>
    (inCode ? IN_CODE : 0) | (inList ? IN_LIST : 0) | (inDefinition ? IN_DEFINITION : 0)
  if (inCode || !line.includes('[')) return next()
  const prefix = CONTAINERS.exec(line)?.[0].length ?? 0
  const link = LINK_DEFINITION.exec(line.slice(prefix))?.[1]
  if (link?.trim() && !link.startsWith('^') && !escaped(line, prefix)) {
    found.push({ line: number, link: linkKey(link), defined: [], inText: [], inDefinitions: [] })
    return next()
  }
  if (!line.includes('[^')) return next()
  const definition = FOOTNOTE_DEFINITION.exec(line.slice(prefix))
  const adds: Found = { line: number, defined: [], inText: [], inDefinitions: [] }
  let from = prefix
  if (definition && !escaped(line, prefix)) {
    adds.defined.push(footnoteKey(definition[1] as string))
    inDefinition = true
    from = prefix + definition[0].length
  }
  const rest = line.slice(from).replace(CODE_SPAN, (m) => ' '.repeat(m.length))
  for (const match of rest.matchAll(REFERENCE)) {
    if (escaped(line, from + match.index)) continue
    ;(inDefinition ? adds.inDefinitions : adds.inText).push(footnoteKey(match[1] as string))
  }
  if (adds.defined.length + adds.inText.length + adds.inDefinitions.length > 0) found.push(adds)
  return next()
}

/**
 * Reads lines from line `first` (1-based) in state `state`, filling `states`
 * and `found`; stops at the first line past `last` whose state `settled` says
 * is the one it had, and returns that line, or the line past the note.
 */
function readLines(
  doc: Text,
  first: number,
  state: number,
  states: Int32Array,
  found: Found[],
  last: number,
  settled: (line: number, state: number) => boolean,
): number {
  let number = first
  for (const lines = doc.iterLines(first); !lines.next().done; number++) {
    if (number > last && settled(number, state)) return number
    states[number] = state
    state = readLine(lines.value, number, state, found)
  }
  states[number] = state
  return number
}

function numbered(found: readonly Found[]): ReadonlyMap<string, number> {
  const defined = new Set<string>()
  for (const line of found) for (const label of line.defined) defined.add(label)
  const numbers = new Map<string, number>()
  const add = (label: string) => {
    if (defined.has(label) && !numbers.has(label)) numbers.set(label, numbers.size + 1)
  }
  for (const line of found) line.inText.forEach(add)
  for (const line of found) line.inDefinitions.forEach(add)
  return numbers
}

function linked(found: readonly Found[]): ReadonlySet<string> {
  const links = new Set<string>()
  for (const line of found) if (line.link !== undefined) links.add(line.link)
  return links
}

function indexOf(doc: Text): Index {
  const known = cache.get(doc)
  if (known) return known
  const states = new Int32Array(doc.lines + 2)
  const found: Found[] = []
  readLines(doc, 1, BLANK_BEFORE, states, found, Infinity, () => false)
  const index = { states, found, numbers: numbered(found), links: linked(found) }
  cache.set(doc, index)
  return index
}

/** The number of each footnote label, by `footnoteKey`; a label with no definition or reference has none. */
export function footnoteNumbers(doc: Text): ReadonlyMap<string, number> {
  return indexOf(doc).numbers
}

/** The labels of the note's link reference definitions, by `linkKey`. */
export function linkDefinitions(doc: Text): ReadonlySet<string> {
  return indexOf(doc).links
}

const sameLabels = (a: readonly Found[], b: readonly Found[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.link === b[i]!.link &&
      x.defined.join(' ') === b[i]!.defined.join(' ') &&
      x.inText.join(' ') === b[i]!.inText.join(' ') &&
      x.inDefinitions.join(' ') === b[i]!.inDefinitions.join(' '),
  )

/**
 * Keeps the footnote numbers of a step's start for its end when they were
 * read: the lines it changed are read again, and the lines after them until
 * one starts in the state it had.
 */
export function carryFootnotes(tr: Transaction): void {
  const before = tr.docChanged ? cache.get(tr.startState.doc) : undefined
  if (!before || cache.has(tr.newDoc)) return
  const oldDoc = tr.startState.doc
  const doc = tr.newDoc
  let firstA = Infinity
  let firstB = Infinity
  let lastB = 0
  tr.changes.iterChangedRanges((fromA, _toA, fromB, toB) => {
    firstA = Math.min(firstA, oldDoc.lineAt(fromA).number)
    firstB = Math.min(firstB, doc.lineAt(fromB).number)
    lastB = Math.max(lastB, doc.lineAt(toB).number)
  })
  const shift = doc.lines - oldDoc.lines
  const states = new Int32Array(doc.lines + 2)
  states.set(before.states.subarray(0, firstB))
  const kept = before.found.filter((f) => f.line < firstA)
  const found = [...kept]
  const settled = (line: number, state: number) => before.states[line - shift] === state
  const end = readLines(doc, firstB, before.states[firstA]!, states, found, lastB, settled)
  const read = found.slice(kept.length)
  const removed: Found[] = []
  for (const f of before.found) {
    if (f.line < firstA) continue
    const line = f.line + shift
    if (line < end) removed.push(f)
    else found.push(line === f.line ? f : { ...f, line })
  }
  if (end <= doc.lines) states.set(before.states.subarray(end - shift), end)
  const same = sameLabels(read, removed)
  const numbers = same ? before.numbers : numbered(found)
  const links = same ? before.links : linked(found)
  cache.set(doc, { states, found, numbers, links })
}
