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
import { normalizeLabel } from '../../../../core/preview/definitions'

export const FOOTNOTE_REF = /^\[\^([^\]\s]+)\]$/
export const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?/

/** Quote marks, list marks and indents before a line's text. */
const CONTAINERS = /^(?:[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)))*[ \t]*/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const INDENTED = /^(?: {4}|\t)/
const REFERENCE = /\[\^([^\]\s]+)\]/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?[^`]\1(?!`)/g
/** Among a line's containers, the mark of a list item that starts on the line. */
const ITEM_MARK = /[-*+]|\d[.)]/
const HEADING = /^#{1,6}(?:[ \t]|$)/
const RULE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const UNDERLINE = /^(?:=+|-+)[ \t]*$/
const LINK_LABEL = /^\[((?:[^[\]\\]|\\.){1,999})\]:/
const PUNCTUATION = /[!-/:-@[-`{-~]/

export const footnoteKey = (label: string) => label.toLowerCase()

/** What one line adds: the labels it defines and the references in the text and in definitions. */
interface Found {
  line: number
  /** The label of a link reference definition that starts on the line, by `normalizeLabel`. */
  link?: string
  /** The definition's destination or the end of its title is still to come, on a line that `closesLink`. */
  linkOpen?: boolean
  /** The line completes the link definition open before it. */
  closesLink?: boolean
  defined: string[]
  inText: string[]
  inDefinitions: string[]
}

interface Index {
  /** The reading's state at the start of each line, by line number, packed from a `Reading`. */
  states: Int32Array
  /** The lines that add something, in order. */
  found: Found[]
  numbers: ReadonlyMap<string, number>
  links: ReadonlySet<string>
}

const cache = new WeakMap<Text, Index>()

// The bits of a packed `Reading`, as the cache keeps it.
const BLANK_BEFORE = 1
const DEFINITION_PENDING = 2
const IN_LIST = 4
const IN_DEFINITION = 8
const TILDE = 16
const IN_PARAGRAPH = 32
const QUOTE_SHIFT = 6
const LINK_SHIFT = 9
const FENCE_SHIFT = 12

// A link definition's stage at the end of a line: as CommonMark reads one, its destination may
// come on the line after its label, and its title on the line after that, running over lines.
/** Complete, or no definition open. */
const COMPLETE = 0
/** Complete, and its next line may be its title. */
const MAY_TAKE_TITLE = 1
const NEEDS_DESTINATION = 2
/** In a title, from here by the title's mark in `TITLE_OPENS`. */
const IN_TITLE = 3
const NO_DEFINITION = -1
const TITLE_OPENS = ['"', "'", '(']
const TITLE_CLOSES = ['"', "'", ')']

/** The paragraph or link definition open at a line's end. */
interface Open {
  /** The line is paragraph text, which the next continues unless it starts a block. */
  paragraph: boolean
  /** The quote depth of the open paragraph or link definition, at most 7. */
  quotes: number
  /** The open link definition's stage. */
  link: number
}

/** The reading's state at the start of a line. */
interface Reading extends Open {
  blankBefore: boolean
  list: boolean
  /** A footnote definition is open, or pending after a blank line, where an indented line continues it. */
  definition: 'none' | 'open' | 'pending'
  fence: { mark: string; length: number } | null
}

const CLOSED: Open = { paragraph: false, quotes: 0, link: COMPLETE }
const START: Reading = {
  ...CLOSED,
  blankBefore: true,
  list: false,
  definition: 'none',
  fence: null,
}

function pack(r: Reading): number {
  return (
    (r.blankBefore ? BLANK_BEFORE : 0) |
    (r.definition === 'pending' ? DEFINITION_PENDING : 0) |
    (r.list ? IN_LIST : 0) |
    (r.definition === 'open' ? IN_DEFINITION : 0) |
    (r.fence?.mark === '~' ? TILDE : 0) |
    (r.paragraph ? IN_PARAGRAPH : 0) |
    (r.quotes << QUOTE_SHIFT) |
    (r.link << LINK_SHIFT) |
    ((r.fence?.length ?? 0) << FENCE_SHIFT)
  )
}

function unpack(state: number): Reading {
  const fence = state >> FENCE_SHIFT
  return {
    blankBefore: (state & BLANK_BEFORE) !== 0,
    list: (state & IN_LIST) !== 0,
    definition: state & IN_DEFINITION ? 'open' : state & DEFINITION_PENDING ? 'pending' : 'none',
    fence: fence > 0 ? { mark: state & TILDE ? '~' : '`', length: fence } : null,
    paragraph: (state & IN_PARAGRAPH) !== 0,
    quotes: (state >> QUOTE_SHIFT) & 7,
    link: (state >> LINK_SHIFT) & 7,
  }
}

