// Write mode's rules for inline Markdown marks: which source characters an
// element without the selection hides, and what stands in their place (a
// bullet, a checkbox, an alert's label, a note's title). Pure: read from the
// syntax tree and the selection, so the rules are tested over Markdown
// without an editor. Blocks shown otherwise (tables, code, rendered images,
// formulas and diagrams) keep their source here: `SOURCE_BLOCKS` and the
// rendered blocks of blockRanges.ts, whose widgets come from `writeBlockRule`
// (blocks.ts).
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { noteIdOf } from '../../../../core/links'
import { ALERT_KINDS, type AlertKind } from '../blocks'
import { writeBlocksOf, type WriteBlock } from './blockRanges'

export type WriteRange =
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'bullet'; from: number; to: number; depth: number }
  | { kind: 'task'; from: number; to: number; box: number; done: boolean }
  | { kind: 'alert'; from: number; to: number; alert: AlertKind }
  | { kind: 'noteTitle'; from: number; to: number; id: string }
  | { kind: 'mark'; from: number; to: number; className: string }
  | { kind: 'line'; from: number; to: number; className: string }
  | { kind: 'unit'; from: number; to: number }

/** The selection's ranges that show source, in order and apart; a caret has `from === to`. */
export type Selected = readonly { from: number; to: number }[]

/** Lines shown as source, as 1-based first and last line numbers, in order and apart. */
export type Revealed = readonly { first: number; last: number }[]

/**
 * The selection's ranges. A caret counts only while the editor has the
 * keyboard, so a note just opened reads as a document; a selection always
 * counts, so what Find or a command selects shows its marks.
 */
export function selectedRanges(state: EditorState, focused: boolean): Selected {
  const spans = state.selection.ranges
    .filter((range) => focused || !range.empty)
    .map(({ from, to }) => ({ from, to }))
    .sort((a, b) => a.from - b.from)
  const merged: { from: number; to: number }[] = []
  for (const span of spans) {
    const prev = merged[merged.length - 1]
    if (prev && span.from <= prev.to) prev.to = Math.max(prev.to, span.to)
    else merged.push(span)
  }
  return merged
}

/** Whether a selected range meets `from`..`to`, its edges included. */
export function touches(selected: Selected, from: number, to: number): boolean {
  let lo = 0
  let hi = selected.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((selected[mid] as { to: number }).to < from) lo = mid + 1
    else hi = mid
  }
  const span = selected[lo]
  return span !== undefined && span.from <= to
}

export const selectedKey = (selected: Selected) =>
  selected.map((s) => `${s.from}-${s.to}`).join(',')

/** The lines the selected ranges are on: block rules reveal a block by its lines. */
export function revealedLines(state: EditorState, focused: boolean): Revealed {
  const merged: { first: number; last: number }[] = []
  for (const span of selectedRanges(state, focused)) {
    const first = state.doc.lineAt(span.from).number
    const last = state.doc.lineAt(span.to).number
    const prev = merged[merged.length - 1]
    if (prev && first <= prev.last + 1) prev.last = Math.max(prev.last, last)
    else merged.push({ first, last })
  }
  return merged
}

function inBlock(blocks: readonly WriteBlock[], pos: number): boolean {
  let lo = 0
  let hi = blocks.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const block = blocks[mid] as WriteBlock
    if (pos < block.from) hi = mid - 1
    else if (pos > block.to) lo = mid + 1
    else return true
  }
  return false
}

export function isRevealed(revealed: Revealed, line: number): boolean {
  let lo = 0
  let hi = revealed.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const span = revealed[mid] as { first: number; last: number }
    if (line < span.first) hi = mid - 1
    else if (line > span.last) lo = mid + 1
    else return true
  }
  return false
}

/** Shown as their source; tables are rendered in place by a later step of Write mode. */
export const SOURCE_BLOCKS = new Set([
  'FencedCode',
  'CodeBlock',
  'Table',
  'HTMLBlock',
  'CommentBlock',
  'ProcessingInstructionBlock',
  'LinkReference',
  'FrontMatter',
  'Image',
])

const HEADING = /^ATXHeading[1-6]$/
const SETEXT = /^SetextHeading[12]$/
const ALERT_LABEL = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i
const MARK_OPEN = /^<mark(?:\s[^>]*)?>$/i
const MARK_CLOSE = /^<\/mark\s*>$/i
const LISTS = new Set(['BulletList', 'OrderedList'])
const SPACE = /[ \t]/

function listDepth(node: SyntaxNode): number {
  let depth = 0
  for (let at: SyntaxNode | null = node.parent; at; at = at.parent) if (LISTS.has(at.name)) depth++
  return depth
}

/**
 * The Write mode ranges of `from`..`to`. Each element (a span, a link, a
 * heading's marks, a rule) shows its source while a `selected` range meets
 * it; list marks, task boxes and quote marks never do.
 */
