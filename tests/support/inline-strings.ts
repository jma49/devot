import { parseSync } from 'vite'
import { en } from '../../src/renderer/src/i18n/en'

/** Attributes a person reads or hears, which take their text from the i18n catalog. */
export const SPOKEN_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'] as const

// Text with no letter (a separator, a symbol, a number) says nothing to translate.
const WORDS = /\p{L}/u
// A component prop such as `title="usage.list"` names a catalog key, which the component looks up.
const KEYS: ReadonlySet<string> = new Set(Object.keys(en))

type Node = { type: string; start: number; [key: string]: unknown }

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof (node as Node).type === 'string') visit(node as Node)
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walk(value, visit)
  }
}

function literalText(node: Node | null | undefined): string | undefined {
  if (!node) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) {
    return (node.quasis as { value: { cooked: string } }[]).map((q) => q.value.cooked).join('')
  }
  if (node.type === 'JSXExpressionContainer') return literalText(node.expression as Node)
  return undefined
}

/** User-facing words written straight into JSX: text between tags, or a spoken attribute's literal value. */
export function inlineUiStrings(file: string, source: string): { line: number; text: string }[] {
  const { program, errors } = parseSync(file, source)
  if (errors.length > 0) throw new Error(`E_TEST_PARSE ${file}`)
  const found: { line: number; text: string }[] = []
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length
  walk(program, (node) => {
    if (node.type === 'JSXText') {
      const text = String(node.value).trim()
      if (WORDS.test(text)) found.push({ line: lineOf(node.start), text })
    } else if (node.type === 'JSXAttribute') {
      const name = (node.name as Node & { name?: unknown }).name
      if (!SPOKEN_ATTRIBUTES.includes(name as (typeof SPOKEN_ATTRIBUTES)[number])) return
      const text = literalText(node.value as Node | null)
      if (text !== undefined && WORDS.test(text) && !KEYS.has(text)) {
        found.push({ line: lineOf(node.start), text: `${String(name)}="${text}"` })
      }
    }
  })
  return found
}
