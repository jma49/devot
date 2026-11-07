// Applies a sanitized hast tree to the DOM, touching only nodes that changed,
// so embeds keep playing and the scroll position holds while the user types.
// Nodes are built with DOM APIs, never through HTML strings.
import type { Element as HastElement, ElementContent, RootContent } from 'hast'
import { find, html } from 'property-information'
import { isCustomTagColor } from '../../../core/tags'
import { isMissingImage, markMissing } from '../missingImages'
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

type PropertyInfo = ReturnType<typeof find>
const propertyInfo = new Map<string, PropertyInfo>()
// Note HTML can name any `data-*` attribute; the cache starts over rather than grow with them.
const MAX_PROPERTY_INFO = 1000

function infoOf(key: string): PropertyInfo {
  let info = propertyInfo.get(key)
  if (info === undefined) {
    if (propertyInfo.size >= MAX_PROPERTY_INFO) propertyInfo.clear()
    info = find(html, key)
    propertyInfo.set(key, info)
  }
  return info
}

function attributes(node: HastElement): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined || value === false) continue
    const info = infoOf(key)
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

function applyTagColor(el: Element): void {
  const color = el.getAttribute('data-tag-color')
  if (el instanceof HTMLElement && isCustomTagColor(color)) {
    el.style.setProperty('--tag-custom', color)
  }
}

function syncAttributes(el: Element, node: HastElement): void {
  const next = attributes(node)
  // A failed image fires no second error for the same address: its placeholder outlives the patch.
  const failed =
    el instanceof HTMLImageElement &&
    isMissingImage(el) &&
    el.getAttribute('src') === next.get('src')
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
  if (failed) markMissing(el, true)
  applySwatch(el)
  applyTagColor(el)
}

const isIsland = (node: HastElement) => node.properties['dataDevotIsland'] !== undefined

const LINE_ATTRIBUTE = 'data-source-line'
const OFFSET_ATTRIBUTES = ['data-task-at', 'data-image-from', 'data-image-to']
/** Which shift each marked attribute takes: 0 the piece's lines, 1 its characters. */
const MARK_SHIFT = new Map<string, 0 | 1>([
  [LINE_ATTRIBUTE, 0],
  ...OFFSET_ATTRIBUTES.map((name) => [name, 1] as const),
])
const NO_SHIFT = [0, 0] as const

/** A piece's marked elements as it is built in document order, and how far each counts from its start. */
interface Marking {
  marked: Element[]
  shift: (index: number) => readonly [number, number]
}

function markingFor(piece: {
  line: number
  offset: number
  parts?: readonly PiecePart[] | undefined
}): Marking {
  const marked: Element[] = []
  const { parts } = piece
  if (!parts) {
    const whole = [piece.line - 1, piece.offset] as const
    return { marked, shift: () => whole }
  }
  let at = 0
  let end = parts[0]?.marks ?? 0
  return {
    marked,
    shift: (index) => {
      while (at < parts.length && index >= end) {
        at += 1
        end += parts[at]?.marks ?? 0
      }
      const part = parts[at]
      return part ? [part.line - 1, part.offset] : NO_SHIFT
    },
  }
}

