// Write mode's rendered blocks: which lines an image, a formula, a diagram or
// an embed takes, whether the selection opens it, and how the arrows and
// Backspace treat a closed one. Pure: read from the syntax tree and the
// selection, so the rules are tested over Markdown without an editor.
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  type ChangeDesc,
  type EditorState,
  type SelectionRange,
  type Text,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { videoEmbedUrl } from '../../../../core/preview/builtins'
import { findImages } from '../images'
import type { Span } from './changes'
import { writeFocus } from './focus'

export type WriteBlockKind = 'image' | 'math' | 'diagram' | 'embed'

export interface WriteBlock {
  kind: WriteBlockKind
  /** The start of its first line. */
  from: number
  /** The end of its last line. */
  to: number
  /** Where a click on the rendering puts the caret: inside the source, which opens it. */
  entry: number
  source: string
}

/** `open` shows the source under the rendering; `selected` is the whole block in the selection. */
export type BlockLook = 'closed' | 'selected' | 'open'

const MATH_FENCE = /^ {0,3}\$\$[ \t]*$/
const EMBED_URL = /^ {0,3}<?(https:\/\/[^\s<>]+)>?[ \t]*$/
const IFRAME = /^ {0,3}<iframe\b[\s\S]*<\/iframe>\s*$/i
const IMAGE_SHOWN = /^https:\/\/[^/]/i

/** `$$ x $$` on a line of its own. */
function isMathLine(text: string): boolean {
  const line = text.trim()
  return (
    text.length - text.trimStart().length <= 3 &&
    line.length > 4 &&
    line.startsWith('$$') &&
    line.endsWith('$$') &&
    line.slice(2, -2).trim() !== ''
  )
}

/** Where a click on an image puts the caret: at the end of its alt text. */
export function imageEntry(image: { from: number; text: string }): number {
  const altEnd = image.text.lastIndexOf('](')
  return image.from + (altEnd > 0 ? altEnd : 2)
}

interface Scan {
  tree: Tree
  blocks: WriteBlock[]
  /** The start of a `$$` line no fence closes: nothing after it is a block. */
  unclosed: number | null
}

const cache = new WeakMap<Text, Scan>()

/** Every rendered block of the note, in order; only blocks at the top level, outside lists and quotes. */
export function writeBlocksOf(state: EditorState, tree = syntaxTree(state)): readonly WriteBlock[] {
  const known = cache.get(state.doc)
  if (known?.tree === tree) return known.blocks
  const blocks: WriteBlock[] = []
  const { unclosed } = scan(state, tree, 0, () => false, blocks)
  cache.set(state.doc, { tree, blocks, unclosed })
  return blocks
}

/**
 * Keeps the blocks of a step's start for its end, read again only over
 * `changed` (sorted spans of the new note, whole lines, from `changedSpans`)
 * and as far past it as a block read there reaches. Returns the spans read
 * again, past `changed` too where fences pair anew; null when the start's
 * blocks were never read: they are read whole when asked for.
 */
export function carryWriteBlocks(tr: Transaction, changed: readonly Span[]): Span[] | null {
  const { state } = tr
  const tree = syntaxTree(state)
  if (cache.get(state.doc)?.tree === tree) return []
  const before = cache.get(tr.startState.doc)
  if (before?.tree !== syntaxTree(tr.startState)) return null
  const read: Span[] = []
  cache.set(state.doc, carry(before, state, tree, tr.changes, changed, read))
  return read
}

function moved(block: WriteBlock, changes: ChangeDesc): WriteBlock {
  if (changes.empty) return block
  const from = changes.mapPos(block.from, -1)
  const to = changes.mapPos(block.to, 1)
  if (from === block.from && to === block.to) return block
  return { ...block, from, to, entry: changes.mapPos(block.entry) }
}

function carry(
  before: Scan,
  state: EditorState,
  tree: Tree,
  changes: ChangeDesc,
  changed: readonly Span[],
  read: Span[],
): Scan {
  const old = before.blocks.map((b) => moved(b, changes))
  let unclosed = before.unclosed === null ? null : changes.mapPos(before.unclosed, -1)
  const out: WriteBlock[] = []
  let k = 0
  let r = 0
  while (r < changed.length) {
    let [from, limit] = changed[r++]!
    while (k < old.length && old[k]!.to < from) out.push(old[k++]!)
    if (k < old.length && old[k]!.from < from) from = old[k]!.from
    if (unclosed !== null && unclosed <= limit) {
      from = Math.min(from, unclosed)
      limit = Infinity
    }
    // Reading stops at a line past the change that no old block takes: from
    // there on, the old blocks are what reading on would find.
    let stopped = 0
    const stop = (pos: number) => {
      while (k < old.length && old[k]!.from < pos) limit = Math.max(limit, old[k++]!.to)
      if (unclosed !== null && unclosed < pos) limit = Infinity
      while (r < changed.length && changed[r]![0] <= limit)
        limit = Math.max(limit, changed[r++]![1])
      stopped = pos
      return pos > limit
    }
    const result = scan(state, tree, from, stop, out)
    read.push([from, result.end ? state.doc.length : stopped - 1])
    if (result.unclosed !== null) return { tree, blocks: out, unclosed: result.unclosed }
    if (result.end) {
      unclosed = null
      k = old.length
      break
    }
  }
  while (k < old.length) out.push(old[k++]!)
  return { tree, blocks: out, unclosed }
}

