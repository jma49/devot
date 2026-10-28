// How the editor shapes Markdown beyond the colours of the highlight style
// (markdown.ts): heading lines at their own sizes, list marks by depth,
// struck-through done tasks, inline code chips, `<mark>` highlights, quote
// and alert bars, and tables in a box. Everything here is read from the
// syntax tree and drawn as decorations over the source; the text is never
// changed.
import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Range, type RangeSet } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { ALERT_KINDS, type AlertKind } from './blocks'
import { markerField, scanMarkers, type MarkerScan } from './gutterMarkers'
import { BOX_INSET, BOX_MARGIN, BOX_PAD } from './boxes'

export interface LineStyle {
  from: number
  to: number
  className: string
  line: boolean
}

const ALERT_LABEL = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i
const MARK_OPEN = /^<mark(?:\s[^>]*)?>$/i
const MARK_CLOSE = /^<\/mark\s*>$/i
const HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/
const LISTS = new Set(['BulletList', 'OrderedList'])

/** How many lists hold `node`: 1 for a top-level list's mark. */
function listDepth(node: SyntaxNode): number {
  let depth = 0
  for (let at: SyntaxNode | null = node.parent; at; at = at.parent) if (LISTS.has(at.name)) depth++
  return depth
}

export function lineStyles(
  state: EditorState,
  tree: Tree,
  from = 0,
  to = state.doc.length,
): LineStyle[] {
  const out: LineStyle[] = []
  const doc = state.doc
  const text = (node: SyntaxNode) => doc.sliceString(node.from, node.to)
  const lines = (start: number, end: number, className: string) =>
    out.push({ from: start, to: end, className, line: true })
  const mark = (start: number, end: number, className: string) => {
    if (end > start) out.push({ from: start, to: end, className, line: false })
  }

  tree.iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node
      const name = node.name
      const heading = HEADING.exec(name)
      if (heading) {
        const level = Number(heading[1])
        lines(node.from, node.to, `cm-md-heading cm-md-h${level}`)
        return
      }
      switch (name) {
        case 'ListMark':
          if (listDepth(node) % 2 === 0) mark(node.from, node.to, 'cm-md-list-alt')
          return
        case 'Task': {
          const box = node.getChild('TaskMarker')
          if (box && /x/i.test(text(box))) mark(box.to, node.to, 'cm-md-task-done')
          return
        }
        case 'InlineCode': {
          const marks = node.getChildren('CodeMark')
          const open = marks[0]
          const close = marks.length > 1 ? marks[marks.length - 1] : undefined
          // The chip holds the code only; the backticks stay outside it.
          if (open && close) mark(open.to, close.from, 'cm-md-code')
          return false
        }
        case 'HTMLTag': {
          if (!MARK_OPEN.test(text(node))) return
          let close = node.nextSibling
          while (close && !(close.name === 'HTMLTag' && MARK_CLOSE.test(text(close))))
            close = close.nextSibling
          if (!close) return
          mark(node.from, node.to, 'cm-md-mark-tag')
          mark(node.to, close.from, 'cm-md-mark')
          mark(close.from, close.to, 'cm-md-mark-tag')
          return
        }
        case 'Blockquote': {
          const first = doc.lineAt(node.from)
          const label = first.text.slice(node.from - first.from).replace(/^>[ \t]?/, '')
          const kind = ALERT_LABEL.exec(label)?.[1]?.toLowerCase() as AlertKind | undefined
          // A quote inside another is already on the outer one's lines.
          const nested = node.parent?.name === 'Blockquote'
          if (kind && !nested) {
            lines(node.from, node.to, `cm-md-quote cm-md-alert cm-md-alert-${kind}`)
            const start = first.from + first.text.indexOf('[')
            mark(start, start + kind.length + 3, `cm-md-alert-label cm-md-alert-${kind}`)
          } else if (!nested) lines(node.from, node.to, 'cm-md-quote')
          return
        }
        case 'Table': {
          const last = doc.lineAt(node.to)
          lines(node.from, node.to, 'cm-md-table')
          lines(node.from, node.from, 'cm-md-table-first')
          lines(last.from, last.from, 'cm-md-table-last')
          const header = node.getChild('TableHeader')
          if (header) mark(header.from, header.to, 'cm-md-table-header')
          return false
        }
      }
      return
    },
  })
  return out
}

