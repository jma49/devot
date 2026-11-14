// A gallery card's page thumbnail: the start of a note's body, rendered by the
// preview's parser and sanitizer with the light built-in renderers only. A card
// draws nothing that needs a library, the network or the page's layout engine:
// diagrams, math, frames and every image but an attachment become a quiet placeholder.
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { BUILTIN_RENDERERS } from './builtins'
import { renderBody } from './index'
import { attachmentId } from '../images'
import {
  PREVIEW_API_VERSION,
  type AlertKind,
  type PreviewLabels,
  type PreviewRenderer,
} from './registry'

export {
  CARD_EXCERPT_BLOCKS,
  CARD_EXCERPT_CHARS,
  CARD_EXCERPT_LINES,
  cardExcerpt,
} from './cardExcerpt'

export interface CardLabels {
  diagram: string
  math: string
  embed: string
  image: string
  alerts: Record<AlertKind, string>
}

type Placeholder = 'diagram' | 'math' | 'embed' | 'image'

const DIAGRAMS = ['mermaid', 'plantuml', 'puml', 'markmap'].map((l) => `language-${l}`)
/** The built-ins a card runs: none loads a library or draws on the page. */
const CARD_RENDERERS = new Set([
  'devot.alerts',
  'devot.tasks',
  'devot.emoji',
  'devot.swatches',
  'devot.images',
  'devot.note-embeds',
  'devot.links',
])
/** Offsets into the note and ids mean nothing on a card, and a page of cards must not repeat an id. */
/** Attributes that make the page fetch something; only an `img` with an attachment `src` keeps one. */
const LOADS = ['src', 'srcSet', 'poster', 'longDesc']
const MEDIA = new Set(['picture', 'source', 'video', 'audio'])
const DROPPED = ['id', 'ariaDescribedBy', 'dataTaskAt', 'dataImageFrom', 'dataImageTo']

const classesOf = (node: Element): string[] =>
  ((node.properties['className'] as string[] | undefined) ?? []).map(String)

function placeholder(kind: Placeholder, label: string, inline: boolean): Element {
  return {
    type: 'element',
    tagName: inline ? 'span' : 'div',
    properties: { className: ['card-placeholder'], dataPlaceholder: kind },
    children: [{ type: 'text', value: label }],
  }
}

function placeholderFor(node: Element): { kind: Placeholder; inline: boolean } | undefined {
  if (node.tagName === 'pre') {
    const code = node.children.find((c): c is Element => c.type === 'element')
    const names = code ? classesOf(code) : []
    if (names.includes('language-math')) return { kind: 'math', inline: false }
    if (names.some((name) => DIAGRAMS.includes(name))) return { kind: 'diagram', inline: false }
    return undefined
  }
  if (node.tagName === 'code' && classesOf(node).includes('language-math')) {
    return { kind: 'math', inline: true }
  }
  if (node.tagName === 'iframe') return { kind: 'embed', inline: false }
  if (node.tagName === 'img') {
    const src = node.properties['src']
    // An embedded note is a link on a card (noteEmbeds.ts).
    if (typeof src === 'string' && src.startsWith('devot://note/')) return undefined
    const attached = typeof src === 'string' && attachmentId(src) !== null
    const others = LOADS.some((key) => key !== 'src' && node.properties[key] !== undefined)
    return attached && !others ? undefined : { kind: 'image', inline: false }
  }
  if (MEDIA.has(node.tagName) || LOADS.some((key) => node.properties[key] !== undefined)) {
    return { kind: 'image', inline: false }
  }
  return undefined
}

function cardPlaceholders(labels: CardLabels): PreviewRenderer {
  const swap = (parent: Root | Element) => {
    parent.children = parent.children.map((child) => {
      if (child.type !== 'element') return child
      const found = placeholderFor(child)
      if (!found) {
        swap(child)
        return child
      }
      return placeholder(found.kind, labels[found.kind], found.inline)
    }) as typeof parent.children
  }
  return { id: 'devot.card-placeholders', apiVersion: PREVIEW_API_VERSION, transform: swap }
}

function readOnly(node: Root | RootContent): void {
  if (node.type === 'element') {
    for (const key of DROPPED) delete node.properties[key]
    if (node.tagName === 'input') node.properties['disabled'] = true
  }
  if ('children' in node) (node.children as (RootContent | ElementContent)[]).forEach(readOnly)
}

function previewLabels(labels: CardLabels): PreviewLabels {
  return {
    alerts: labels.alerts,
    embedFrom: labels.embed,
    embedLoad: '',
    videoTitle: labels.embed,
    untitled: '',
    missingNote: '',
    codeLines: '',
    codeLine: '',
    codeRef: '',
    codeSource: '',
  }
}

/** `markdown` (a `cardExcerpt`) as a card draws it: sanitized, read-only, with no ids. */
export async function renderCardPreview(markdown: string, labels: CardLabels): Promise<Root> {
  const renderers = [
    cardPlaceholders(labels),
    ...BUILTIN_RENDERERS.filter((renderer) => CARD_RENDERERS.has(renderer.id)),
  ]
  const tree = await renderBody(
    markdown,
    { labels: previewLabels(labels), loadedEmbeds: [] },
    renderers,
  )
  readOnly(tree)
  return tree
}
