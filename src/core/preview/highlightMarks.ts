// `==text==` as <mark>, read as the editor's parser reads it (Highlight in
// editor/markdown.ts): a pair of exactly two `=` that flanks its text by
// strikethrough's rule, matched with the nearest opener, never across a block
// or into code (code is no text node here). An escaped `=` is text, as in the
// editor: the text is read against the note's source, which still has the escapes.
import type { Parent, PhrasingContent, Root, RootContent, Text } from 'mdast'

const SPACE_OR_EDGE = /\s|^$/
const PUNCTUATION = /[\p{S}\p{P}]/u
const DELIMITER = /(?<!=)==(?!=)/g
const ESCAPABLE = /[!-/:-@[-`{-~]/
const ENTITY = /^&(?:#\d{1,7}|#x[\da-f]{1,6}|\w{1,32});/i

/**
 * Which characters of `node`'s text were escaped or written as an entity in
 * `source`. Characters of the source the text dropped (a quote's `>`, an
 * indent) are passed over.
 */
function escapedIn(node: Text, source: string): boolean[] {
  const value = node.value
  const escaped: boolean[] = Array.from({ length: value.length }, () => false)
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return escaped
  const src = source.slice(start, end)
  let i = 0
  let j = 0
  while (i < value.length && j < src.length) {
    const ch = value.charAt(i)
    if (src.charAt(j) === '\\' && src.charAt(j + 1) === ch && ESCAPABLE.test(ch)) {
      escaped[i++] = true
      j += 2
    } else if (src.charAt(j) === ch) {
      i++
      j++
    } else if (src.charAt(j) === '&' && ENTITY.test(src.slice(j, j + 40))) {
      escaped[i++] = true
      j += (ENTITY.exec(src.slice(j, j + 40)) as RegExpExecArray)[0].length
    } else j++
  }
  return escaped
}

type Item = { node: PhrasingContent } | { delim: number }

interface Delim {
  open: boolean
  close: boolean
  partner?: number
}

function split(
  children: readonly PhrasingContent[],
  source: string,
): { items: Item[]; delims: Delim[] } {
  const items: Item[] = []
  const delims: Delim[] = []
  for (const node of children) {
    if (node.type !== 'text' || !node.value.includes('==')) {
      items.push({ node })
      continue
    }
    let last = 0
    const escaped = escapedIn(node, source)
    for (const match of node.value.matchAll(DELIMITER)) {
      const at = match.index
      if (escaped[at] || escaped[at + 1]) continue
      if (at > last) items.push({ node: { type: 'text', value: node.value.slice(last, at) } })
      const before = at > 0 ? node.value.charAt(at - 1) : null
      const after = at + 2 < node.value.length ? node.value.charAt(at + 2) : null
      items.push({ delim: delims.length })
      delims.push(flank(before, after, children, node))
      last = at + 2
    }
    if (last < node.value.length)
      items.push({ node: { type: 'text', value: node.value.slice(last) } })
  }
  return { items, delims }
}

/** Strikethrough's flanking rule; `null` is the edge of the text node, so the neighbouring node or the block's edge. */
function flank(
  before: string | null,
  after: string | null,
  children: readonly PhrasingContent[],
  node: Text,
): Delim {
  const index = children.indexOf(node)
  const b = before ?? (index > 0 ? 'a' : '')
  const a = after ?? (index < children.length - 1 ? 'a' : '')
  const sBefore = SPACE_OR_EDGE.test(b)
  const sAfter = SPACE_OR_EDGE.test(a)
  const pBefore = PUNCTUATION.test(b)
  const pAfter = PUNCTUATION.test(a)
  return {
    open: !sAfter && (!pAfter || sBefore || pBefore),
    close: !sBefore && (!pBefore || sAfter || pAfter),
  }
}

function pair(delims: Delim[]): void {
  const openers: number[] = []
  for (const [i, d] of delims.entries()) {
    if (d.close && openers.length > 0) {
      const opener = openers.pop() as number
      ;(delims[opener] as Delim).partner = i
      d.partner = opener
    } else if (d.open) openers.push(i)
  }
}

function build(items: readonly Item[], delims: readonly Delim[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  const push = (node: PhrasingContent) => {
    const prev = out[out.length - 1]
    if (node.type === 'text' && prev?.type === 'text') prev.value += node.value
    else out.push(node)
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item
    if ('node' in item) {
      push(item.node)
      continue
    }
    const delim = delims[item.delim] as Delim
    const partner = delim.partner
    if (partner === undefined || partner < item.delim) {
      if (partner === undefined) push({ type: 'text', value: '==' })
      continue
    }
    const end = items.findIndex((it, n) => n > i && 'delim' in it && it.delim === partner)
    const mark = {
      type: 'highlightMark',
      data: { hName: 'mark' },
      children: build(items.slice(i + 1, end), delims),
    }
    push(mark as unknown as PhrasingContent)
    i = end
  }
  return out
}

function highlightIn(parent: Parent, source: string): void {
  for (const child of parent.children as RootContent[])
    if ('children' in child) highlightIn(child, source)
  const children = parent.children as PhrasingContent[]
  if (!children.some((c) => c.type === 'text' && c.value.includes('=='))) return
  const { items, delims } = split(children, source)
  pair(delims)
  if (delims.every((d) => d.partner === undefined)) return
  parent.children = build(items, delims) as Parent['children']
}

export function remarkHighlightMarks() {
  return (tree: Root, file: { value: unknown }) => highlightIn(tree, String(file.value))
}