/** Line styles cover only the lines in `shown` (the visible ranges), so a long table costs only its shown rows. */
export function decorationsFor(
  state: EditorState,
  styles: LineStyle[],
  shown: readonly { from: number; to: number }[] = [{ from: 0, to: state.doc.length }],
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const lineClasses = new Map<number, string[]>()
  for (const style of styles) {
    if (!style.line) {
      ranges.push(Decoration.mark({ class: style.className }).range(style.from, style.to))
      continue
    }
    for (const range of shown) {
      const first = state.doc.lineAt(range.from)
      const last = state.doc.lineAt(range.to)
      if (last.to < style.from || first.from > style.to) continue
      const end = Math.min(state.doc.lineAt(style.to).number, last.number)
      for (let n = Math.max(state.doc.lineAt(style.from).number, first.number); n <= end; n++) {
        const at = state.doc.line(n).from
        const classes = lineClasses.get(at)
        if (!classes) lineClasses.set(at, [style.className])
        else if (!classes.includes(style.className)) classes.push(style.className)
      }
    }
  }
  for (const [at, classes] of lineClasses)
    ranges.push(Decoration.line({ class: classes.join(' ') }).range(at))
  return Decoration.set(ranges, true)
}

function build(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state)
  const styles = view.visibleRanges.flatMap(({ from, to }) =>
    lineStyles(view.state, tree, from, to),
  )
  // Two visible ranges can share a block: keep each piece once.
  const seen = new Set<string>()
  const unique = styles.filter((s) => {
    const key = `${s.from}:${s.to}:${s.className}:${s.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return decorationsFor(view.state, unique, view.visibleRanges)
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      )
        this.decorations = build(update.view)
    }
  },
  { decorations: (v) => v.decorations },
)

// Gutter numbers sit on a heading's baseline: with the heading's line height, a baseline
// moves 0.35 of the size difference (half of ascent minus descent in the editor's fonts).
class HeadingGutter extends GutterMarker {
  override elementClass: string
  constructor(level: HeadingLevel) {
    super()
    this.elementClass = `cm-md-gutter-h${level}`
  }
}
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
const LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6]
const headingGutters = Object.fromEntries(
  LEVELS.map((level) => [level, new HeadingGutter(level)]),
) as Record<HeadingLevel, HeadingGutter>

class TableGutter extends GutterMarker {
  override elementClass = 'cm-md-gutter-table'
}
const tableGutter = new TableGutter()

const scanMarkdownGutter: MarkerScan = (state, from, to, mark, touch) => {
  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      if (ref.name === 'Paragraph' || ref.name === 'FencedCode') return false
      if (ref.name === 'Table') {
        touch(ref.from, ref.to)
        mark(state.doc.lineAt(ref.from).from, tableGutter)
        return false
      }
      const level = Number(HEADING.exec(ref.name)?.[1] ?? 0)
      if (level < 1) return undefined
      touch(ref.from, ref.to)
      const marker = headingGutters[level as HeadingLevel]
      for (let at = ref.from; at <= ref.to;) {
        const line = state.doc.lineAt(at)
        mark(line.from, marker)
        at = line.to + 1
      }
      return false
    },
  })
}

export function markdownGutterLines(state: EditorState): RangeSet<GutterMarker> {
  return scanMarkers(state, scanMarkdownGutter)
}

const headingGutter = markerField(scanMarkdownGutter)

const token = (name: string) => `var(--color-${name})`
const BODY_SIZE = 'var(--editor-font-size, var(--font-size-body))'
const headingSize = (level: HeadingLevel) => `calc(var(--note-heading-h${level}) * ${BODY_SIZE})`
const BOX_BORDER = `1px solid ${token('code-block-border')}`
/** A quote's bar, drawn inside the border that holds the text's indent. */
const QUOTE_BAR = '3px'
/** The border: the bar, then the space between it and the text (the rest is padding). */
const QUOTE_INSET = `calc(${QUOTE_BAR} + ${BOX_PAD})`
/** The padding box starts after the border, so the bar sits a border's width before it. */
const QUOTE_BAR_LEFT = `calc(-1 * ${QUOTE_BAR} - ${BOX_PAD})`

const alertColours = Object.fromEntries(
  ALERT_KINDS.flatMap((kind) => [
    [`.cm-md-alert-${kind}.cm-md-quote::before`, { backgroundColor: token(`alert-${kind}`) }],
    [
      `.cm-md-alert-label.cm-md-alert-${kind}, .cm-md-alert-label.cm-md-alert-${kind} *`,
      { color: token(`alert-${kind}`) },
    ],
  ]),
)

/**
 * The styles: a mark's class reaches the highlight spans inside it (`x *`),
 * whose own colour would otherwise win.
 */
const gutterDrop = (level: HeadingLevel) => ({
  boxSizing: 'border-box',
  lineHeight: `calc(${headingSize(level)} * var(--note-line-height-heading))`,
  paddingTop: `max(0px, calc((${headingSize(level)} - ${BODY_SIZE}) * 0.35))`,
})

const headingStyles = Object.fromEntries(
  LEVELS.flatMap((level) => [
    [
      `.cm-md-h${level}`,
      { fontSize: headingSize(level), lineHeight: 'var(--note-line-height-heading)' },
    ],
    [`.cm-gutterElement.cm-md-gutter-h${level}`, gutterDrop(level)],
  ]),
)

const theme = EditorView.theme({
  ...headingStyles,
  '.cm-gutterElement.cm-md-gutter-table': {
    boxSizing: 'border-box',
    paddingTop: `calc(${BOX_MARGIN} + ${BOX_PAD})`,
  },
  '.cm-md-list-alt, .cm-md-list-alt *': { color: token('syntax-list-alt') },
  '.cm-md-task-done, .cm-md-task-done *': { textDecoration: 'line-through' },
  '.cm-md-code': {
    fontFamily: 'var(--code-font-family, var(--font-family-mono))',
    border: `1px solid ${token('editor-code-border')}`,
    backgroundColor: token('editor-code-fill'),
    borderRadius: 'var(--radius-mark)',
    padding: '0 var(--space-1)',
  },
  '.cm-md-mark-tag, .cm-md-mark-tag *': {
    color: token('syntax-markup'),
    fontSize: '0.85em',
  },
  '.cm-md-mark': {
    backgroundColor: token('editor-mark-fill'),
    borderBottom: `2px solid ${token('editor-mark-line')}`,
  },
  // The bar sits on the text column, the same edge as a code block's box.
  // Its width and the indent it needs are a transparent border, shifted by
  // the line's padding, so that padding stays the one every line shares:
  // CodeMirror sizes a selection's full rows from the first line's padding.
  '.cm-md-quote': {
    position: 'relative',
    marginLeft: BOX_PAD,
    borderLeft: `${QUOTE_INSET} solid transparent`,
    paddingLeft: BOX_PAD,
  },
  '.cm-md-quote::before': {
    content: '""',
    position: 'absolute',
    top: '0',
    bottom: '0',
    left: QUOTE_BAR_LEFT,
    width: QUOTE_BAR,
    backgroundColor: token('editor-quote-bar'),
    pointerEvents: 'none',
  },
  '.cm-md-alert-label, .cm-md-alert-label *': { textDecoration: 'none' },
  ...alertColours,
  '.cm-md-table': {
    position: 'relative',
    zIndex: '0',
    paddingLeft: `calc(${BOX_PAD} + ${BOX_INSET})`,
    paddingRight: `calc(${BOX_PAD} + ${BOX_INSET})`,
  },
  '.cm-md-table::before': {
    content: '""',
    position: 'absolute',
    inset: `0 ${BOX_PAD}`,
    zIndex: '-1',
    pointerEvents: 'none',
    backgroundColor: token('code-block-bg'),
    borderLeft: BOX_BORDER,
    borderRight: BOX_BORDER,
  },
  '.cm-md-table-first': { paddingTop: `calc(${BOX_MARGIN} + ${BOX_PAD})` },
  '.cm-md-table-last': { paddingBottom: `calc(${BOX_MARGIN} + ${BOX_PAD})` },
  '.cm-md-table-first::before': {
    top: BOX_MARGIN,
    borderTop: BOX_BORDER,
    borderTopLeftRadius: 'var(--radius-button)',
    borderTopRightRadius: 'var(--radius-button)',
  },
  '.cm-md-table-last::before': {
    bottom: BOX_MARGIN,
    borderBottom: BOX_BORDER,
    borderBottomLeftRadius: 'var(--radius-button)',
    borderBottomRightRadius: 'var(--radius-button)',
  },
  '.cm-md-table-header': { fontWeight: 'var(--font-weight-bold)' },
})

export const markdownLineStyles = [plugin, headingGutter, theme]