export function writeRanges(
  state: EditorState,
  tree: Tree,
  selected: Selected,
  from = 0,
  to = state.doc.length,
): WriteRange[] {
  const doc = state.doc
  const out: WriteRange[] = []
  const rendered = writeBlocksOf(state, tree)
  const text = (a: number, b: number) => doc.sliceString(a, b)
  const shows = (a: number, b: number) => touches(selected, a, b)
  const showsLines = (a: number, b: number) => shows(doc.lineAt(a).from, doc.lineAt(b).to)
  const oneLine = (a: number, b: number) => b > a && b <= doc.lineAt(a).to && !inBlock(rendered, a)
  const hide = (a: number, b: number) => {
    if (oneLine(a, b)) out.push({ kind: 'hide', from: a, to: b })
  }
  const spaceAfter = (pos: number) => (pos < doc.length && SPACE.test(text(pos, pos + 1)) ? 1 : 0)

  tree.iterate({
    from,
    to,
    enter: (ref) => {
      const name = ref.name
      if (SOURCE_BLOCKS.has(name)) return false
      // A rendered block's source shows as written when it opens, on every line.
      if (name !== 'Document' && inBlock(rendered, ref.from)) return false
      const node = ref.node
      if (HEADING.test(name)) {
        if (showsLines(node.from, node.to)) return
        const open = node.firstChild
        if (open?.name === 'HeaderMark' && open.from === node.from) {
          hide(open.from, open.to + spaceAfter(open.to))
        }
        const close = node.lastChild
        if (close && close.from !== open?.from && close.name === 'HeaderMark') {
          let start = close.from
          while (start > node.from && SPACE.test(text(start - 1, start))) start--
          hide(start, close.to)
        }
        return
      }
      if (SETEXT.test(name)) {
        const underline = node.lastChild
        if (underline?.name === 'HeaderMark' && !showsLines(node.from, node.to))
          hide(underline.from, underline.to)
        return
      }
      switch (name) {
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark': {
          const span = node.parent
          if (span && !shows(span.from, span.to)) hide(node.from, node.to)
          return
        }
        case 'Escape':
          if (!shows(node.from, node.to)) hide(node.from, node.from + 1)
          return
        case 'QuoteMark':
          hide(node.from, node.to + spaceAfter(node.to))
          return
        case 'Blockquote': {
          const first = doc.lineAt(node.from)
          const label = first.text.slice(node.from - first.from).replace(/^>[ \t]?/, '')
          const kind = ALERT_LABEL.exec(label)?.[1]?.toLowerCase() as AlertKind | undefined
          if (!kind || !ALERT_KINDS.includes(kind) || shows(first.from, first.to)) return
          const start = first.from + first.text.indexOf('[')
          out.push({ kind: 'alert', from: start, to: start + kind.length + 3, alert: kind })
          return
        }
        case 'ListMark':
          listMark(node)
          return
        case 'TaskMarker':
          // A bullet list's task is drawn with its list mark (`listMark`).
          if (node.parent?.parent?.parent?.name !== 'BulletList') task(node.from, node)
          return
        case 'HorizontalRule':
          if (!showsLines(node.from, node.to) && oneLine(node.from, node.to)) {
            hide(node.from, node.to)
            out.push({ kind: 'line', from: node.from, to: node.from, className: 'cm-wm-rule' })
          }
          return
        case 'HTMLTag': {
          if (!MARK_OPEN.test(text(node.from, node.to))) return
          let close = node.nextSibling
          while (
            close &&
            !(close.name === 'HTMLTag' && MARK_CLOSE.test(text(close.from, close.to)))
          )
            close = close.nextSibling
          if (!close || shows(node.from, close.to)) return
          hide(node.from, node.to)
          hide(close.from, close.to)
          return
        }
        case 'Autolink':
          if (!shows(node.from, node.to))
            for (const mark of node.getChildren('LinkMark')) hide(mark.from, mark.to)
          return false
        case 'Link':
          return link(node)
      }
      return
    },
  })

  function task(start: number, marker: SyntaxNode) {
    if (!oneLine(start, marker.to)) return
    const done = /x/i.test(text(marker.from, marker.to))
    out.push({ kind: 'task', from: start, to: marker.to, box: marker.from, done })
  }

  /** A list's mark is never source: a bullet drawn over it, or a number, and the caret passes it as one unit. */
  function listMark(node: SyntaxNode) {
    const item = node.parent
    const list = item?.parent?.name
    if (list === 'BulletList') {
      const marker = item?.getChild('Task')?.getChild('TaskMarker')
      if (marker && marker.from > node.from) {
        task(node.from, marker)
        return
      }
      out.push({ kind: 'bullet', from: node.from, to: node.to, depth: listDepth(node) })
    } else if (list !== 'OrderedList') return
    const end = node.to + spaceAfter(node.to)
    if (oneLine(node.from, end)) out.push({ kind: 'unit', from: node.from, to: end })
  }

  /** An inline link or a full reference: a shortcut reference (`[text]`) may be literal brackets, so it stays. */
  function link(node: SyntaxNode): false | undefined {
    const marks = node.getChildren('LinkMark')
    const open = marks[0]
    const close = marks[1]
    const url = node.getChild('URL')
    if (!open || !close || open.from !== node.from || (!url && !node.getChild('LinkLabel'))) return
    if (shows(node.from, node.to)) return false
    const id = url ? noteIdOf(text(url.from, url.to)) : undefined
    if (id && close.from === open.to) {
      if (oneLine(node.from, node.to))
        out.push({ kind: 'noteTitle', from: node.from, to: node.to, id })
      return false
    }
    if (!oneLine(open.from, open.to) || !oneLine(close.from, node.to)) return
    hide(open.from, open.to)
    hide(close.from, node.to)
    if (id) out.push({ kind: 'mark', from: open.to, to: close.from, className: 'cm-wm-note-chip' })
    return
  }

  return out
}
