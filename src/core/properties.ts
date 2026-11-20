// Reading and writing typed note properties (propertyTypes.ts) in front matter, for the table
// layout. Writing changes only the key's own lines.
import { Document, isMap, isScalar, isSeq, parseDocument, type Pair } from 'yaml'
import { frontMatterHead } from './frontMatterHead'
import {
  MAX_PROPERTY_ITEMS,
  MAX_PROPERTY_TEXT_CHARS,
  isFieldKey,
  validPropertyKey,
  type Properties,
  type PropertyValue,
} from './propertyTypes'
import { charCount } from './text'

export {
  propertyType,
  type Properties,
  type PropertyType,
  type PropertyValue,
} from './propertyTypes'

const scalarValue = (value: unknown): PropertyValue | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  return undefined
}

function valueOf(node: unknown): PropertyValue | undefined {
  if (node === null || node === undefined) return null
  if (isScalar(node)) return scalarValue(node.value)
  if (!isSeq(node)) return undefined
  const items: string[] = []
  for (const item of node.items) {
    if (!isScalar(item)) return undefined
    if (item.value === null) continue
    items.push(String(item.value))
  }
  return items
}

/** The YAML between a front matter head's fences, with the offsets of where it starts and ends in the head. */
function innerOf(head: string): { start: number; end: number; yaml: string } {
  const start = head.indexOf('\n') + 1
  const end = head.lastIndexOf('\n') + 1
  return end > start
    ? { start, end, yaml: head.slice(start, end) }
    : { start, end: start, yaml: '' }
}

function parsedMap(yaml: string) {
  const doc = parseDocument(yaml, { schema: 'core', uniqueKeys: false })
  if (doc.errors.length > 0) return undefined
  if (doc.contents === null) return { doc, pairs: [] as Pair[] }
  return isMap(doc.contents) ? { doc, pairs: doc.contents.items as Pair[] } : undefined
}

const keyOf = (pair: Pair): string | undefined => {
  const key = isScalar(pair.key) ? pair.key.value : undefined
  return typeof key === 'string' || typeof key === 'number' ? String(key) : undefined
}

/**
 * The properties of a note whose Markdown starts with `markdown` (the whole note or its front matter
 * head): every key other than the note's fields whose value is a scalar or a list of scalars, the
 * last of a repeated key counting. Dates stay text (`2026-11-20`); empty when the front matter is
 * missing or not a valid YAML map.
 */
export function readProperties(markdown: string): Properties {
  const head = frontMatterHead(markdown)
  if (head === null) return {}
  const parsed = parsedMap(innerOf(head).yaml)
  if (!parsed) return {}
  const found: Record<string, PropertyValue> = {}
  for (const pair of parsed.pairs) {
    const key = keyOf(pair)
    if (key === undefined || isFieldKey(key)) continue
    const value = valueOf(pair.value)
    if (value === undefined) delete found[key]
    else found[key] = value
  }
  return found
}

function checkValue(value: PropertyValue): void {
  const texts = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  if (Array.isArray(value) && value.length > MAX_PROPERTY_ITEMS) {
    throw new Error('E_PROPERTY_VALUE_TOO_LONG')
  }
  for (const text of texts) {
    if (charCount(text) > MAX_PROPERTY_TEXT_CHARS) throw new Error('E_PROPERTY_VALUE_TOO_LONG')
    if (/[\r\n\u2028\u2029]/.test(text)) throw new Error('E_PROPERTY_VALUE_INVALID')
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('E_PROPERTY_VALUE_INVALID')
  }
}

/** `key: value` as YAML lines, ending in a line feed; a null value is the key alone. */
function entryLines(key: string, value: PropertyValue): string {
  const doc = new Document({ [key]: value === null ? null : value }, { schema: 'core' })
  const text = doc.toString({ lineWidth: 0, nullStr: '', indentSeq: true })
  return text.replace(/:[ \t]+\n$/, ':\n')
}

/**
 * `markdown` with property `key` set to `value`: its lines replaced in place (the last of a repeated
 * key), else added at the end of the front matter, which is made when the note has none. Front
 * matter that is not a valid YAML map is refused (E_FRONT_MATTER_INVALID), so an edit never breaks
 * what the note holds; a comment on the key's own line goes with its old value.
 */
export function withProperty(markdown: string, key: string, value: PropertyValue): string {
  if (!validPropertyKey(key)) throw new Error('E_PROPERTY_KEY_INVALID')
  checkValue(value)
  const entry = entryLines(key, value)
  const head = frontMatterHead(markdown)
  if (head === null) return `---\n${entry}---\n${markdown}`
  const inner = innerOf(head)
  const parsed = parsedMap(inner.yaml)
  if (!parsed) throw new Error('E_FRONT_MATTER_INVALID')
  const pair = parsed.pairs.findLast((p) => keyOf(p) === key)
  const yaml = inner.yaml
  let next: string
  if (!pair) {
    const at = /(?<=^|\n)(?:[ \t]*\n)*$/.exec(yaml)?.index ?? yaml.length
    next = yaml.slice(0, at) + entry + yaml.slice(at)
  } else {
    const keyStart = (pair.key as { range?: [number, number, number] }).range?.[0] ?? 0
    const valueNode = pair.value as { range?: [number, number, number] } | null
    const keyEnd = (pair.key as { range?: [number, number, number] }).range?.[2] ?? keyStart
    const last = valueNode?.range?.[1] ?? keyEnd
    const lineStart = yaml.lastIndexOf('\n', keyStart - 1) + 1
    const lineEnd = yaml.indexOf('\n', Math.max(last - 1, keyStart))
    const end = lineEnd < 0 ? yaml.length : lineEnd + 1
    next = yaml.slice(0, lineStart) + entry + yaml.slice(end)
  }
  if (!parsedMap(next)) throw new Error('E_FRONT_MATTER_INVALID')
  return head.slice(0, inner.start) + next + head.slice(inner.end) + markdown.slice(head.length)
}
