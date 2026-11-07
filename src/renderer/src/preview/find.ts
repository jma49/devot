// Find in the rendered preview. The preview's text nodes are read as one
// string (a line break between blocks), searched with the same rules as the
// editor, and the matches are painted with the CSS Custom Highlight API, so
// the DOM is never changed: the preview's patcher keeps owning its nodes.
import {
  changedSpan,
  findMatches,
  updateMatches,
  type FindOptions,
  type FindResult,
} from '../../../core/find'
import { NO_MATCHES, seedQuery, type FindChange, type FindTarget } from '../find/target'

const MATCH_HIGHLIGHT = 'devot-find'
const CURRENT_HIGHLIGHT = 'devot-find-current'

const BLOCK =
  'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd, caption, figcaption, summary, div, section, header, footer, aside, details, table, ul, ol, dl, tr, article'
// Text that is not shown as text: islands draw their own content (diagrams).
const SKIP_ATTRIBUTES = ['data-devot-island', 'data-find-skip']
const SKIP = `${SKIP_ATTRIBUTES.map((name) => `[${name}]`).join(', ')}, script, style, svg, template`

/** Every change that can change the text find reads. */
export const WATCHED: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributeFilter: SKIP_ATTRIBUTES,
}

interface TextMap {
  text: string
  nodes: Text[]
  starts: number[]
}

// Elements that start a new line of text, next to which a line break in
// the source is only markup.
const BREAKS = `${BLOCK}, hr, figure, thead, tbody, tfoot, colgroup, ${SKIP}`

function atBlockEdge(text: Text, side: 'previousSibling' | 'nextSibling'): boolean {
  let sibling = text[side]
  while (sibling?.nodeType === Node.COMMENT_NODE) sibling = sibling[side]
  return sibling === null || (sibling instanceof Element && sibling.matches(BREAKS))
}

interface ReadState {
  empty: boolean
  lastBlock: Element | null
  lineBreak: boolean
}

interface Part {
  parent: Node | null
  before: ReadState
  after: Omit<ReadState, 'empty'>
  text: string
  nodes: Text[]
  starts: number[]
}

// Elements this deep (the preview's pieces) keep what they read, so a read
// after an edit walks only the pieces the edit touched.
const PART_DEPTH = 2

const sameState = (a: ReadState, b: ReadState) =>
  a.empty === b.empty && a.lastBlock === b.lastBlock && a.lineBreak === b.lineBreak

/**
 * Reads the preview's text as one string; `touched` takes the mutations
 * since the last read (observed with `WATCHED`), so the next read reuses
 * what every untouched piece gave.
 */
export function previewTextReader(root: HTMLElement) {
  let parts = new WeakMap<Element, Part>()
  const touched = new Set<Element>()

  const partOf = (node: Node): Element | null | undefined => {
    const path: Node[] = []
    for (let at: Node | null = node; at !== root; at = at.parentNode) {
      if (!at) return undefined
      path.push(at)
    }
    const part = path[path.length - PART_DEPTH]
    return part instanceof Element ? part : null
  }

  const read = (): TextMap => {
    const chunks: string[] = []
    const nodes: Text[] = []
    const starts: number[] = []
    let length = 0
    let lastBlock: Element | null = null
    let lineBreak = false

    const readNode = (textNode: Text) => {
      const parent = textNode.parentElement
      if (!parent || parent.closest(SKIP)) return
      const inPre = parent.closest('pre') !== null
      // Line breaks between block tags are markup, not text; between two
      // inline elements they are a soft break, shown as a space.
      if (!inPre && /^\s*$/.test(textNode.data) && textNode.data.includes('\n')) {
        if (atBlockEdge(textNode, 'previousSibling') || atBlockEdge(textNode, 'nextSibling')) return
      }
      const block = parent.closest(BLOCK)
      // A line break inside a paragraph shows as a space; same length, so
      // offsets still map one to one.
      let data = inPre ? textNode.data : textNode.data.replace(/[\r\n]/g, ' ')
      // After a <br>, the source line break that follows it is the break.
      const breakHere = lineBreak && block === lastBlock && !inPre && /^[\r\n]/.test(textNode.data)
      if (breakHere) data = `\n${data.slice(1)}`
      else if (length > 0 && (block !== lastBlock || lineBreak)) {
        chunks.push('\n')
        length += 1
      }
      lastBlock = block
      lineBreak = false
      nodes.push(textNode)
      starts.push(length)
      chunks.push(data)
      length += data.length
    }

    const visit = (node: Node, depth: number) => {
      if (node.nodeType === Node.TEXT_NODE) return readNode(node as Text)
      if (!(node instanceof Element)) return
      const kept = depth === PART_DEPTH
      const before: ReadState = { empty: length === 0, lastBlock, lineBreak }
      const part = kept && !touched.has(node) ? parts.get(node) : undefined
      if (part && part.parent === node.parentNode && sameState(part.before, before)) {
        for (let i = 0; i < part.nodes.length; i++) {
          nodes.push(part.nodes[i]!)
          starts.push(part.starts[i]! + length)
        }
        chunks.push(part.text)
        length += part.text.length
        ;({ lastBlock, lineBreak } = part.after)
        return
      }
      const first = { chunk: chunks.length, node: nodes.length, at: length }
      if (node.localName === 'br') lineBreak = true
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, depth + 1)
      if (!kept) return
      const text = chunks.splice(first.chunk).join('')
      chunks.push(text)
      parts.set(node, {
        parent: node.parentNode,
        before,
        after: { lastBlock, lineBreak },
        text,
        nodes: nodes.slice(first.node),
        starts: starts.slice(first.node).map((start) => start - first.at),
      })
    }

    for (let child = root.firstChild; child; child = child.nextSibling) visit(child, 1)
    touched.clear()
    return { text: chunks.join(''), nodes, starts }
  }

  return {
    read,
    touched(records: readonly MutationRecord[]) {
      for (const record of records) {
        const part = partOf(record.target)
        if (part) touched.add(part)
        // A skip attribute above the pieces changes what every piece under it reads.
        else if (part === null && record.type === 'attributes') parts = new WeakMap()
      }
    },
    forget() {
      parts = new WeakMap()
      touched.clear()
    },
  }
}

