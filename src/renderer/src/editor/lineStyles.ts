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
import { BOX_HANG, BOX_MARGIN, BOX_PAD } from './boxes'

/** One piece of styling: a class on whole lines from `from` to `to`, or on that text. */
export interface LineStyle {
  from: number
  to: number
  className: string
  line: boolean
}

/** `[!KIND]` alone on the first line of a quote, as the preview reads an alert. */
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

/** The styling of the Markdown between `from` and `to` (whole blocks that touch it). */
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
        if (level <= 3) lines(node.from, node.to, `cm-md-heading cm-md-h${level}`)
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

/** The decorations for some styling: line classes on each line, marks on the text. */
export function decorationsFor(state: EditorState, styles: LineStyle[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const lineClasses = new Map<number, string[]>()
  for (const style of styles) {
    if (!style.line) {
      ranges.push(Decoration.mark({ class: style.className }).range(style.from, style.to))
      continue
    }
    const end = state.doc.lineAt(style.to).number
    for (let n = state.doc.lineAt(style.from).number; n <= end; n++) {
      const at = state.doc.line(n).from
      lineClasses.set(at, [...(lineClasses.get(at) ?? []), style.className])
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
  return decorationsFor(view.state, unique)
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

/**
 * The gutter beside a large heading's lines: its line number (and fold
 * chevron) moves down onto the heading's baseline. A line's text sits
 * 0.75 of its size plus half its font's ascent less its descent below the
 * line's top (line height 1.5); 1.1 of the size difference is that for the
 * editor's fonts.
 */
class HeadingGutter extends GutterMarker {
  override elementClass: string
  constructor(level: 1 | 2 | 3) {
    super()
    this.elementClass = `cm-md-gutter-h${level}`
  }
}
const headingGutters = { 1: new HeadingGutter(1), 2: new HeadingGutter(2), 3: new HeadingGutter(3) }

/** The gutter beside a table's first line: padded as that line is, level with its text. */
class TableGutter extends GutterMarker {
  override elementClass = 'cm-md-gutter-table'
}
const tableGutter = new TableGutter()

/** The gutter's classes in `from` to `to`: every line of a heading of levels 1 to 3, and each table's first line. */
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
      if (level < 1 || level > 3) return undefined
      touch(ref.from, ref.to)
      const marker = headingGutters[level as 1 | 2 | 3]
      for (let at = ref.from; at <= ref.to;) {
        const line = state.doc.lineAt(at)
        mark(line.from, marker)
        at = line.to + 1
      }
      return false
    },
  })
}

/** The gutter's classes: every line of a heading of levels 1 to 3, and each table's first line. */
export function markdownGutterLines(state: EditorState): RangeSet<GutterMarker> {
  return scanMarkers(state, scanMarkdownGutter)
}

const headingGutter = markerField(scanMarkdownGutter)

const token = (name: string) => `var(--color-${name})`
/** A heading size, grown and shrunk with the editor's text (13 px is 1). */
const headingSize = (level: 1 | 2 | 3) =>
  `calc(var(--font-size-editor-h${level}) * var(--preview-scale, 1))`
const BOX_BORDER = `1px solid ${token('code-block-border')}`

const alertColours = Object.fromEntries(
  ALERT_KINDS.flatMap((kind) => [
    [`.cm-md-alert-${kind}.cm-md-quote`, { borderLeftColor: token(`alert-${kind}`) }],
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
const gutterDrop = (level: 1 | 2 | 3) => ({
  boxSizing: 'border-box',
  paddingTop: `calc((${headingSize(level)} - var(--editor-font-size, var(--font-size-body))) * 1.1)`,
})

const theme = EditorView.theme({
  '.cm-md-h1': { fontSize: headingSize(1) },
  '.cm-md-h2': { fontSize: headingSize(2) },
  '.cm-md-h3': { fontSize: headingSize(3) },
  '.cm-gutterElement.cm-md-gutter-h1': gutterDrop(1),
  '.cm-gutterElement.cm-md-gutter-h2': gutterDrop(2),
  '.cm-gutterElement.cm-md-gutter-h3': gutterDrop(3),
  '.cm-gutterElement.cm-md-gutter-table': {
    boxSizing: 'border-box',
    paddingTop: `calc(${BOX_MARGIN} + ${BOX_PAD})`,
  },
  '.cm-md-list-alt, .cm-md-list-alt *': { color: token('syntax-list-alt') },
  '.cm-md-task-done, .cm-md-task-done *': { textDecoration: 'line-through' },
  '.cm-md-code': {
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
  // The bar hangs past the line's side as a box does (boxes.ts): it lines up
  // with a code block's or a table's edge, and the text stays where it was.
  '.cm-md-quote': {
    marginLeft: `calc(-1 * ${BOX_HANG})`,
    borderLeft: `3px solid ${token('editor-quote-bar')}`,
    paddingLeft: `calc(var(--space-4) + ${BOX_HANG})`,
  },
  '.cm-md-alert-label, .cm-md-alert-label *': { textDecoration: 'none' },
  ...alertColours,
  // The same box as a fenced code block's (codeBlocks.ts), drawn behind the text.
  '.cm-md-table': { position: 'relative', zIndex: '0' },
  '.cm-md-table::before': {
    content: '""',
    position: 'absolute',
    inset: `0 calc(-1 * ${BOX_HANG})`,
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

/** The editor's Markdown shapes: the decorations and their styles. */
export const markdownLineStyles = [plugin, headingGutter, theme]
