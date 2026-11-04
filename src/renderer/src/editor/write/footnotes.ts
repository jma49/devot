// Footnote numbers as the preview gives them: a label counts once it has a
// definition, numbered in the order of its first reference outside code. Read
// from the text, since a definition can lie past what the parser has reached.
import type { Text } from '@codemirror/state'

export const FOOTNOTE_REF = /^\[\^([^\]\s]+)\]$/
export const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?/

const DEFINITION_LINE = /^ {0,3}\[\^([^\]\s]+)\]:/
const REFERENCE = /\[\^([^\]\s]+)\](?!:)/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?[^`]\1(?!`)/g

const cache = new WeakMap<Text, ReadonlyMap<string, number>>()

export const footnoteKey = (label: string) => label.toLowerCase()

/** The number of each footnote label, by `footnoteKey`; a label with no definition or reference has none. */
export function footnoteNumbers(doc: Text): ReadonlyMap<string, number> {
  const known = cache.get(doc)
  if (known) return known
  const defined = new Set<string>()
  const references: string[] = []
  let fence: string | null = null
  for (const iter = doc.iterLines(); !iter.next().done;) {
    const line = iter.value
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    const definition = DEFINITION_LINE.exec(line)
    if (definition) defined.add(footnoteKey(definition[1] as string))
    for (const match of line.replace(CODE_SPAN, (m) => ' '.repeat(m.length)).matchAll(REFERENCE))
      references.push(footnoteKey(match[1] as string))
  }
  const numbers = new Map<string, number>()
  for (const label of references)
    if (defined.has(label) && !numbers.has(label)) numbers.set(label, numbers.size + 1)
  cache.set(doc, numbers)
  return numbers
}