/** `syncAttributes` for an element just made, with its line and offsets already shifted. */
function setAttributes(el: Element, node: HastElement, marking: Marking | undefined): void {
  let src: string | undefined
  let checked = false
  let swatch: string | undefined
  let tagColor: string | null = null
  let shift: readonly [number, number] | undefined
  for (const key in node.properties) {
    const value = node.properties[key]
    if (value === null || value === undefined || value === false) continue
    const info = infoOf(key)
    const name = info.attribute
    if (name === 'style') continue
    const shifted = typeof value === 'number' ? MARK_SHIFT.get(name) : undefined
    let text: string
    if (marking && typeof value === 'number' && shifted !== undefined) {
      if (!shift) {
        shift = marking.shift(marking.marked.length)
        marking.marked.push(el)
      }
      text = String(value + shift[shifted])
    } else {
      text =
        value === true
          ? ''
          : Array.isArray(value)
            ? value.join(info.commaSeparated ? ', ' : ' ')
            : String(value)
    }
    if (name === 'src') src = text
    else el.setAttribute(name, text)
    if (name === 'checked') checked = true
    else if (name === 'data-swatch-color') swatch = text
    else if (name === 'data-tag-color') tagColor = text
  }
  if (src !== undefined) el.setAttribute('src', src)
  if (el instanceof HTMLInputElement) el.checked = checked
  if (swatch && el instanceof HTMLElement && CSS.supports('color', swatch)) {
    el.style.backgroundColor = swatch
  }
  if (el instanceof HTMLElement && isCustomTagColor(tagColor)) {
    el.style.setProperty('--tag-custom', tagColor)
  }
}

