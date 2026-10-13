// Find in the rendered preview. The preview's text nodes are read as one
// string (a line break between blocks), searched with the same rules as the
// editor, and the matches are painted with the CSS Custom Highlight API, so
// the DOM is never changed: the preview's patcher keeps owning its nodes.
import { findMatches, type FindOptions } from '../../../core/find'
import { NO_MATCHES, seedQuery, type FindChange, type FindTarget } from '../find/target'

/** Highlight names, styled in app.css with `::highlight(...)`. */
export const MATCH_HIGHLIGHT = 'devot-find'
export const CURRENT_HIGHLIGHT = 'devot-find-current'

const BLOCK =
  'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd, caption, figcaption, summary, div, section, header, footer, aside, details, table, ul, ol, dl, tr, article'
// Text that is not shown as text: islands draw their own content (diagrams).
const SKIP = '[data-devot-island], script, style, svg, template'

interface TextMap {
  text: string
  nodes: Text[]
  /** Where each node's text starts in `text`. */
  starts: number[]
}

// Elements that start a new line of text, next to which a line break in
// the source is only markup.
const BREAKS = `${BLOCK}, hr, figure, thead, tbody, tfoot, colgroup, ${SKIP}`

/** Whether `text` sits at a block's edge on `side`: no sibling there, or one that breaks the line. */
function atBlockEdge(text: Text, side: 'previousSibling' | 'nextSibling'): boolean {
  let sibling = text[side]
  while (sibling?.nodeType === Node.COMMENT_NODE) sibling = sibling[side]
  return sibling === null || (sibling instanceof Element && sibling.matches(BREAKS))
}

/** The rendered text of `root`, with a line break between blocks and for `<br>`. */
function readText(root: HTMLElement): TextMap {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  let lastBlock: Element | null = null
  let lineBreak = false
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Element) {
      if (node.localName === 'br') lineBreak = true
      continue
    }
    const textNode = node as Text
    const parent = textNode.parentElement
    if (!parent || parent.closest(SKIP)) continue
    const inPre = parent.closest('pre') !== null
    // Line breaks between block tags are markup, not text; between two
    // inline elements they are a soft break, shown as a space.
    if (!inPre && /^\s*$/.test(textNode.data) && textNode.data.includes('\n')) {
      if (atBlockEdge(textNode, 'previousSibling') || atBlockEdge(textNode, 'nextSibling')) continue
    }
    const block = parent.closest(BLOCK)
    // A line break inside a paragraph shows as a space; same length, so
    // offsets still map one to one.
    let data = inPre ? textNode.data : textNode.data.replace(/[\r\n]/g, ' ')
    // After a <br>, the source line break that follows it is the break.
    const breakHere = lineBreak && block === lastBlock && !inPre && /^[\r\n]/.test(textNode.data)
    if (breakHere) data = `\n${data.slice(1)}`
    else if (text !== '' && (block !== lastBlock || lineBreak)) text += '\n'
    lastBlock = block
    lineBreak = false
    nodes.push(textNode)
    starts.push(text.length)
    text += data
  }
  return { text, nodes, starts }
}

/** The node and offset at `pos`; a position between nodes takes the next (or previous) one. */
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

/** The find bar's handle on the preview element `root`. */
export function previewFindTarget(root: HTMLElement): FindTarget {
  let options: FindOptions | null = null
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

  /** Matches for the text as it is now (an empty match is a collapsed range: counted, not painted). */
  const collect = () => {
    if (!options) {
      ranges = []
      invalid = false
      capped = false
      return
    }
    const map = readText(root)
    const result = findMatches(map.text, options)
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
  const observer = new MutationObserver(() => {
    if (!options) return
    collect()
    current = ranges.length === 0 ? null : Math.min(current ?? 0, ranges.length - 1)
    paint()
    notify()
  })

  return {
    canReplace: false,
    // The preview has no cursor: a step starts from the first (or last) match.
    search(next, step) {
      if (!options) observer.observe(root, { childList: true, subtree: true, characterData: true })
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
