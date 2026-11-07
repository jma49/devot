// Link reference and footnote definitions reach across a whole note, while the live preview
// renders it in pieces (blocks.ts). Each piece is parsed knowing the labels the note defines
// (seeded into the Markdown parser), then gets the definitions it uses from other pieces as tree
// nodes, so its links and footnote calls come out as the whole note's would.
import type { Definition, FootnoteDefinition, Root as MdastRoot, RootContent } from 'mdast'
import type { Processor } from 'unified'

/** A label as the parser compares it; a footnote's starts with NUL, which no link label holds. */
export type Label = string

const NOTE = '\u0000'

const BRACKETS = /\[((?:[^[\]\\]|\\[\s\S]){1,999})\]/g
const DEFINITION = /^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])[ \t])*\[((?:[^\]\\\n]|\\[\s\S]){1,999})\]:/gm

/** As micromark's `normalizeIdentifier`, which the parser matches labels with. */
export function normalizeLabel(label: string): string {
  return label
    .replace(/[\t\n\r ]+/g, ' ')
    .replace(/^ | $/g, '')
    .toLowerCase()
    .toUpperCase()
}

// A footnote label has no white space; `[^a b]` is a link's.
const labelOf = (raw: string): Label =>
  raw.startsWith('^') && !/\s/.test(raw) ? NOTE + normalizeLabel(raw.slice(1)) : normalizeLabel(raw)

export const isNoteLabel = (label: Label) => label.startsWith(NOTE)

/** Every label `text` may refer to or define, and more: each bracketed run in it. */
export function labelsIn(text: string): Label[] {
  const out = new Set<Label>()
  for (const match of text.matchAll(BRACKETS)) out.add(labelOf(match[1]!))
  return [...out]
}

/** The labels `text` looks to define, read from its lines alone; the parse has the last word. */
export function likelyDefined(text: string): Label[] {
  const out = new Set<Label>()
  for (const match of text.matchAll(DEFINITION)) out.add(labelOf(match[1]!))
  return [...out]
}

export type LinkDefinition = Pick<Definition, 'identifier' | 'url'> & {
  label: string | null
  title: string | null
}
export type NoteDefinition = Pick<FootnoteDefinition, 'identifier'> & { label: string | null }

export interface Definitions {
  links: Map<Label, LinkDefinition>
  notes: Map<Label, NoteDefinition>
}

/** The definitions in a parsed piece, the first of each label. */
export function definitionsIn(tree: MdastRoot): Definitions {
  const found: Definitions = { links: new Map(), notes: new Map() }
  const walk = (nodes: readonly RootContent[]) => {
    for (const node of nodes) {
      if (node.type === 'definition') {
        const label = normalizeLabel(node.label ?? node.identifier)
        if (!found.links.has(label)) {
          const { identifier, url } = node
          found.links.set(label, {
            identifier,
            url,
            label: node.label ?? null,
            title: node.title ?? null,
          })
        }
      } else if (node.type === 'footnoteDefinition') {
        const label = NOTE + normalizeLabel(node.label ?? node.identifier)
        if (!found.notes.has(label)) {
          found.notes.set(label, { identifier: node.identifier, label: node.label ?? null })
        }
      }
      if ('children' in node) walk(node.children)
    }
  }
  walk(tree.children)
  return found
}

interface SeedParser {
  defined: string[]
  gfmFootnotes?: string[]
}

let seeds: readonly Label[] | undefined

// A document construct is tried at the start of every line, the first before any inline
// content is read; the parser then takes the seeded labels as defined. It never matches.
const seedConstruct = {
  tokenize(this: { parser: SeedParser }, _effects: unknown, _ok: unknown, nok: unknown) {
    if (seeds) {
      for (const label of seeds) {
        if (isNoteLabel(label)) (this.parser.gfmFootnotes ??= []).push(label.slice(1))
        else this.parser.defined.push(label)
      }
      seeds = undefined
    }
    return nok
  },
}

/** A remark plugin: `parseSeeded` hands the parser labels defined elsewhere in the note. */
export function remarkSeededLabels(this: Processor): void {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  ;(data.micromarkExtensions ??= []).push({ document: { null: [seedConstruct] } })
}

export function parseSeeded(
  parser: { parse(text: string): unknown },
  text: string,
  labels: readonly Label[],
): MdastRoot {
  seeds = labels.length > 0 ? labels : undefined
  try {
    return parser.parse(text) as MdastRoot
  } finally {
    seeds = undefined
  }
}
