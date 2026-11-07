// Write mode's rules for inline Markdown marks: which source characters an
// element without the selection hides, and what stands in their place (a
// bullet, a checkbox, an alert's label, a note's title, an emoji). Pure: read from the
// syntax tree and the selection, so the rules are tested over Markdown
// without an editor. Blocks shown otherwise (tables, code, rendered images,
// formulas and diagrams) keep their source here: `SOURCE_BLOCKS` and the
// rendered blocks of blockRanges.ts, whose widgets come from `writeBlockRule`
// (blocks.ts).
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { noteIdOf } from '../../../../core/links'
import { codeLanguage, parseCodeInfo } from '../../../../core/preview/code'
import { isInlineTex } from '../../../../core/preview/math'
import { ALERT_KINDS, type AlertKind } from '../blocks'
import { writeBlocksOf, type WriteBlock } from './blockRanges'
import { touches, type Selected } from './selection'
import { FOOTNOTE_DEFINITION, FOOTNOTE_REF, footnoteKey, footnoteNumbers } from './footnotes'

export type WriteRange =
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'bullet'; from: number; to: number; depth: number }
  | { kind: 'task'; from: number; to: number; box: number; done: boolean }
  | { kind: 'alert'; from: number; to: number; alert: AlertKind }
  | { kind: 'noteTitle'; from: number; to: number; id: string }
  | { kind: 'codeLanguage'; from: number; to: number; label: string }
  | { kind: 'footnote'; from: number; to: number; number: number; definition: boolean }
  | { kind: 'mark'; from: number; to: number; className: string }
  | { kind: 'line'; from: number; to: number; className: string }
  | { kind: 'unit'; from: number; to: number }
  | { kind: 'inline'; from: number; to: number; source: string }

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