/** Whether the character at `at` is escaped by an odd run of backslashes before it. */
function escaped(text: string, at: number): boolean {
  let slashes = 0
  for (let i = at - 1; i >= 0 && text.charAt(i) === '\\'; i--) slashes++
  return slashes % 2 === 1
}

function spaceEnd(text: string, at: number): number {
  let end = at
  while (text.charAt(end) === ' ' || text.charAt(end) === '\t') end++
  return end
}

/** The end of the link destination at `at`, or -1 when none is there. */
function destinationEnd(text: string, at: number): number {
  if (text.charAt(at) === '<') {
    for (let i = at + 1; i < text.length; i++) {
      const c = text.charAt(i)
      if (c === '>') return i + 1
      if (c === '<') return -1
      if (c === '\\') i++
    }
    return -1
  }
  let depth = 0
  let i = at
  for (; i < text.length; i++) {
    const c = text.charAt(i)
    const code = text.charCodeAt(i)
    if (code <= 32 || code === 127) break
    if (c === '\\' && PUNCTUATION.test(text.charAt(i + 1))) i++
    else if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) return -1
      depth--
    }
  }
  return i > at && depth === 0 ? i : -1
}

/** The end of a title closed by `close` from `at`, past its closing mark; -1 when it runs on past the line, -2 when it is none. */
function titleEnd(text: string, at: number, close: string): number {
  for (let i = at; i < text.length; i++) {
    const c = text.charAt(i)
    if (c === close) return i + 1
    if (c === '(' && close === ')') return -2
    if (c === '\\') i++
  }
  return -1
}

/** Reads a link definition on from `at` in a line's `text`, its stage there being `stage`: its stage at the line's end, or `NO_DEFINITION`. */
function readDefinition(text: string, at: number, stage: number): number {
  let i = spaceEnd(text, at)
  let title = stage - IN_TITLE
  if (stage === NEEDS_DESTINATION) {
    if (i === text.length) return NEEDS_DESTINATION
    const end = destinationEnd(text, i)
    if (end < 0) return NO_DEFINITION
    i = spaceEnd(text, end)
    if (i === text.length) return MAY_TAKE_TITLE
    if (i === end) return NO_DEFINITION
  }
  if (stage < IN_TITLE) {
    title = TITLE_OPENS.indexOf(text.charAt(i))
    if (title < 0) return NO_DEFINITION
    i++
  }
  const end = titleEnd(text, i, TITLE_CLOSES[title] as string)
  if (end === -1) return IN_TITLE + title
  return end >= 0 && spaceEnd(text, end) === text.length ? COMPLETE : NO_DEFINITION
}

/** The link definition that starts a line's `text`: its label, by `normalizeLabel`, and its stage at the line's end. */
function definitionOn(text: string): { label: string; stage: number } | null {
  const match = FOOTNOTE_DEFINITION.test(text) ? null : LINK_LABEL.exec(text)
  const label = match ? normalizeLabel(match[1] as string) : ''
  if (!match || label === '') return null
  const stage = readDefinition(text, match[0].length, NEEDS_DESTINATION)
  return stage === NO_DEFINITION ? null : { label, stage }
}

/**
 * What a line's `text`, after its `containers`, does to the paragraph or link definition `open`
 * before it: what is open after it. A link definition's line notes it in `adds`. A line that
 * continues a footnote definition without its indent is `lazy`.
 */
function readBlock(text: string, containers: string, open: Open, adds: Found, lazy: boolean): Open {
  if (text === '' || HEADING.test(text) || RULE.test(text)) return CLOSED
  const quotes = Math.min(containers.split('>').length - 1, 7)
  const { link: stage, quotes: outer } = open
  // A line that opens a quote or a list item starts anew; any other continues what is open, lazily or not.
  const continues =
    (open.paragraph || stage !== COMPLETE) && quotes <= outer && !ITEM_MARK.test(containers)
  if (continues) {
    const paragraph = { paragraph: true, quotes: outer, link: COMPLETE }
    // A lazy line is never a heading's underline, so it stays paragraph text.
    const underlines = !lazy && quotes === outer && stage !== MAY_TAKE_TITLE
    if (underlines && UNDERLINE.test(text)) return CLOSED
    if (stage === COMPLETE) return paragraph
    const after = readDefinition(text, 0, stage)
    if (after === COMPLETE || after === MAY_TAKE_TITLE) adds.closesLink = true
    if (after === COMPLETE) return CLOSED
    if (after !== NO_DEFINITION) return { paragraph: false, quotes: outer, link: after }
    if (stage !== MAY_TAKE_TITLE) return paragraph
  }
  const definition = definitionOn(text)
  if (definition) {
    adds.link = definition.label
    if (definition.stage > MAY_TAKE_TITLE) adds.linkOpen = true
    if (definition.stage === COMPLETE) return CLOSED
    return { paragraph: false, quotes, link: definition.stage }
  }
  const note = FOOTNOTE_DEFINITION.exec(text)
  if (note && text.slice(note[0].length).trim() === '') return CLOSED
  return { paragraph: true, quotes, link: COMPLETE }
}

