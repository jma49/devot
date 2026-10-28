// Applies a sanitized hast tree to the DOM, touching only nodes that changed,
// so embeds keep playing and the scroll position holds while the user types.
// Nodes are built with DOM APIs, never through HTML strings.
import type { Element as HastElement, ElementContent, RootContent } from 'hast'
import { find, html } from 'property-information'
import { ISLAND_ATTRIBUTE } from './islands'

type HastChild = RootContent | ElementContent

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * MathML starts at `<math>` and SVG (a code block's language mark, built by
 * the core) at `<svg>`; everything inside stays in that namespace.
 */
function namespaceFor(tagName: string, parentNs: string | null): string {
  if (tagName === 'math') return MATHML_NS
  if (tagName === 'svg') return SVG_NS
  return parentNs === MATHML_NS || parentNs === SVG_NS ? parentNs : HTML_NS
}

function attributes(node: HastElement): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined || value === false) continue
    const info = find(html, key)
    // Inline styles are never set through attributes (the CSP forbids them).
    if (info.attribute === 'style') continue
    const text =
      value === true
        ? ''
        : Array.isArray(value)
          ? value.join(info.commaSeparated ? ', ' : ' ')
          : String(value)
    out.set(info.attribute, text)
  }
  // A frame's sandbox must be in place before it starts loading.
  const src = out.get('src')
  if (src !== undefined) {
    out.delete('src')
    out.set('src', src)
  }
  return out
}

function applySwatch(el: Element): void {
  const color = el.getAttribute('data-swatch-color')
  if (color && el instanceof HTMLElement && CSS.supports('color', color)) {
    el.style.backgroundColor = color
  }
}

function syncAttributes(el: Element, node: HastElement): void {
  const next = attributes(node)
  // What the page itself changed stays: an opened details is still open (a
  // box's tick is kept by hand below, for the same reason).
  const keepsOpen = el instanceof HTMLDetailsElement && !next.has('open')
  for (const name of el.getAttributeNames()) {
    if (name !== 'style' && !(keepsOpen && name === 'open') && !next.has(name))
      el.removeAttribute(name)
  }
  for (const [name, value] of next) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value)
  }
  // A clicked box no longer follows its attribute; it shows what the note says.
  if (el instanceof HTMLInputElement) el.checked = next.has('checked')
  applySwatch(el)
}

const isIsland = (node: HastElement) => node.properties['dataDevotIsland'] !== undefined

function create(node: HastChild, parentNs: string | null): Node | null {
  if (node.type === 'text') return document.createTextNode(node.value)
  if (node.type !== 'element') return null
  const el = document.createElementNS(namespaceFor(node.tagName, parentNs), node.tagName)
  syncAttributes(el, node)
  if (!isIsland(node)) patchChildren(el, node.children)
  return el
}

function sameKind(dom: Node, node: HastChild, parentNs: string | null): boolean {
  if (node.type === 'text') return dom.nodeType === Node.TEXT_NODE
  if (node.type !== 'element' || !(dom instanceof Element)) return false
  if (
    dom.localName !== node.tagName ||
    dom.namespaceURI !== namespaceFor(node.tagName, parentNs) ||
    // An island is not a plain element of its tag (or another island): the
    // mounter holds a slot for the one it rendered, and a reused div would
    // show that drawing in a place that is not a diagram.
    isIsland(node) !== dom.hasAttribute(ISLAND_ATTRIBUTE) ||
    (isIsland(node) &&
      dom.getAttribute(ISLAND_ATTRIBUTE) !== String(node.properties['dataDevotIsland']))
  ) {
    return false
  }
  // A different embed is a new frame, not a navigation of the old one.
  return node.tagName !== 'iframe' || dom.getAttribute('src') === node.properties['src']
}

/**
 * The page's own controls in the preview (a code block's copy button) carry
 * this attribute. They are not part of the note's HTML: the patcher never
 * reuses, replaces or removes them, and they always follow the note's nodes.
 */
export const UI_ATTRIBUTE = 'data-devot-ui'

const isUi = (node: Node) => node instanceof Element && node.hasAttribute(UI_ATTRIBUTE)

export function patchChildren(parent: Node, next: readonly HastChild[]): void {
  const wanted = next.filter((n) => n.type === 'text' || n.type === 'element')
  const ns = parent instanceof Element ? parent.namespaceURI : HTML_NS
  // Controls sit last, so most parents (those without) take the quick path.
  const withUi = parent.lastChild !== null && isUi(parent.lastChild)
  const own: ArrayLike<ChildNode> = withUi
    ? Array.from(parent.childNodes).filter((n) => !isUi(n))
    : parent.childNodes
  // New nodes go before the page's controls.
  const end = withUi ? (Array.from(parent.childNodes).find(isUi) ?? null) : null
  for (let i = 0; i < wanted.length; i += 1) {
    const node = wanted[i]!
    const dom = own[i]
    if (!dom) {
      const created = create(node, ns)
      if (created) parent.insertBefore(created, end)
    } else if (!sameKind(dom, node, ns)) {
      const created = create(node, ns)
      if (created) parent.replaceChild(created, dom)
    } else if (node.type === 'text') {
      if (dom.nodeValue !== node.value) dom.nodeValue = node.value
    } else if (node.type === 'element') {
      syncAttributes(dom as Element, node)
      if (!isIsland(node)) patchChildren(dom, node.children)
    }
  }
  if (withUi) for (const extra of Array.from(own).slice(wanted.length)) extra.remove()
  else while (parent.childNodes.length > wanted.length) parent.lastChild?.remove()
}

