// Move Line Up/Down and Indent/Outdent on a list item act on the item and every line nested under it.
import { indentLess, indentMore, moveLineDown, moveLineUp } from '@codemirror/commands'
import {
  ChangeSet,
  EditorSelection,
  Text,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { commandContext, indentListItems, quotePrefix, textStart } from './blocks'
import { spec, type Cx } from './formatContext'

const isBlank = (text: string) => text.trim() === ''

interface ListBlock {
  item: SyntaxNode
  /** The item's first line number, and the last one that is not blank. */
  first: number
  last: number
}

/** The list item the selection is in as a whole, unless it reaches into the items nested in it. */
function selectedBlock(cx: Cx): ListBlock | null {
  const { state, tree } = cx
  if (state.selection.ranges.length !== 1) return null
  const { doc } = state
  const range = state.selection.main
  const startLine = doc.lineAt(range.from)
  const from = Math.max(range.from, startLine.from + textStart(startLine))
  const to = Math.max(from, range.to)
  let item: SyntaxNode | null = null
  for (const side of [1, -1] as const) {
    for (let p: SyntaxNode | null = tree.resolveInner(from, side); p && !item; p = p.parent)
      if (p.name === 'ListItem' && p.from <= from && to <= p.to) item = p
    if (item) break
  }
  if (!item) return null
  const first = doc.lineAt(item.from).number
  let last = doc.lineAt(item.to).number
  while (last > first && isBlank(doc.line(last).text)) last--
  const selectedLast = doc.lineAt(to).number
  for (let list = item.firstChild; list; list = list.nextSibling) {
    if (list.name !== 'BulletList' && list.name !== 'OrderedList') continue
    for (let child = list.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'ListItem') continue
      const childFirst = doc.lineAt(child.from).number
      if (childFirst <= selectedLast && doc.lineAt(child.to).number >= startLine.number) return null
    }
  }
  return { item, first, last }
}

function inListBlock(
  act: (cx: Cx, block: ListBlock) => TransactionSpec | null,
  otherwise: (view: EditorView) => boolean,
) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return otherwise(view)
    const cx = commandContext(view.state)
    const block = cx && selectedBlock(cx)
    if (!cx || !block) return otherwise(view)
    const change = act(cx, block)
    if (change) view.dispatch(change)
    return true
  }
}

interface Relabelled {
  text: string
  /** How the block's own text became `text`, to follow the selection through it. */
  changes: ChangeSet
}

/**
 * The block's text with its number replaced by `digits`; lines under it move
 * by the width the number gains or loses, to stay nested in the item.
 */
function relabelled(
  state: EditorState,
  item: SyntaxNode,
  from: number,
  to: number,
  digits: string | undefined,
): Relabelled {
  const { doc } = state
  const text = doc.sliceString(from, to)
  const mark = item.parent?.name === 'OrderedList' ? item.getChild('ListMark') : null
  const same = { text, changes: ChangeSet.empty(text.length) }
  if (!mark || digits === undefined) return same
  const old = doc.sliceString(mark.from, mark.to)
  const next = digits + old.slice(-1)
  if (next === old) return same
  const edits: { from: number; to: number; insert?: string }[] = [
    { from: mark.from - from, to: mark.to - from, insert: next },
  ]
  const delta = next.length - old.length
  const quotes = quotePrefix(doc.lineAt(item.from).text).count
  const firstNumber = doc.lineAt(from).number
  for (let n = firstNumber + 1, end = doc.lineAt(to).number; n <= end; n++) {
    const line = doc.line(n)
    const prefix = quotePrefix(line.text, quotes)
    if (prefix.count < quotes || isBlank(line.text.slice(prefix.length))) continue
    const at = line.from + prefix.length - from
    if (delta > 0) {
      edits.push({ from: at, to: at, insert: ' '.repeat(delta) })
      continue
    }
    let stop = at
    while (stop < at - delta && text.charAt(stop) === ' ') stop++
    edits.push({ from: at, to: stop })
  }
  const changes = ChangeSet.of(edits, text.length)
  return { text: changes.apply(Text.of(text.split('\n'))).toString(), changes }
}

const digitsOf = (state: EditorState, item: SyntaxNode) => {
  const mark = item.parent?.name === 'OrderedList' ? item.getChild('ListMark') : null
  return mark ? state.sliceDoc(mark.from, mark.to - 1) : undefined
}

function moveBlock(dir: -1 | 1) {
  return (cx: Cx, block: ListBlock): TransactionSpec | null => {
    const { state } = cx
    const { doc } = state
    let other = dir < 0 ? block.item.prevSibling : block.item.nextSibling
    // A quote's marks sit between the items of a list in it.
    while (other && other.name !== 'ListItem')
      other = dir < 0 ? other.prevSibling : other.nextSibling
    if (!other) return null
    const otherFirst = doc.lineAt(other.from).number
    let otherLast = doc.lineAt(other.to).number
    while (otherLast > otherFirst && isBlank(doc.line(otherLast).text)) otherLast--
    const mine = { item: block.item, first: block.first, last: block.last }
    const theirs = { item: other, first: otherFirst, last: otherLast }
    const [upper, lower] = dir < 0 ? [theirs, mine] : [mine, theirs]
    const upperFrom = doc.line(upper.first).from
    const upperTo = doc.line(upper.last).to
    const lowerFrom = doc.line(lower.first).from
    const lowerTo = doc.line(lower.last).to
    const gap = doc.sliceString(upperTo, lowerFrom)
    const upperDigits = digitsOf(state, upper.item)
    const lowerDigits = digitsOf(state, lower.item)
    const nowFirst = relabelled(state, lower.item, lowerFrom, lowerTo, upperDigits)
    const nowSecond = relabelled(state, upper.item, upperFrom, upperTo, lowerDigits)
    const insert = nowFirst.text + gap + nowSecond.text

    const movedFrom = dir < 0 ? lowerFrom : upperFrom
    const movedChanges = dir < 0 ? nowFirst.changes : nowSecond.changes
    const movedStart = dir < 0 ? upperFrom : upperFrom + nowFirst.text.length + gap.length
    const follow = (pos: number, assoc: -1 | 1) =>
      movedStart + movedChanges.mapPos(pos - movedFrom, assoc)
    const { anchor, head } = state.selection.main
    const selection = EditorSelection.single(
      anchor === head ? follow(head, 1) : follow(anchor, anchor < head ? 1 : -1),
      follow(head, anchor === head || anchor > head ? 1 : -1),
    )
    return {
      ...spec({ from: upperFrom, to: lowerTo, insert }, selection),
      userEvent: 'move.line',
    }
  }
}

/** Move Line Up: the list item the caret is in and its nested lines swap places with the item above. */
export const moveListBlockUp = inListBlock(moveBlock(-1), moveLineUp)
export const moveListBlockDown = inListBlock(moveBlock(1), moveLineDown)

const indentBlock = (dir: 1 | -1) =>
  inListBlock(
    (cx, block) => indentListItems(cx.state, dir, [block.first]),
    dir > 0 ? indentMore : indentLess,
  )

/** Indent and Outdent: the list item the caret is in moves with its nested lines. */
export const indentListBlock = indentBlock(1)
export const outdentListBlock = indentBlock(-1)
