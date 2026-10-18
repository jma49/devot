// A code font can draw an operator such as `!=`, `=>` or `->` as one glyph
// (a ligature). The web view shapes text one element at a time, so the glyph
// forms only when the operator's characters sit in one element: a
// highlighter that styles `!` and `=` apart (or puts them in two spans of
// the same style) keeps them as two glyphs. These helpers give each run of
// operator characters in code a single style, so it is drawn as one piece.
import type { Element, ElementContent, Text } from 'hast'

/** Two or more operator characters in a row. */
const OPERATOR_RUN = /[-!#$%&*+./:<=>?@\\^|~]{2,}/g

/** A styled stretch of text, `from` and `to` in the text's coordinates. */
export interface StyledSpan<S> {
  from: number
  to: number
  style: S
}

/**
 * `spans` (in order, not overlapping) with every run of operator characters
 * in `text` left in one span or in none. A run split between styles takes
 * the one that covers most of it: a style over plain text on a tie, the
 * first style on a tie between styles. `text` starts at `offset` in the
 * spans' coordinates; spans outside it are kept as they are. `key` tells
 * styles apart (two spans with equal keys still count as two pieces).
 */
export function joinOperatorRuns<S>(
  text: string,
  offset: number,
  spans: readonly StyledSpan<S>[],
  key: (style: S) => string,
): StyledSpan<S>[] {
  const out = [...spans]
  let i = 0
  for (const match of text.matchAll(OPERATOR_RUN)) {
    const from = offset + match.index
    const to = from + match[0].length
    while (i < out.length && out[i]!.to <= from) i++
    let end = i
    while (end < out.length && out[end]!.from < to) end++
    const parts = out.slice(i, end)
    const whole = parts.length === 1 && parts[0]!.from <= from && parts[0]!.to >= to
    if (parts.length === 0 || whole) continue

    const cover = new Map<string, { style: S; chars: number }>()
    let styled = 0
    for (const part of parts) {
      const chars = Math.min(part.to, to) - Math.max(part.from, from)
      const k = key(part.style)
      const entry = cover.get(k)
      if (entry) entry.chars += chars
      else cover.set(k, { style: part.style, chars })
      styled += chars
    }
    let best: { style: S; chars: number } | undefined
    for (const entry of cover.values()) if (!best || entry.chars > best.chars) best = entry
    const plain = to - from - styled
    const style = best && best.chars >= plain ? best.style : undefined

    const first = parts[0]!
    const last = parts[parts.length - 1]!
    const joined: StyledSpan<S>[] = []
    if (first.from < from) joined.push({ ...first, to: from })
    if (style !== undefined) joined.push({ from, to, style })
    const before = joined.length
    if (last.to > to) joined.push({ ...last, from: to })
    out.splice(i, parts.length, ...joined)
    // The rest of the last span may reach the next run.
    i += before
  }
  return out
}

/**
 * Highlighted code (text and nested `span` elements) with each run of
 * operator characters in one element, or in none: see `joinOperatorRuns`.
 * The elements keep their properties; a run that leaves an element empty
 * drops it.
 */
export function joinOperatorRunsInHast(nodes: readonly ElementContent[]): ElementContent[] {
  // The text, and the elements around each stretch of it.
  let text = ''
  const spans: StyledSpan<readonly Element[]>[] = []
  const walk = (list: readonly ElementContent[], path: readonly Element[]): void => {
    for (const node of list) {
      if (node.type === 'text') {
        if (node.value === '') continue
        spans.push({ from: text.length, to: text.length + node.value.length, style: path })
        text += node.value
      } else if (node.type === 'element') {
        walk(node.children, [...path, node])
      }
    }
  }
  walk(nodes, [])
  if (!OPERATOR_RUN.test(text)) return [...nodes]
  OPERATOR_RUN.lastIndex = 0

  const ids = new Map<Element, number>()
  const key = (path: readonly Element[]): string =>
    path
      .map((element) => {
        let id = ids.get(element)
        if (id === undefined) ids.set(element, (id = ids.size))
        return id
      })
      .join('/')
  // Plain text is a span with no elements around it: keep it out, so that
  // it counts as no style.
  const styled = spans.filter((span) => span.style.length > 0)
  const joined = joinOperatorRuns(text, 0, styled, key)

  // Back to a tree: consecutive stretches inside the same element share it.
  const root: ElementContent[] = []
  const open: { source: Element; copy: Element }[] = []
  const add = (from: number, to: number, path: readonly Element[]): void => {
    if (from >= to) return
    let depth = 0
    while (depth < open.length && depth < path.length && open[depth]!.source === path[depth])
      depth++
    open.length = depth
    let children = depth > 0 ? open[depth - 1]!.copy.children : root
    for (const source of path.slice(depth)) {
      const copy: Element = { ...source, children: [] }
      children.push(copy)
      open.push({ source, copy })
      children = copy.children
    }
    const last = children[children.length - 1]
    if (last?.type === 'text') (last as Text).value += text.slice(from, to)
    else children.push({ type: 'text', value: text.slice(from, to) })
  }
  let at = 0
  for (const span of joined) {
    add(at, span.from, [])
    add(span.from, span.to, span.style)
    at = span.to
  }
  add(at, text.length, [])
  return root
}