/** What the page shows of one piece of the note (see `renderPreviewPieces`). */
export interface ShownPiece {
  key: string
  /** The line and offset the piece's attributes count from. */
  line: number
  offset: number
  nodes: ChildNode[]
  marked: Element[]
}

export interface NextPiece {
  key: string
  line: number
  offset: number
  nodes?: readonly HastChild[] | undefined
}

const LINE_ATTRIBUTE = 'data-source-line'
const OFFSET_ATTRIBUTES = ['data-task-at', 'data-image-from', 'data-image-to']
const MARKED = [LINE_ATTRIBUTE, ...OFFSET_ATTRIBUTES].map((name) => `[${name}]`).join(', ')

const isShown = (n: HastChild) => n.type === 'text' || n.type === 'element'

function markedIn(nodes: readonly ChildNode[]): Element[] {
  const out: Element[] = []
  for (const node of nodes) {
    if (!(node instanceof Element)) continue
    if (node.matches(MARKED)) out.push(node)
    out.push(...node.querySelectorAll(MARKED))
  }
  return out
}

function bump(el: Element, name: string, by: number): void {
  const value = el.getAttribute(name)
  if (value !== null) el.setAttribute(name, String(Number(value) + by))
}

function moveTo(piece: ShownPiece, line: number, offset: number): void {
  const lines = line - piece.line
  const chars = offset - piece.offset
  if (lines === 0 && chars === 0) return
  for (const el of piece.marked) {
    if (lines !== 0) bump(el, LINE_ATTRIBUTE, lines)
    if (chars !== 0) for (const name of OFFSET_ATTRIBUTES) bump(el, name, chars)
  }
  piece.line = line
  piece.offset = offset
}

/** `patchChildren` for the run `old`, which sits just before `before`. */
function patchRange(
  parent: Element,
  old: readonly ChildNode[],
  next: readonly HastChild[],
  before: Node | null,
): ChildNode[] {
  const wanted = next.filter(isShown)
  const ns = parent.namespaceURI
  const out: ChildNode[] = []
  for (let i = 0; i < wanted.length; i += 1) {
    const node = wanted[i]!
    const dom = old[i]
    if (!dom || !sameKind(dom, node, ns)) {
      const created = create(node, ns) as ChildNode
      if (dom) parent.replaceChild(created, dom)
      else parent.insertBefore(created, before)
      out.push(created)
      continue
    }
    if (node.type === 'text') {
      if (dom.nodeValue !== node.value) dom.nodeValue = node.value
    } else if (node.type === 'element') {
      syncAttributes(dom as Element, node)
      if (!isIsland(node)) patchChildren(dom, node.children)
    }
    out.push(dom)
  }
  for (const extra of old.slice(wanted.length)) extra.remove()
  return out
}

/**
 * Brings `host` from the pieces it shows to `next` and returns what it shows
 * then. Pieces at the start and the end that kept their key stay as they are
 * (bar their lines and offsets); the run between is patched in place. A piece
 * sent without nodes must be one the host shows.
 */
export function patchPieces(
  host: Element,
  shown: readonly ShownPiece[],
  next: readonly NextPiece[],
): ShownPiece[] {
  let head = 0
  while (head < shown.length && head < next.length && shown[head]!.key === next[head]!.key) {
    head += 1
  }
  let tail = 0
  while (
    tail < shown.length - head &&
    tail < next.length - head &&
    shown[shown.length - 1 - tail]!.key === next[next.length - 1 - tail]!.key
  ) {
    tail += 1
  }
  const oldMiddle = shown.slice(head, shown.length - tail)
  const newMiddle = next.slice(head, next.length - tail)
  const after = shown.slice(shown.length - tail)
  const before =
    after.find((piece) => piece.nodes.length > 0)?.nodes[0] ??
    Array.from(host.childNodes).find(isUi) ??
    null

  const fresh = (piece: NextPiece, nodes: ChildNode[]): ShownPiece => {
    const made = { key: piece.key, line: 1, offset: 0, nodes, marked: markedIn(nodes) }
    moveTo(made, piece.line, piece.offset)
    return made
  }

  let middle: ShownPiece[]
  if (newMiddle.every((piece) => piece.nodes)) {
    const nodes = patchRange(
      host,
      oldMiddle.flatMap((piece) => piece.nodes),
      newMiddle.flatMap((piece) => piece.nodes!),
      before,
    )
    let at = 0
    middle = newMiddle.map((piece) => {
      const count = piece.nodes!.filter(isShown).length
      at += count
      return fresh(piece, nodes.slice(at - count, at))
    })
  } else {
    // A piece moved: the others in the run are built anew.
    const known = new Map(oldMiddle.map((piece) => [piece.key, piece]))
    const kept = new Set<ShownPiece>()
    middle = newMiddle.map((piece) => {
      if (piece.nodes) {
        const nodes = piece.nodes.filter(isShown).map((n) => create(n, host.namespaceURI))
        return fresh(piece, nodes as ChildNode[])
      }
      const old = known.get(piece.key)
      if (!old || kept.has(old)) throw new Error('E_PREVIEW_PIECE_MISSING')
      kept.add(old)
      moveTo(old, piece.line, piece.offset)
      return old
    })
    for (const piece of oldMiddle) {
      if (!kept.has(piece)) for (const node of piece.nodes) node.remove()
    }
    for (const piece of middle) for (const node of piece.nodes) host.insertBefore(node, before)
  }

  const out = [...shown.slice(0, head), ...middle, ...after]
  for (let i = 0; i < out.length; i += 1) {
    if (i < head || i >= head + middle.length) moveTo(out[i]!, next[i]!.line, next[i]!.offset)
  }
  return out
}
