// Write mode's rendered blocks: which lines an image, a formula, a diagram or
// an embed takes, whether the selection opens it, and how the arrows and
// Backspace treat a closed one. Pure: read from the syntax tree and the
// selection, so the rules are tested over Markdown without an editor.
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type Text,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { videoEmbedUrl } from '../../../../core/preview/builtins'
import { findImages } from '../images'
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

const cache = new WeakMap<Text, { tree: Tree; blocks: WriteBlock[] }>()

/** Every rendered block of the note, in order; only blocks at the top level, outside lists and quotes. */
export function writeBlocksOf(state: EditorState, tree = syntaxTree(state)): readonly WriteBlock[] {
  const known = cache.get(state.doc)
  if (known?.tree === tree) return known.blocks
  const blocks = scan(state, tree)
  cache.set(state.doc, { tree, blocks })
  return blocks
}

/** The block of the top level that holds `pos`, if any. */
function topAt(tree: Tree, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1)
  while (node?.parent && node.parent.parent) node = node.parent
  return node?.parent ? node : null
}

const CANDIDATE = /^ {0,3}(?:\$\$|```|~~~|<|https:\/\/|!\[)/

/**
 * Reads the text line by line and asks the syntax tree only on lines that may
 * start a block (as images.ts does), which stays cheap on long notes.
 */
function scan(state: EditorState, tree: Tree): WriteBlock[] {
  const doc = state.doc
  const out: WriteBlock[] = []
  const lines: { from: number; text: string }[] = []
  let line = { from: 0, text: '' }
  for (const iter = doc.iter(); !iter.next().done;) {
    if (iter.lineBreak) {
      lines.push(line)
      line = { from: line.from + line.text.length + 1, text: '' }
    } else line.text += iter.value
  }
  lines.push(line)
  const lineEnd = (i: number) => lines[i]!.from + lines[i]!.text.length
  const block = (kind: WriteBlockKind, first: number, last: number, entry: number) => {
    const from = lines[first]!.from
    const to = lineEnd(last)
    out.push({ kind, from, to, entry, source: doc.sliceString(from, to) })
  }
  for (let i = 0; i < lines.length; i++) {
    const { from, text } = lines[i]!
    if (!CANDIDATE.test(text)) continue
    const start = from + text.length - text.trimStart().length
    const node = topAt(tree, start)
    if (!node) continue
    if (node.name === 'FencedCode') {
      if (node.from === start) fence(node, i)
      i = Math.max(i, doc.lineAt(node.to).number - 1)
      continue
    }
    if (node.name === 'HTMLBlock') {
      if (node.from === start) html(node, i)
      i = Math.max(i, doc.lineAt(node.to).number - 1)
      continue
    }
    if (node.name !== 'Paragraph') continue
    const single = node.from === start && node.to <= lineEnd(i)
    // A math fence starts a block inside a paragraph too, as the preview reads it.
    if (MATH_FENCE.test(text)) {
      const close = lines.findIndex((l, n) => n > i && MATH_FENCE.test(l.text))
      if (close < 0) return out
      block('math', i, close, lineEnd(close - i >= 2 ? i + 1 : i))
      i = close
      continue
    }
    if (single && isMathLine(text)) {
      block('math', i, i, lineEnd(i) - 2)
      continue
    }
    const url = single ? EMBED_URL.exec(text)?.[1] : undefined
    if (url && videoEmbedUrl(url)) {
      block('embed', i, i, lineEnd(i) - 1)
      continue
    }
    if (text.includes('![')) imageLine(i)
  }
  return out

  function fence(node: SyntaxNode, i: number) {
    const info = node.getChild('CodeInfo')
    const lang = info
      ? doc.sliceString(info.from, info.to).trim().split(/\s/)[0]?.toLowerCase()
      : ''
    const kind = lang === 'mermaid' ? 'diagram' : lang === 'math' ? 'math' : null
    const last = doc.lineAt(node.to).number - 1
    // An unclosed fence runs to the end of the note: it stays source while it is being written.
    if (!kind || node.getChildren('CodeMark').length < 2 || last === i) return
    block(kind, i, last, lineEnd(last - i >= 2 ? i + 1 : i))
  }

  function imageLine(i: number) {
    const from = lines[i]!.from
    const to = lineEnd(i)
    const images = findImages(state, from, to)
    if (images.length === 0) return
    let rest = lines[i]!.text
    for (let n = images.length - 1; n >= 0; n--) {
      const image = images[n]!
      if (image.from < from || image.to > to) return
      if (image.fileId === null && !IMAGE_SHOWN.test(image.url)) return
      rest = rest.slice(0, image.from - from) + rest.slice(image.to - from)
    }
    if (rest.trim() !== '') return
    block('image', i, i, imageEntry(images[0]!))
  }

  function html(node: SyntaxNode, i: number) {
    const last = doc.lineAt(node.to).number - 1
    if (!IFRAME.test(doc.sliceString(lines[i]!.from, lineEnd(last)))) return
    block('embed', i, last, lineEnd(last) - 1)
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
export function closedBlockAt(state: EditorState, pos: number): WriteBlock | null {
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