/** Shown as their source. A table's cells take marks like a paragraph (tableGrid.ts draws the grid). */
const SOURCE_BLOCKS = new Set([
  'FencedCode',
  'CodeBlock',
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
const INLINE_HTML = /^<(kbd|sup|sub)(?:\s[^>]*)?>$/i
const INLINE_HTML_TAGS = {
  kbd: [/^<kbd(?:\s[^>]*)?>$/i, /^<\/kbd\s*>$/i],
  sup: [/^<sup(?:\s[^>]*)?>$/i, /^<\/sup\s*>$/i],
  sub: [/^<sub(?:\s[^>]*)?>$/i, /^<\/sub\s*>$/i],
} as const
// Inside a drawn element these could be taller than its line.
const NOT_INLINE = new Set(['HTMLTag', 'Image'])
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
  // The end of an inline element whose content is drawn or shown with it.
  let inside = -1

  tree.iterate({
    from,
    to,
    enter: (ref) => {
      if (ref.from < inside) return false
      const name = ref.name
      if (name === 'Paragraph' || name === 'LinkReference') {
        if (footnoteDefinition(ref.node) && name === 'LinkReference') return false
      }
      if (name === 'FencedCode' && !inBlock(rendered, ref.from)) {
        fences(ref.node)
        return false
      }
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
        case 'HighlightMark':
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
          const tag = text(node.from, node.to)
          if (MARK_OPEN.test(tag)) {
            const close = closingTag(node, MARK_OPEN, MARK_CLOSE)
            if (!close || shows(node.from, close.to)) return
            hide(node.from, node.to)
            hide(close.from, close.to)
            return
          }
          const element = INLINE_HTML.exec(tag)?.[1]?.toLowerCase() as
            | keyof typeof INLINE_HTML_TAGS
            | undefined
          const close = element && closingTag(node, ...INLINE_HTML_TAGS[element])
          if (!close) return
          inside = close.to
          if (!holds(node.to, close.from, NOT_INLINE)) inline(node.from, close.to)
          return
        }
        case 'Emoji':
          inline(node.from, node.to)
          return
        case 'InlineMath':
          if (isFormula(node)) inline(node.from, node.to)
          return false
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

  // An element the preview's renderers draw: an emoji, a formula, `<kbd>`, `<sup>`, `<sub>`.
  function inline(a: number, b: number) {
    if (!shows(a, b) && oneLine(a, b))
      out.push({ kind: 'inline', from: a, to: b, source: text(a, b) })
  }

  // One space comes off both ends first, as the preview's parser does.
  function isFormula(node: SyntaxNode): boolean {
    const marks = node.getChildren('InlineMathMark')
    let tex = text(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to)
    if (/^[ \n].*[ \n]$/s.test(tex) && tex.trim() !== '') tex = tex.slice(1, -1)
    return isInlineTex(tex)
  }

  // Tags of the same element between them are counted.
  function closingTag(open: SyntaxNode, opens: RegExp, closes: RegExp): SyntaxNode | null {
    let depth = 0
    for (let at = open.nextSibling; at; at = at.nextSibling) {
      if (at.name !== 'HTMLTag') continue
      const tag = text(at.from, at.to)
      if (opens.test(tag)) depth++
      else if (closes.test(tag) && depth-- === 0) return at
    }
    return null
  }

  function holds(a: number, b: number, names: ReadonlySet<string>): boolean {
    let found = false
    tree.iterate({
      from: a,
      to: b,
      enter: (ref) => {
        if (found) return false
        if (ref.from >= a && ref.to <= b && names.has(ref.name)) found = true
        return
      },
    })
    return found
  }

  /** The box stands in for the space after the marker too, so the item's text starts where the box's gap ends. */
  function task(start: number, marker: SyntaxNode) {
    const end = marker.to + spaceAfter(marker.to)
    if (!oneLine(start, end)) return
    const done = /x/i.test(text(marker.from, marker.to))
    out.push({ kind: 'task', from: start, to: end, box: marker.from, done })
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

  /** Whether the character at `pos` follows an odd run of backslashes. */
  function escapedAt(pos: number): boolean {
    const start = doc.lineAt(pos).from
    let slashes = 0
    for (let at = pos - 1; at >= start && text(at, at + 1) === '\\'; at--) slashes++
    return slashes % 2 === 1
  }

  /**
   * A code block's fences turn transparent, so their lines keep the height they have as source (a long
   * info string wraps the same); the opening line names the language. Only the fences in view are drawn.
   */
  function fences(node: SyntaxNode) {
    if (showsLines(node.from, node.to)) return
    const marks = node.getChildren('CodeMark')
    const open = marks[0]
    if (!open || open.from !== node.from) return
    const first = doc.lineAt(open.from)
    const inView = (a: number, b: number) => b >= from && a <= to && oneLine(a, b)
    if (inView(open.from, first.to)) {
      out.push({ kind: 'mark', from: open.from, to: first.to, className: 'cm-wm-fence' })
      const info = node.getChild('CodeInfo')
      const language = info ? parseCodeInfo(text(info.from, info.to)).language : null
      if (language)
        out.push({
          kind: 'codeLanguage',
          from: first.to,
          to: first.to,
          label: codeLanguage(language).name,
        })
    }
    const close = marks.length > 1 ? marks[marks.length - 1] : undefined
    const last = close && close.from > first.to ? doc.lineAt(close.from) : null
    if (close && last && inView(close.from, last.to))
      out.push({ kind: 'mark', from: close.from, to: last.to, className: 'cm-wm-fence' })
  }

  /** A footnote with a definition: its number. */
  function footnoteNumber(label: string): number | undefined {
    return footnoteNumbers(doc).get(footnoteKey(label))
  }

  /** `[^label]: ` at the start of a paragraph or a link reference: drawn as its number while its lines are not selected. */
  function footnoteDefinition(node: SyntaxNode): boolean {
    const match = FOOTNOTE_DEFINITION.exec(text(node.from, doc.lineAt(node.from).to))
    if (!match || escapedAt(node.from)) return false
    const number = footnoteNumber(match[1] as string)
    if (number === undefined) return false
    const end = node.from + match[0].length
    if (!showsLines(node.from, node.to) && oneLine(node.from, end))
      out.push({ kind: 'footnote', from: node.from, to: end, number, definition: true })
    return true
  }

  /** `[^label]` with a definition, drawn as its number; `[^label]:` opens a definition. */
  function footnoteReference(node: SyntaxNode): boolean {
    const label = FOOTNOTE_REF.exec(text(node.from, node.to))?.[1]
    if (label === undefined || footnoteNumber(label) === undefined) return false
    const parent = node.parent
    const opensBlock = parent?.from === node.from && parent.name === 'Paragraph'
    if (opensBlock && text(node.to, node.to + 1) === ':') return true
    if (!shows(node.from, node.to) && oneLine(node.from, node.to)) {
      const number = footnoteNumber(label) as number
      out.push({ kind: 'footnote', from: node.from, to: node.to, number, definition: false })
    }
    return true
  }

  /** `[[text]]` is no link in Devot's Markdown: plain text, brackets and all, as the preview shows it. */
  function doubleBracketed(node: SyntaxNode, close: SyntaxNode): boolean {
    if (close.to !== node.to || node.from < 1) return false
    if (text(node.from - 1, node.from) !== '[' || text(node.to, node.to + 1) !== ']') return false
    out.push({ kind: 'mark', from: node.from, to: node.to, className: 'cm-wm-plain' })
    return true
  }

  /** An inline link or a full reference: a shortcut reference (`[text]`) may be literal brackets, so it stays. */
  function link(node: SyntaxNode): false | undefined {
    if (footnoteReference(node)) return false
    const marks = node.getChildren('LinkMark')
    const open = marks[0]
    const close = marks[1]
    const url = node.getChild('URL')
    if (open && close && !url && !node.getChild('LinkLabel') && doubleBracketed(node, close))
      return false
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
