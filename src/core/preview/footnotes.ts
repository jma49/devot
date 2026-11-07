// Footnotes across a note rendered in pieces: each piece renders its calls and the notes it
// defines (definitions.ts), and they are numbered across the note, with one list of notes at its
// end, as mdast-util-to-hast numbers and lists them for a whole note.
import type { Element, ElementContent, Root as HastRoot, RootContent } from 'hast'
import { PIECE_OFFSET_PROPERTIES } from './registry'

const CALL_HREF = '#fn-'
const CALL_ID = 'user-content-fnref-'
const NOTE_ID = 'user-content-fn-'
const BACK_HREF = '#fnref-'

/** A note a piece defines, as its list item renders it (lines and offsets count from the piece). */
export interface PieceNote {
  id: string
  item: Element
  /** Calls in the note itself, to other notes. */
  calls: Element[]
  /** Whether the item holds offsets into the note, which move when text before it changes. */
  offsets: boolean
  /** The same for each render of the same item, so the list of notes is sent again only when one changed. */
  version: number
}

export interface PieceFootnotes {
  calls: Element[]
  notes: PieceNote[]
  /** The piece's own list of notes, emptied, as the shape of the note's. */
  section?: Element
}

type Parent = HastRoot | Element

const isElement = (node: RootContent | ElementContent): node is Element => node.type === 'element'

const isCall = (node: Element) =>
  node.tagName === 'a' && node.properties['dataFootnoteRef'] !== undefined

const isBackReference = (node: Element) =>
  node.tagName === 'a' && node.properties['dataFootnoteBackref'] !== undefined

function callsIn(nodes: readonly (RootContent | ElementContent)[], out: Element[] = []): Element[] {
  for (const node of nodes) {
    if (!isElement(node)) continue
    if (isCall(node)) out.push(node)
    else callsIn(node.children, out)
  }
  return out
}

function holdsOffsets(node: Element): boolean {
  if (PIECE_OFFSET_PROPERTIES.some((name) => node.properties[name] !== undefined)) return true
  return node.children.some((child) => isElement(child) && holdsOffsets(child))
}

/** The list of notes and the paragraph of calls a piece's render added, which come without a source position. */
function added(tree: HastRoot): { node: Element; parent: Parent }[] {
  const out: { node: Element; parent: Parent }[] = []
  const walk = (parent: Parent) => {
    for (const node of parent.children) {
      if (!isElement(node)) continue
      if (!node.position && isAdded(node)) out.push({ node, parent })
      else walk(node)
    }
  }
  walk(tree)
  return out
}

function isAdded(node: Element): boolean {
  if (node.tagName === 'section') return node.properties['dataFootnotes'] !== undefined
  return (
    node.tagName === 'p' &&
    node.children.length > 0 &&
    node.children.every((child) => isElement(child) && child.tagName === 'sup')
  )
}

function remove(parent: Parent, node: Element): void {
  const at = parent.children.indexOf(node as never)
  if (at < 0) return
  const before = parent.children[at - 1]
  const from = before?.type === 'text' && before.value === '\n' ? at - 1 : at
  parent.children.splice(from, at - from + 1)
}

/**
 * Takes what a piece's render added for its footnotes out of `tree` (call before positions are
 * stripped, `strip` then runs over the whole tree): the piece's calls, and the notes it defines
 * (items with a source position; the others stand for notes defined in other pieces).
 */
export function takeFootnotes(tree: HastRoot, strip: (tree: HastRoot) => void): PieceFootnotes {
  const extra = added(tree)
  const section = extra.find(({ node }) => node.tagName === 'section')?.node
  const items = section ? listOf(section).children.filter(isElement) : []
  const own = items.filter((item) => item.position)
  strip(tree)
  for (const { node, parent } of extra) remove(parent, node)
  const notes = own.map((item) => ({
    id: String(item.properties['id']).slice(NOTE_ID.length),
    item,
    calls: callsIn(item.children),
    offsets: holdsOffsets(item),
    version: 0,
  }))
  if (section) listOf(section).children = []
  return { calls: callsIn(tree.children), notes, ...(section ? { section } : {}) }
}

function listOf(section: Element): Element {
  const list = section.children.find((child) => isElement(child) && child.tagName === 'ol')
  if (!list || !isElement(list)) throw new Error('E_PREVIEW_FOOTNOTES')
  return list
}

/** Numbers calls in the order they come, as the whole note's render does. */
export function createNumbering() {
  const order: string[] = []
  const place = new Map<string, number>()
  const counts = new Map<string, number>()
  return {
    order,
    counts,
    /** Numbers `call` and returns what it got. */
    number(call: Element): string {
      const id = String(call.properties['href']).slice(CALL_HREF.length)
      let at = place.get(id)
      if (at === undefined) {
        at = order.push(id) - 1
        place.set(id, at)
      }
      const count = (counts.get(id) ?? 0) + 1
      counts.set(id, count)
      call.properties['id'] = CALL_ID + id + (count > 1 ? `-${count}` : '')
      call.children = [{ type: 'text', value: String(at + 1) }]
      return `${at + 1}.${count}`
    },
  }
}

const text = (value: string): ElementContent => ({ type: 'text', value })

function backReference(id: string, index: number, repeat: number): Element {
  const suffix = repeat > 1 ? `-${repeat}` : ''
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      href: BACK_HREF + id + suffix,
      dataFootnoteBackref: '',
      ariaLabel: `Back to reference ${index + 1}${suffix}`,
      className: ['data-footnote-backref'],
    },
    children: [
      text('↩'),
      ...(repeat > 1
        ? [{ type: 'element', tagName: 'sup', properties: {}, children: [text(String(repeat))] }]
        : []),
    ] as ElementContent[],
  }
}

function firstBackReference(parent: Element): { parent: Element; at: number } | null {
  for (const [at, child] of parent.children.entries()) {
    if (!isElement(child)) continue
    if (isBackReference(child)) return { parent, at }
    const inside = firstBackReference(child)
    if (inside) return inside
  }
  return null
}

/** `item` with `count` links back to its calls, the note being `index`th in the list. */
export function withBackReferences(item: Element, id: string, index: number, count: number): void {
  const found = firstBackReference(item)
  if (!found) return
  const { parent, at } = found
  // In a paragraph the links are spaced; straight in the item, each is on a line of its own.
  const loose = parent === item
  const links: ElementContent[] = []
  for (let repeat = 1; repeat <= count; repeat += 1) {
    if (repeat > 1) links.push(text(loose ? '\n \n' : ' '))
    links.push(backReference(id, index, repeat))
  }
  if (loose) links.push(text('\n'))
  parent.children.splice(at, parent.children.length - at, ...links)
}

/** The note's list of notes, in the shape of a piece's. */
export function footnoteSection(shape: Element, items: readonly Element[]): Element {
  const section = structuredClone(shape)
  listOf(section).children = [text('\n'), ...items.flatMap((item) => [item, text('\n')])]
  return section
}
