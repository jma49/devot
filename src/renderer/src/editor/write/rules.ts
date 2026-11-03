// Write mode's rules for inline Markdown marks: which source characters a line
// without the caret hides, and what stands in their place (a bullet, a
// checkbox, an alert's label, a note's title). Pure: read from the syntax tree
// and the lines the selection is on, so the rules are tested over Markdown
// without an editor. Blocks the next steps render in place (images, math,
// tables, code) stay source here: `SOURCE_BLOCKS`, and block widgets come from
// `writeBlockRule` (blocks.ts).
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { noteIdOf } from '../../../../core/links'
import { ALERT_KINDS, type AlertKind } from '../blocks'

export type WriteRange =
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'bullet'; from: number; to: number; depth: number }
  | { kind: 'task'; from: number; to: number; done: boolean }
  | { kind: 'alert'; from: number; to: number; alert: AlertKind }
  | { kind: 'noteTitle'; from: number; to: number; id: string }
  | { kind: 'mark'; from: number; to: number; className: string }
  | { kind: 'line'; from: number; to: number; className: string }

/** Lines shown as source, as 1-based first and last line numbers, in order and apart. */
export type Revealed = readonly { first: number; last: number }[]

/**
 * The lines the selection is on. A caret counts only while the editor has the
 * keyboard, so a note just opened reads as a document; a selection always
 * counts, so what Find or a command selects shows its marks.
 */
export function revealedLines(state: EditorState, focused: boolean): Revealed {
  const spans: { first: number; last: number }[] = []
  for (const range of state.selection.ranges) {
    if (range.empty && !focused) continue
    spans.push({
      first: state.doc.lineAt(range.from).number,
      last: state.doc.lineAt(range.to).number,
    })
  }
  spans.sort((a, b) => a.first - b.first)
  const merged: { first: number; last: number }[] = []
  for (const span of spans) {
    const prev = merged[merged.length - 1]
    if (prev && span.first <= prev.last + 1) prev.last = Math.max(prev.last, span.last)
    else merged.push({ ...span })
  }
  return merged
}

export const revealedKey = (revealed: Revealed) =>
  revealed.map((s) => `${s.first}-${s.last}`).join(',')

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

/** Shown as their source in this step; the later steps of Write mode render them in place. */
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

/** The Write mode ranges of the lines in `from`..`to` that `revealed` leaves out. */
export function writeRanges(
  state: EditorState,
  tree: Tree,
  revealed: Revealed,
  from = 0,
  to = state.doc.length,
): WriteRange[] {
  const doc = state.doc
  const out: WriteRange[] = []
  const text = (a: number, b: number) => doc.sliceString(a, b)
  // Every range stays on one line, so a line shows its source or its marks as a whole.
  const hidden = (a: number, b: number) => {
    if (b <= a) return false
    const line = doc.lineAt(a)
    return b <= line.to && !isRevealed(revealed, line.number)
  }
  const hide = (a: number, b: number) => {
    if (hidden(a, b)) out.push({ kind: 'hide', from: a, to: b })
  }
  const spaceAfter = (pos: number) => (pos < doc.length && SPACE.test(text(pos, pos + 1)) ? 1 : 0)

  tree.iterate({
    from,
    to,
    enter: (ref) => {
      const name = ref.name
      if (SOURCE_BLOCKS.has(name)) return false
      const node = ref.node
      if (HEADING.test(name)) {
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
        if (underline?.name === 'HeaderMark') hide(underline.from, underline.to)
        return
      }
      switch (name) {
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark':
          hide(node.from, node.to)
          return
        case 'Escape':
          hide(node.from, node.from + 1)
          return
        case 'QuoteMark':
          hide(node.from, node.to + spaceAfter(node.to))
          return
        case 'Blockquote': {
          const first = doc.lineAt(node.from)
          const label = first.text.slice(node.from - first.from).replace(/^>[ \t]?/, '')
          const kind = ALERT_LABEL.exec(label)?.[1]?.toLowerCase() as AlertKind | undefined
          if (!kind || !ALERT_KINDS.includes(kind)) return
          const start = first.from + first.text.indexOf('[')
          const end = start + kind.length + 3
          if (hidden(start, end)) out.push({ kind: 'alert', from: start, to: end, alert: kind })
          return
        }
        case 'ListMark': {
          const item = node.parent
          if (item?.parent?.name !== 'BulletList') return
          const task = item.getChild('Task')
          if (task && task.from > node.from) {
            hide(node.from, task.from)
            return
          }
          if (hidden(node.from, node.to)) {
            out.push({ kind: 'bullet', from: node.from, to: node.to, depth: listDepth(node) })
          }
          return
        }
        case 'TaskMarker':
          if (hidden(node.from, node.to)) {
            const done = /x/i.test(text(node.from, node.to))
            out.push({ kind: 'task', from: node.from, to: node.to, done })
          }
          return
        case 'HorizontalRule':
          if (hidden(node.from, node.to)) {
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
          if (!close) return
          hide(node.from, node.to)
          hide(close.from, close.to)
          return
        }
        case 'Autolink':
          for (const mark of node.getChildren('LinkMark')) hide(mark.from, mark.to)
          return false
        case 'Link':
          return link(node)
      }
      return
    },
  })

  /** An inline link or a full reference: a shortcut reference (`[text]`) may be literal brackets, so it stays. */
  function link(node: SyntaxNode): false | undefined {
    const marks = node.getChildren('LinkMark')
    const open = marks[0]
    const close = marks[1]
    const url = node.getChild('URL')
    if (!open || !close || open.from !== node.from || (!url && !node.getChild('LinkLabel'))) return
    const id = url ? noteIdOf(text(url.from, url.to)) : undefined
    if (id && close.from === open.to) {
      if (hidden(node.from, node.to))
        out.push({ kind: 'noteTitle', from: node.from, to: node.to, id })
      return false
    }
    if (!hidden(open.from, open.to) || !hidden(close.from, node.to)) return
    hide(open.from, open.to)
    hide(close.from, node.to)
    if (id) out.push({ kind: 'mark', from: open.to, to: close.from, className: 'cm-wm-note-chip' })
    return
  }

  return out
}