function create(node: HastChild, parentNs: string | null, marking?: Marking): Node | null {
  if (node.type === 'text') return document.createTextNode(node.value)
  if (node.type !== 'element') return null
  const el = document.createElementNS(namespaceFor(node.tagName, parentNs), node.tagName)
  setAttributes(el, node, marking)
  if (!isIsland(node)) {
    const ns = el.namespaceURI
    for (const child of node.children) {
      const made = create(child, ns, marking)
      if (made) el.appendChild(made)
    }
  }
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

/** A run of a piece's marked elements, in document order, that counts from its own line and offset. */
export interface PiecePart {
  line: number
  offset: number
  marks: number
}

/** What the page shows of one piece of the note (see `renderPreviewPieces`). */
export interface ShownPiece {
  key: string
  /** The line and offset the piece's attributes count from, unless it has parts. */
  line: number
  offset: number
  parts?: PiecePart[]
  nodes: ChildNode[]
  marked: Element[]
  /** The nodes of a piece not built yet (see `buildPending`); it shows nothing until then. */
  pending?: readonly HastChild[]
}

export interface NextPiece {
  key: string
  line: number
  offset: number
  parts?: readonly PiecePart[] | undefined
  nodes?: readonly HastChild[] | undefined
}

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

function shiftMarked(
  marked: readonly Element[],
  from: number,
  to: number,
  lines: number,
  chars: number,
) {
  if (lines === 0 && chars === 0) return
  for (let i = from; i < to; i += 1) {
    const el = marked[i]!
    if (lines !== 0) bump(el, LINE_ATTRIBUTE, lines)
    if (chars !== 0) for (const name of OFFSET_ATTRIBUTES) bump(el, name, chars)
  }
}

function moveTo(piece: ShownPiece, to: NextPiece): void {
  if (piece.pending) {
    if (to.parts) piece.parts = to.parts.map((part) => ({ ...part }))
  } else if (piece.parts && to.parts) {
    let from = 0
    for (const [at, part] of to.parts.entries()) {
      const was = piece.parts[at]!
      shiftMarked(
        piece.marked,
        from,
        from + part.marks,
        part.line - was.line,
        part.offset - was.offset,
      )
      from += part.marks
    }
    piece.parts = to.parts.map((part) => ({ ...part }))
  } else {
    shiftMarked(
      piece.marked,
      0,
      piece.marked.length,
      to.line - piece.line,
      to.offset - piece.offset,
    )
  }
  piece.line = to.line
  piece.offset = to.offset
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

function built(
  piece: Pick<NextPiece, 'key' | 'line' | 'offset' | 'parts'>,
  nodes: readonly HastChild[],
  ns: string | null,
): ShownPiece {
  const marking = markingFor(piece)
  const made: ChildNode[] = []
  for (const node of nodes) {
    const el = create(node, ns, marking)
    if (el) made.push(el as ChildNode)
  }
  const out: ShownPiece = {
    key: piece.key,
    line: piece.line,
    offset: piece.offset,
    nodes: made,
    marked: marking.marked,
  }
  if (piece.parts) out.parts = piece.parts.map((part) => ({ ...part }))
  return out
}

const waiting = (piece: NextPiece): ShownPiece => {
  const out: ShownPiece = {
    key: piece.key,
    line: piece.line,
    offset: piece.offset,
    nodes: [],
    marked: [],
    pending: piece.nodes ?? [],
  }
  if (piece.parts) out.parts = piece.parts.map((part) => ({ ...part }))
  return out
}

/** The page's controls that sit last in `host`, before which built pieces go. */
function controlsOf(host: Element): Node | null {
  let first: Node | null = null
  for (let node = host.lastChild; node && isUi(node); node = node.previousSibling) first = node
  return first
}

export const hasPending = (pieces: readonly ShownPiece[]) => pieces.at(-1)?.pending !== undefined

/** The index of the first piece waiting, or the count when none waits; they are always the last. */
function firstPending(pieces: readonly ShownPiece[]): number {
  let low = 0
  let high = pieces.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (pieces[mid]!.pending === undefined) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * Builds the pieces `patchPieces` left to build later, in order, while `more`
 * says so of the next one, and returns how many it built. The pieces still
 * waiting are always the last ones, so the built ones read as the note does.
 */
export function buildPending(
  host: Element,
  pieces: readonly ShownPiece[],
  more: (next: ShownPiece) => boolean,
): number {
  let at = firstPending(pieces)
  if (at === pieces.length) return 0
  const fragment = document.createDocumentFragment()
  const start = at
  for (; at < pieces.length; at += 1) {
    const piece = pieces[at]!
    if (!piece.pending || !more(piece)) break
    const made = built(piece, piece.pending, host.namespaceURI)
    piece.nodes = made.nodes
    piece.marked = made.marked
    delete piece.pending
    for (const node of made.nodes) fragment.appendChild(node)
  }
  host.insertBefore(fragment, controlsOf(host))
  return at - start
}

/** Source characters built at once from the first piece left to build: more than a screen. */
export const FIRST_CHARACTERS = 20_000

/** Builds the pieces that start within `FIRST_CHARACTERS` of the first one waiting. */
export function buildFirstPieces(host: Element, pieces: readonly ShownPiece[]): number {
  let from: number | undefined
  return buildPending(host, pieces, (piece) => {
    from ??= piece.offset
    return piece.offset < from + FIRST_CHARACTERS
  })
}

/**
 * Builds the pieces up to the one `line` is in and `FIRST_CHARACTERS` past it, so its offset can
 * be read, and returns how many it built: none when that much is built already.
 */
export function buildToLine(host: Element, pieces: readonly ShownPiece[], line: number): number {
  let low = 0
  let high = pieces.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (pieces[mid]!.line <= line) low = mid + 1
    else high = mid
  }
  const from = pieces[low - 1]?.offset ?? 0
  const next = pieces[firstPending(pieces)]
  if (!next || next.offset >= from + FIRST_CHARACTERS) return 0
  return buildPending(host, pieces, (piece) => piece.offset < from + FIRST_CHARACTERS)
}

/**
 * Brings `host` from the pieces it shows to `next` and returns what it shows
 * then. Pieces that kept their key stay as they are (bar their lines and
 * offsets); each run between them is patched in place. A piece sent without
 * nodes must be one the host shows. With `defer`, new pieces after the last
 * one built are left to `buildPending`, as are those after a piece waiting.
 */
export function patchPieces(
  host: Element,
  shown: readonly ShownPiece[],
  next: readonly NextPiece[],
  { defer = false }: { defer?: boolean } = {},
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

  const fresh = (piece: NextPiece, nodes: ChildNode[]): ShownPiece => {
    const made: ShownPiece = { key: piece.key, line: 1, offset: 0, nodes, marked: markedIn(nodes) }
    if (piece.parts) made.parts = piece.parts.map((part) => ({ ...part, line: 1, offset: 0 }))
    moveTo(made, piece)
    return made
  }

  // Where each kept piece is now and was before; they stay put if they kept their order.
  const shownAt = new Map(oldMiddle.map((piece, at) => [piece.key, at]))
  const kept: { at: number; was: number }[] = []
  let inOrder = true
  for (const [at, piece] of newMiddle.entries()) {
    if (piece.nodes) continue
    const was = shownAt.get(piece.key)
    if (was === undefined || was <= (kept.at(-1)?.was ?? -1)) inOrder = false
    else kept.push({ at, was })
  }
  // Moving a piece past others that wait would leave a built one after them.
  if (!inOrder) buildPending(host, shown, () => true)

  const before = after.find((piece) => piece.nodes.length > 0)?.nodes[0] ?? controlsOf(host)
  let middle: ShownPiece[] = []
  if (inOrder) {
    let waits = head > 0 && shown[head - 1]!.pending !== undefined
    const builtAfter = after.some((piece) => piece.pending === undefined)
    let lastBuilt = -1
    for (const [index, { was }] of kept.entries()) {
      if (oldMiddle[was]!.pending === undefined) lastBuilt = index
    }
    let fromNew = 0
    let fromOld = 0
    for (const [index, { at, was }] of [
      ...kept,
      { at: newMiddle.length, was: oldMiddle.length },
    ].entries()) {
      const run = newMiddle.slice(fromNew, at)
      const old = oldMiddle.slice(fromOld, was).flatMap((piece) => piece.nodes)
      if (waits) {
        for (const node of old) node.remove()
        for (const piece of run) middle.push(waiting(piece))
      } else {
        const until =
          oldMiddle.slice(was).find((piece) => piece.nodes.length > 0)?.nodes[0] ?? before
        // The pieces that take the old nodes' place are patched over them; the others are new.
        let split = 0
        for (let count = 0; split < run.length && count < old.length; split += 1) {
          count += run[split]!.nodes!.filter(isShown).length
        }
        const patched = run.slice(0, split)
        const nodes = patchRange(
          host,
          old,
          patched.flatMap((piece) => piece.nodes!),
          until,
        )
        let taken = 0
        for (const piece of patched) {
          const count = piece.nodes!.filter(isShown).length
          taken += count
          middle.push(fresh(piece, nodes.slice(taken - count, taken)))
        }
        const made = run.slice(split)
        if (defer && !builtAfter && index > lastBuilt) {
          for (const piece of made) middle.push(waiting(piece))
          if (made.length > 0) waits = true
        } else {
          const fragment = document.createDocumentFragment()
          for (const piece of made) {
            const shownPiece = built(piece, piece.nodes!, host.namespaceURI)
            for (const node of shownPiece.nodes) fragment.appendChild(node)
            middle.push(shownPiece)
          }
          host.insertBefore(fragment, until)
        }
      }
      const stays = oldMiddle[was]
      if (stays) {
        moveTo(stays, newMiddle[at]!)
        middle.push(stays)
        if (stays.pending) waits = true
      }
      fromNew = at + 1
      fromOld = was + 1
    }
  } else {
    // A piece moved: the others in the run are built anew.
    const known = new Map(oldMiddle.map((piece) => [piece.key, piece]))
    const reused = new Set<ShownPiece>()
    middle = newMiddle.map((piece) => {
      if (piece.nodes) return built(piece, piece.nodes, host.namespaceURI)
      const old = known.get(piece.key)
      if (!old || reused.has(old)) throw new Error('E_PREVIEW_PIECE_MISSING')
      reused.add(old)
      moveTo(old, piece)
      return old
    })
    for (const piece of oldMiddle) {
      if (!reused.has(piece)) for (const node of piece.nodes) node.remove()
    }
    for (const piece of middle) for (const node of piece.nodes) host.insertBefore(node, before)
  }

  const out = [...shown.slice(0, head), ...middle, ...after]
  for (let i = 0; i < out.length; i += 1) {
    if (i < head || i >= head + middle.length) moveTo(out[i]!, next[i]!)
  }
  return out
}
