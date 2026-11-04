// Footnote numbers as the preview gives them: a label counts once it has a
// definition, numbered in the order of its first reference outside code and
// escapes, references in the note's text first and those inside definitions
// after (the preview numbers those as it draws the footnotes at the end). Read
// from the text, since a definition can lie past what the parser has reached.
import type { Text } from '@codemirror/state'

export const FOOTNOTE_REF = /^\[\^([^\]\s]+)\]$/
export const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?/

/** Quote marks, list marks and indents before a line's text. */
const CONTAINERS = /^(?:[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)))*[ \t]*/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const INDENTED = /^(?: {4}|\t)/
const REFERENCE = /\[\^([^\]\s]+)\]/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?[^`]\1(?!`)/g

const cache = new WeakMap<Text, ReadonlyMap<string, number>>()

export const footnoteKey = (label: string) => label.toLowerCase()

/** Whether the character at `at` is escaped by an odd run of backslashes before it. */
function escaped(text: string, at: number): boolean {
  let slashes = 0
  for (let i = at - 1; i >= 0 && text.charAt(i) === '\\'; i--) slashes++
  return slashes % 2 === 1
}

/** The number of each footnote label, by `footnoteKey`; a label with no definition or reference has none. */
export function footnoteNumbers(doc: Text): ReadonlyMap<string, number> {
  const known = cache.get(doc)
  if (known) return known
  const defined = new Set<string>()
  const inText: string[] = []
  const inDefinitions: string[] = []
  let fence: string | null = null
  let blankBefore = true
  let inCode = false
  let inList = false
  let inDefinition = false
  for (const iter = doc.iterLines(); !iter.next().done;) {
    const line = iter.value
    const blank = line.trim() === ''
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (blank) {
      blankBefore = true
      inDefinition = false
      continue
    }
    if (marker) {
      fence = marker
      blankBefore = false
      continue
    }
    if (LIST_ITEM.test(line)) inList = true
    else if (!INDENTED.test(line) && blankBefore) inList = false
    inCode = INDENTED.test(line) && !inList && (blankBefore || inCode)
    blankBefore = false
    if (inCode) continue
    const prefix = CONTAINERS.exec(line)?.[0].length ?? 0
    const definition = FOOTNOTE_DEFINITION.exec(line.slice(prefix))
    let from = prefix
    if (definition && !escaped(line, prefix)) {
      defined.add(footnoteKey(definition[1] as string))
      inDefinition = true
      from = prefix + definition[0].length
    }
    const rest = line.slice(from).replace(CODE_SPAN, (m) => ' '.repeat(m.length))
    for (const match of rest.matchAll(REFERENCE)) {
      if (escaped(line, from + match.index)) continue
      ;(inDefinition ? inDefinitions : inText).push(footnoteKey(match[1] as string))
    }
  }
  const numbers = new Map<string, number>()
  for (const label of [...inText, ...inDefinitions])
    if (defined.has(label) && !numbers.has(label)) numbers.set(label, numbers.size + 1)
  cache.set(doc, numbers)
  return numbers
}