/** Reads one line in `state`, returns the state after it and adds what the line adds to `found`. */
function next(state: Reading, line: string, number: number, found: Found[]): Reading {
  const marker = FENCE.exec(line)?.[1]
  if (state.fence) {
    const { mark, length } = state.fence
    return marker && marker[0] === mark && marker.length >= length
      ? { ...state, fence: null }
      : state
  }
  if (line.trim() === '') {
    const definition = state.definition === 'none' ? 'none' : 'pending'
    return { ...state, ...CLOSED, blankBefore: true, definition }
  }
  const indented = INDENTED.test(line)
  const lead = line.trimStart()
  const startsBlock =
    !indented &&
    (marker !== undefined ||
      HEADING.test(lead) ||
      RULE.test(lead) ||
      lead.startsWith('>') ||
      LIST_ITEM.test(line))
  let list = state.list
  if (LIST_ITEM.test(line) && !RULE.test(lead)) list = true
  else if (!indented && (state.blankBefore || (startsBlock && line === lead))) list = false
  let definition = state.definition
  if (definition !== 'none' && !indented) {
    // Only paragraph text continues a footnote definition lazily, without its indent.
    if (definition === 'pending' || startsBlock || !state.paragraph) definition = 'none'
  } else if (definition === 'pending') definition = 'open'
  const body = definition !== 'none' && indented ? line.replace(INDENTED, '') : line
  const opened = state.paragraph || state.link !== COMPLETE
  const after: Reading = { ...CLOSED, blankBefore: false, list, definition, fence: null }
  if (INDENTED.test(body) && !list && !opened) return after
  if (marker) return { ...after, fence: { mark: marker[0] as string, length: marker.length } }
  const prefix = CONTAINERS.exec(line)?.[0].length ?? 0
  const text = line.slice(prefix)
  const adds: Found = { line: number, defined: [], inText: [], inDefinitions: [] }
  const lazy = definition === 'open' && !indented
  const open = readBlock(text, line.slice(0, prefix), state, adds, lazy)
  // A line that completes a link definition holds no references; one of a definition still open may yet be text.
  const defines = adds.closesLink === true || (adds.link !== undefined && !adds.linkOpen)
  if (!defines && line.includes('[^')) {
    const note = FOOTNOTE_DEFINITION.exec(text)
    let from = prefix
    if (note && !escaped(line, prefix)) {
      adds.defined.push(footnoteKey(note[1] as string))
      after.definition = 'open'
      from = prefix + note[0].length
    }
    const rest = line.slice(from).replace(CODE_SPAN, (m) => ' '.repeat(m.length))
    for (const match of rest.matchAll(REFERENCE)) {
      if (escaped(line, from + match.index)) continue
      ;(after.definition !== 'none' ? adds.inDefinitions : adds.inText).push(
        footnoteKey(match[1] as string),
      )
    }
  }
  const labels = adds.defined.length + adds.inText.length + adds.inDefinitions.length
  if (labels > 0 || adds.link !== undefined || adds.closesLink) found.push(adds)
  return { ...after, ...open }
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
    state = pack(next(unpack(state), lines.value, number, found))
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
  let open: string | undefined
  for (const line of found) {
    if (line.closesLink && open !== undefined) links.add(open)
    if (line.link === undefined) continue
    open = line.linkOpen ? line.link : undefined
    if (!line.linkOpen) links.add(line.link)
  }
  return links
}

function indexOf(doc: Text): Index {
  const known = cache.get(doc)
  if (known) return known
  const states = new Int32Array(doc.lines + 2)
  const found: Found[] = []
  readLines(doc, 1, pack(START), states, found, Infinity, () => false)
  const index = { states, found, numbers: numbered(found), links: linked(found) }
  cache.set(doc, index)
  return index
}

/** The number of each footnote label, by `footnoteKey`; a label with no definition or reference has none. */
export function footnoteNumbers(doc: Text): ReadonlyMap<string, number> {
  return indexOf(doc).numbers
}

/** The labels of the note's link reference definitions, by `normalizeLabel`, as the preview matches them. */
export function linkDefinitions(doc: Text): ReadonlySet<string> {
  return indexOf(doc).links
}

const sameLabels = (a: readonly Found[], b: readonly Found[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.link === b[i]!.link &&
      x.linkOpen === b[i]!.linkOpen &&
      x.closesLink === b[i]!.closesLink &&
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
