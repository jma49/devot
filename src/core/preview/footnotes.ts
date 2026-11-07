// Footnotes across a note rendered in pieces: each piece renders its calls and the notes it
// defines (definitions.ts), and they are numbered across the note, with one list of notes at its
// end, as mdast-util-to-hast numbers and lists them for a whole note.
import type { Element, ElementContent, Root as HastRoot, RootContent } from 'hast'

const CALL_HREF = '#fn-'
const CALL_ID = 'user-content-fnref-'
const NOTE_ID = 'user-content-fn-'
const BACK_HREF = '#fnref-'

/** A note a piece defines, as its list item renders it. */
export interface PieceNote {
  id: string
  /** Its lines and offsets count from `line` and `offset`, where it starts in its piece. */
  item: Element
  line: number
  offset: number
  /** Calls in the note itself, to other notes. */
  calls: Element[]
  marks: number
  /** The slugs of its headings to name, in order. */
  headings: string[]
  /** Its back reference's label, split where the note's number goes. */
  backLabel: readonly [string, string]
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

// The label the piece's render gave the item's first back reference, `number` being its place there.
function backLabelOf(item: Element, number: number): readonly [string, string] {
  const found = firstBackReference(item)
  const link = found?.parent.children[found.at] as Element | undefined
  const label = String(link?.properties['ariaLabel'] ?? '')
  const at = label.lastIndexOf(String(number))
  return at < 0 ? [label, ''] : [label.slice(0, at), label.slice(at + String(number).length)]
}

// The list of notes and the paragraph of calls a piece's render added, which come without a source position.
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
  const own = items.flatMap((item) => (item.position ? [{ item, start: item.position.start }] : []))
  strip(tree)
  for (const { node, parent } of extra) remove(parent, node)
  const notes = own.map(({ item, start }) => ({
    id: String(item.properties['id']).slice(NOTE_ID.length),
    item,
    line: start.line,
    offset: start.offset ?? 0,
    calls: callsIn(item.children),
    marks: 0,
    headings: [],
    backLabel: backLabelOf(item, items.indexOf(item) + 1),
    version: 0,
  }))
  // One back reference, so an item does not change with the calls its piece made.
  for (const note of notes) withBackReferences(note.item, note, 0, 1)
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

function backReference(
  id: string,
  index: number,
  repeat: number,
  [before, after]: readonly [string, string],
): Element {
  const suffix = repeat > 1 ? `-${repeat}` : ''
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      href: BACK_HREF + id + suffix,
      dataFootnoteBackref: '',
      ariaLabel: before + String(index + 1) + suffix + after,
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

/** `note`'s `item` with `count` links back to its calls, the note being `index`th in the list. */
export function withBackReferences(
  item: Element,
  note: PieceNote,
  index: number,
  count: number,
): void {
  const found = firstBackReference(item)
  if (!found) return
  const { parent, at } = found
  // In a paragraph the links are spaced; straight in the item, each is on a line of its own.
  const loose = parent === item
  const links: ElementContent[] = []
  for (let repeat = 1; repeat <= count; repeat += 1) {
    if (repeat > 1) links.push(text(loose ? '\n \n' : ' '))
    links.push(backReference(note.id, index, repeat, note.backLabel))
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