/** The top-level node at a position, for positions asked in increasing order from `from`. */
function topLevel(tree: Tree, from: number): (pos: number) => SyntaxNode | null {
  const cursor = tree.cursor()
  let more = cursor.childAfter(from)
  return (pos) => {
    while (more && cursor.to <= pos) more = cursor.nextSibling()
    return more && cursor.from <= pos ? cursor.node : null
  }
}

const CANDIDATE = /^ {0,3}(?:\$\$|```|~~~|<|https:\/\/|!\[)/

/**
 * Reads the text line by line from the line at `from` and asks the syntax
 * tree only on lines that may start a block (as images.ts does), which stays
 * cheap on long notes. Stops before a line, outside every block, at whose
 * start `stop` says so; `end` is whether it read to the end of the note.
 */
function scan(
  state: EditorState,
  tree: Tree,
  from: number,
  stop: (pos: number) => boolean,
  out: WriteBlock[],
): { unclosed: number | null; end: boolean } {
  const doc = state.doc
  const first = doc.lineAt(from)
  const lines = doc.iterLines(first.number)
  let pos = first.from
  let text = ''
  let started = false
  const advance = (): boolean => {
    if (started) pos += text.length + 1
    started = true
    if (lines.next().done) return false
    text = lines.value
    return true
  }
  const topAt = topLevel(tree, pos)
  const block = (kind: WriteBlockKind, start: number, end: number, entry: number) => {
    out.push({ kind, from: start, to: end, entry, source: doc.sliceString(start, end) })
  }
  const skipTo = (end: number): boolean => {
    while (pos + text.length < end) if (!advance()) return false
    return true
  }
  while (advance()) {
    if (stop(pos)) return { unclosed: null, end: false }
    if (!CANDIDATE.test(text)) continue
    const start = pos + text.length - text.trimStart().length
    const node = topAt(start)
    if (!node) continue
    if (node.name === 'FencedCode' || node.name === 'HTMLBlock') {
      if (node.from === start) (node.name === 'FencedCode' ? fence : html)(node)
      if (!skipTo(node.to)) break
      continue
    }
    if (node.name !== 'Paragraph') continue
    const lineEnd = pos + text.length
    const single = node.from === start && node.to <= lineEnd
    // A math fence starts a block inside a paragraph too, as the preview reads it.
    if (MATH_FENCE.test(text)) {
      const open = pos
      let entry = lineEnd
      let inside = 0
      let closed = false
      while (advance()) {
        if (MATH_FENCE.test(text)) {
          closed = true
          break
        }
        if (++inside === 1) entry = pos + text.length
      }
      if (!closed) return { unclosed: open, end: true }
      block('math', open, pos + text.length, inside >= 1 ? entry : lineEnd)
      continue
    }
    if (single && isMathLine(text)) {
      block('math', pos, lineEnd, lineEnd - 2)
      continue
    }
    const url = single ? EMBED_URL.exec(text)?.[1] : undefined
    if (url && videoEmbedUrl(url)) {
      block('embed', pos, lineEnd, lineEnd - 1)
      continue
    }
    if (text.includes('![')) imageLine()
  }
  return { unclosed: null, end: true }

  function fence(node: SyntaxNode) {
    const info = node.getChild('CodeInfo')
    const lang = info
      ? doc.sliceString(info.from, info.to).trim().split(/\s/)[0]?.toLowerCase()
      : ''
    const kind = ['mermaid', 'plantuml', 'puml', 'markmap'].includes(lang ?? '')
      ? 'diagram'
      : lang === 'math'
        ? 'math'
        : null
    const last = doc.lineAt(node.to)
    // An unclosed fence runs to the end of the note: it stays source while it is being written.
    if (!kind || node.getChildren('CodeMark').length < 2 || last.from === pos) return
    const entry =
      last.number - doc.lineAt(pos).number >= 2
        ? doc.lineAt(pos + text.length + 1).to
        : pos + text.length
    block(kind, pos, last.to, entry)
  }

  function imageLine() {
    const end = pos + text.length
    const images = findImages(state, pos, end)
    if (images.length === 0) return
    let rest = text
    for (let n = images.length - 1; n >= 0; n--) {
      const image = images[n]!
      if (image.from < pos || image.to > end) return
      if (image.fileId === null && !IMAGE_SHOWN.test(image.url)) return
      rest = rest.slice(0, image.from - pos) + rest.slice(image.to - pos)
    }
    if (rest.trim() !== '') return
    block('image', pos, end, imageEntry(images[0]!))
  }

  function html(node: SyntaxNode) {
    const last = doc.lineAt(node.to)
    if (!IFRAME.test(doc.sliceString(pos, last.to))) return
    block('embed', pos, last.to, last.to - 1)
  }
}

const within = (block: WriteBlock, pos: number) => block.from <= pos && pos <= block.to

/**
 * A caret in a block, its edges included, opens it (only while the editor has
 * the keyboard, as for the marks), and so does a selection that meets it; a
 * selection over all of it selects it instead.
 */
export function blockLook(state: EditorState, block: WriteBlock): BlockLook {
  const focused = state.field(writeFocus, false) ?? false
  let selected = false
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (focused && within(block, range.head)) return 'open'
      continue
    }
    if (range.from <= block.from && range.to >= block.to) selected = true
    else if (range.from <= block.to && range.to >= block.from) return 'open'
  }
  return selected ? 'selected' : 'closed'
}

/** The closed block that takes `pos` (its edges included), if any. */
function closedBlockAt(state: EditorState, pos: number): WriteBlock | null {
  for (const block of writeBlocksOf(state)) {
    if (block.from > pos) return null
    if (pos <= block.to) return blockLook(state, block) === 'open' ? null : block
  }
  return null
}

/** The block the main selection is exactly, as Backspace at its edge selects it. */
export function selectedBlock(state: EditorState): WriteBlock | null {
  if (state.selection.ranges.length !== 1) return null
  const { from, to, empty } = state.selection.main
  if (empty) return null
  const block = closedBlockAt(state, from)
  return block && block.from === from && block.to === to ? block : null
}

function singleCaret(state: EditorState): number | null {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null
  return state.selection.main.head
}

const select = (block: WriteBlock): TransactionSpec => ({
  selection: EditorSelection.range(block.from, block.to),
  userEvent: 'select',
  scrollIntoView: true,
})

/** Takes the block and one line break with it, so no empty line is left in its place. */
function remove(state: EditorState, block: WriteBlock): TransactionSpec {
  const length = state.doc.length
  const [from, to] =
    block.to < length
      ? [block.from, block.to + 1]
      : block.from > 0
        ? [block.from - 1, block.to]
        : [block.from, block.to]
  return {
    changes: { from, to },
    selection: { anchor: from },
    userEvent: 'delete.selection',
    scrollIntoView: true,
  }
}

/**
 * Backspace at the start of a line of text right under a closed block selects
 * the block; with the block selected it deletes it.
 */
export function blockBackspace(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null
  const selected = selectedBlock(state)
  if (selected) return remove(state, selected)
  const pos = singleCaret(state)
  if (pos === null || pos === 0) return null
  const line = state.doc.lineAt(pos)
  if (line.from !== pos || line.length === 0) return null
  const above = closedBlockAt(state, pos - 1)
  return above && above.to === pos - 1 ? select(above) : null
}

/** Delete, the other way: at the end of a line of text right over a closed block. */
export function blockDelete(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null
  const selected = selectedBlock(state)
  if (selected) return remove(state, selected)
  const pos = singleCaret(state)
  if (pos === null || pos === state.doc.length) return null
  const line = state.doc.lineAt(pos)
  if (line.to !== pos || line.length === 0) return null
  const below = closedBlockAt(state, pos + 1)
  return below && below.from === pos + 1 ? select(below) : null
}

/** Return with a block selected makes a line under it, and the caret goes there. */
export function blockEnter(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null
  const selected = selectedBlock(state)
  if (!selected) return null
  return {
    changes: { from: selected.to, insert: '\n' },
    selection: { anchor: selected.to + 1 },
    userEvent: 'input',
    scrollIntoView: true,
  }
}

/**
 * Where an up or down arrow lands: `target` is where the caret would go. A
 * move off a line into the closed block right under it enters its source at
 * its start, and one into the block right over it at its end.
 */
export function enterBlock(
  state: EditorState,
  range: SelectionRange,
  target: number,
  forward: boolean,
): number {
  const line = state.doc.lineAt(range.head)
  if (forward ? target <= line.to : target >= line.from) return target
  const edge = forward ? line.to + 1 : line.from - 1
  if (edge < 0 || edge > state.doc.length) return target
  const block = closedBlockAt(state, edge)
  if (!block || edge !== (forward ? block.from : block.to)) return target
  return forward ? block.from : block.to
}