function point(map: TextMap, pos: number, end: boolean): [Text, number] {
  let lo = 0
  let hi = map.starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (map.starts[mid]! <= pos) lo = mid
    else hi = mid - 1
  }
  const node = map.nodes[lo]!
  const offset = pos - map.starts[lo]!
  if (offset < node.length || (end && offset === node.length)) return [node, offset]
  const next = map.nodes[lo + 1]
  if (end || !next) return [node, node.length]
  return [next, 0]
}

function rangeOf(map: TextMap, from: number, to: number): Range {
  const range = document.createRange()
  range.setStart(...point(map, from, false))
  range.setEnd(...point(map, to, true))
  return range
}

const highlights = (): HighlightRegistry | undefined =>
  typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : undefined

const NOTHING: FindResult = { matches: [], invalid: false, capped: false }

export function previewFindTarget(root: HTMLElement): FindTarget {
  const reader = previewTextReader(root)
  let options: FindOptions | null = null
  let text: string | null = null
  let result = NOTHING
  let ranges: Range[] = []
  let invalid = false
  let capped = false
  let current: number | null = null
  const listeners = new Set<(change: FindChange) => void>()
  const notify = () => {
    for (const listener of listeners) listener('status')
  }

  const paint = () => {
    const registry = highlights()
    if (!registry) return
    const shown = current === null ? undefined : ranges[current]
    registry.set(MATCH_HIGHLIGHT, new Highlight(...ranges.filter((r) => r !== shown)))
    registry.set(CURRENT_HIGHLIGHT, new Highlight(...(shown ? [shown] : [])))
  }

  // With `changed`, the preview changed under the same query: the matches
  // are found again only where the text did.
  const collect = (changed = false) => {
    if (!options) {
      text = null
      result = NOTHING
      ranges = []
      invalid = false
      capped = false
      return
    }
    const map = reader.read()
    const span = changed && text !== null ? changedSpan(text, map.text) : undefined
    if (span !== null) {
      const page = {
        length: map.text.length,
        slice: (from: number, to: number) => map.text.slice(from, to),
      }
      const update = span && updateMatches(result, options, span, page)
      result = update ? update.result : findMatches(map.text, options)
    }
    text = map.text
    invalid = result.invalid
    capped = result.capped
    ranges = map.nodes.length ? result.matches.map((m) => rangeOf(map, m.from, m.to)) : []
  }

  const reveal = () => {
    const range = current === null ? undefined : ranges[current]
    if (!range) return
    const box = root.getBoundingClientRect()
    // A collapsed range can have no box of its own; its text node's parent has.
    const own = range.getBoundingClientRect()
    const rect =
      own.width === 0 && own.height === 0
        ? (range.startContainer.parentElement ?? root).getBoundingClientRect()
        : own
    if (rect.top < box.top || rect.bottom > box.bottom)
      root.scrollTop += rect.top - box.top - box.height / 3
  }

  const go = (index: number | null) => {
    current = ranges.length === 0 || index === null ? null : (index + ranges.length) % ranges.length
    paint()
    reveal()
    notify()
  }

  // The preview re-renders as the note changes: find again, keeping the
  // current match's place in the list, without scrolling.
  const observer = new MutationObserver((records) => {
    reader.touched(records)
    if (!options) return
    collect(true)
    current = ranges.length === 0 ? null : Math.min(current ?? 0, ranges.length - 1)
    paint()
    notify()
  })

  return {
    canReplace: false,
    // The preview has no cursor: a step starts from the first (or last) match.
    search(next, step) {
      if (options) reader.touched(observer.takeRecords())
      else {
        // Unwatched since the bar last closed: read everything again.
        reader.forget()
        observer.observe(root, WATCHED)
      }
      options = next
      collect()
      go(ranges.length === 0 ? null : step === 'previous' ? ranges.length - 1 : 0)
    },
    next() {
      if (ranges.length) go(current === null ? 0 : current + 1)
    },
    previous() {
      if (ranges.length) go(current === null ? ranges.length - 1 : current - 1)
    },
    // The preview shows rendered text; replacing happens in the editor.
    replace() {},
    replaceAll() {},
    clear() {
      if (!options) return
      options = null
      observer.disconnect()
      reader.forget()
      collect()
      current = null
      highlights()?.delete(MATCH_HIGHLIGHT)
      highlights()?.delete(CURRENT_HIGHLIGHT)
    },
    status() {
      if (!options) return NO_MATCHES
      return { total: ranges.length, current, invalid, capped }
    },
    selectedText() {
      const selection = document.getSelection()
      if (!selection || selection.rangeCount === 0) return ''
      const range = selection.getRangeAt(0)
      return root.contains(range.commonAncestorContainer) ? seedQuery(selection.toString()) : ''
    },
    owns(node) {
      return node !== null && root.contains(node)
    },
    focus() {
      root.focus({ preventScroll: true })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
