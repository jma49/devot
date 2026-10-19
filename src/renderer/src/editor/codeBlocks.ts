// Fenced code blocks: every line of a block, fences included, sits in one box (a line decoration);
// an unclosed fence boxes the rest of the note, as the parser reads it. While the selection is in a
// block outside a quote or alert, a copy button copies the code without its fences. A completion
// after an opening fence's backticks lists the fence languages by alias.
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { startCompletion } from '@codemirror/autocomplete'
import { indentUnit, syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Prec, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { fuzzyRank } from '../../../core/fuzzy'
import { writeClipboardText } from '../clipboard'
import { t } from '../i18n'
import { iconElement } from '../icons/Icon'
import { blockUnit, codeStyle, nextLine } from './codeIndent'
import { context, TOOLBAR_PARSE_MS } from './formatContext'
import { barsMayShow } from './barRules'
import { markerField, type MarkerScan } from './gutterMarkers'
import { BOX_HANG, BOX_MARGIN, BOX_PAD } from './boxes'
import { buttonIn, motionKeyframes } from './motion'
import { withLook } from './popupLook'
import { toolbarStateExtension } from './toolbarState'

/**
 * A line of a fenced block: where it starts, whether it is the box's top or
 * bottom line, and whether it is the closing fence (an unclosed block's last
 * line is code).
 */
export interface CodeBlockLine {
  from: number
  first: boolean
  last: boolean
  closing: boolean
}

function fencedBlocks(state: EditorState, from: number, to: number): SyntaxNode[] {
  const blocks: SyntaxNode[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      // A paragraph holds no block: its inline nodes need no visit.
      if (node.name === 'Paragraph') return false
      if (node.name !== 'FencedCode') return undefined
      blocks.push(node.node)
      return false
    },
  })
  return blocks
}

/**
 * The lines of a block, from its opening fence's line to its closing fence's
 * (or its last), and whether that last line is a closing fence.
 */
function blockLines(
  state: EditorState,
  block: SyntaxNode,
): { first: number; last: number; closed: boolean } {
  const { doc } = state
  const first = doc.lineAt(block.from).number
  const last = doc.lineAt(block.to).number
  const fences = block.getChildren('CodeMark')
  const close = fences.length > 1 ? fences.at(-1) : undefined
  return { first, last, closed: close !== undefined && doc.lineAt(close.from).number === last }
}

export function codeBlockLines(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): CodeBlockLine[] {
  const out: CodeBlockLine[] = []
  for (const block of fencedBlocks(state, from, to)) {
    const { first, last, closed } = blockLines(state, block)
    for (let n = first; n <= last; n++) {
      const line = { first: n === first, last: n === last }
      out.push({ from: state.doc.line(n).from, ...line, closing: line.last && closed })
    }
  }
  return out
}

export function blockAt(state: EditorState, pos: number): SyntaxNode | null {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  )
    if (node.name === 'FencedCode') return node
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  )
    if (node.name === 'FencedCode') return node
  return null
}

/** Whether a block is inside a quote (an alert is one): it shows no copy button there. */
function inQuote(block: SyntaxNode): boolean {
  for (let node = block.parent; node; node = node.parent)
    if (node.name === 'Blockquote') return true
  return false
}

/**
 * The code of a block, without its fences: the lines between them, each
 * without the indentation the opening fence has (a block in a list item).
 */
export function copyText(state: EditorState, block: SyntaxNode): string {
  const { doc } = state
  const marks = block.getChildren('CodeMark')
  const open = marks[0]
  if (!open) return ''
  const openLine = doc.lineAt(open.from)
  const close = marks.length > 1 ? marks.at(-1) : undefined
  const lastLine = close ? doc.lineAt(close.from).number - 1 : doc.lineAt(block.to).number
  const indent = open.from - openLine.from
  const lines: string[] = []
  for (let n = openLine.number + 1; n <= lastLine; n++) {
    const text = doc.line(n).text
    let cut = 0
    while (cut < indent && (text[cut] === ' ' || text[cut] === '\t')) cut++
    lines.push(text.slice(cut))
  }
  return lines.join('\n')
}

const lineDeco = (line: CodeBlockLine) =>
  Decoration.line({
    class: [
      'cm-codeblock',
      line.first ? 'cm-codeblock-first' : '',
      line.last ? 'cm-codeblock-last' : '',
      // Its box sits closer to it (see the theme).
      line.closing ? 'cm-codeblock-closing' : '',
    ]
      .filter(Boolean)
      .join(' '),
  })
const fenceMark = Decoration.mark({ class: 'cm-codeblock-fence' })
const infoMark = Decoration.mark({ class: 'cm-codeblock-info' })

const COPIED_MS = 1000

class CopyButton extends WidgetType {
  constructor(readonly block: number) {
    super()
  }

  override eq(other: CopyButton): boolean {
    return other.block === this.block
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-codeblock-copy'
    button.title = t('editor.copyCodeBlock')
    button.setAttribute('aria-label', t('editor.copyCodeBlock'))
    button.contentEditable = 'false'
    const show = (copied: boolean) => {
      button.replaceChildren(iconElement(copied ? 'check' : 'code.copyBlock', 16))
      button.dataset['state'] = copied ? 'copied' : 'idle'
    }
    show(false)
    // The click keeps the editor's selection and focus.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      const block = blockAt(view.state, view.posAtDOM(button))
      if (!block) return
      writeClipboardText(copyText(view.state, block)).then(
        () => {
          show(true)
          setTimeout(() => show(false), COPIED_MS)
        },
        (e: unknown) => console.warn('W_CODE_COPY_FAILED', e instanceof Error ? e.message : ''),
      )
    })
    return button
  }

  override ignoreEvent(): boolean {
    return true
  }
}

/**
 * The block whose copy button shows: the one the selection is in (the main
 * range's both ends inside it), while the floating bars may show (barRules.ts).
 */
export function copyBlock(state: EditorState): SyntaxNode | null {
  if (!barsMayShow(state)) return null
  const { main } = state.selection
  const block = blockAt(state, main.head)
  if (!block || inQuote(block)) return null
  if (main.from < block.from || main.to > block.to) return null
  return block
}

/**
 * The decorations of the blocks in `ranges` (the view's visible ranges). A
 * fold or a line gap splits the ranges around a block, so two can share it:
 * each block is decorated once.
 */
export function blockDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const active = copyBlock(state)
  const seen = new Set<number>()
  for (const { from, to } of ranges) {
    for (const block of fencedBlocks(state, from, to)) {
      if (seen.has(block.from)) continue
      seen.add(block.from)
      const { first, last, closed } = blockLines(state, block)
      const marks: { from: number; to: number; deco: Decoration }[] = []
      for (const mark of block.getChildren('CodeMark'))
        marks.push({ from: mark.from, to: mark.to, deco: fenceMark })
      const info = block.getChild('CodeInfo')
      if (info) marks.push({ from: info.from, to: info.to, deco: infoMark })
      marks.sort((a, b) => a.from - b.from)
      for (let n = first; n <= last; n++) {
        const line = state.doc.line(n)
        builder.add(
          line.from,
          line.from,
          lineDeco({
            from: line.from,
            first: n === first,
            last: n === last,
            closing: n === last && closed,
          }),
        )
        for (const m of marks)
          if (m.from >= line.from && m.to <= line.to) builder.add(m.from, m.to, m.deco)
        if (n === first && active?.from === block.from)
          builder.add(
            line.to,
            line.to,
            Decoration.widget({ widget: new CopyButton(block.from), side: 1 }),
          )
      }
    }
  }
  return builder.finish()
}

function decorations(view: EditorView): DecorationSet {
  return blockDecorations(view.state, view.visibleRanges)
}

const boxes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorations(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        barsMayShow(update.state) !== barsMayShow(update.startState) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      )
        this.decorations = decorations(update.view)
    }
  },
  { decorations: (v) => v.decorations },
)

/**
 * The gutter beside a block's first line: padded as that line is (the
 * theme), so its number and fold chevron sit level with the opening fence.
 */
class FirstLineGutter extends GutterMarker {
  override elementClass = 'cm-codeblock-gutter-first'
}
const firstLineGutter = new FirstLineGutter()

const scanFirstLines: MarkerScan = (state, from, to, mark, touch) => {
  for (const block of fencedBlocks(state, from, to)) {
    touch(block.from, block.to)
    mark(state.doc.lineAt(block.from).from, firstLineGutter)
  }
}

const gutterLines = markerField(scanFirstLines)

export interface FenceLanguage {
  alias: string
  name: string
}

/** Every alias `@codemirror/language-data` knows (the lower-case name is one), A to Z. */
export const FENCE_LANGUAGES: readonly FenceLanguage[] = (() => {
  const seen = new Set<string>()
  const out: FenceLanguage[] = []
  for (const language of languages) {
    for (const alias of [language.name.toLowerCase(), ...language.alias]) {
      if (seen.has(alias) || /\s/.test(alias)) continue
      seen.add(alias)
      out.push({ alias, name: language.name })
    }
  }
  return out.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0))
})()

/** The languages a query matches, best first (fuzzy, as the palette ranks), with the matched letters. */
export function languageOptions(query: string): (FenceLanguage & { ranges: [number, number][] })[] {
  return fuzzyRank(query, FENCE_LANGUAGES, (l) => l.alias).map(({ item, ranges }) => ({
    ...item,
    ranges,
  }))
}

export interface FenceInfo {
  fence: string
  from: number
  to: number
}

/**
 * The info string of the opening fence the cursor is in or right after,
 * or null: one empty cursor, on a fenced block's first line, past the fence.
 */
export function fenceInfoAt(state: EditorState): FenceInfo | null {
  const { ranges, main } = state.selection
  if (ranges.length > 1 || !main.empty) return null
  const cx = context(state, TOOLBAR_PARSE_MS)
  if (!cx) return null
  const pos = main.head
  const block = blockAt(state, pos)
  const open = block?.firstChild
  if (!block || open?.name !== 'CodeMark' || open.from !== block.from) return null
  const line = state.doc.lineAt(open.from)
  if (pos < open.to || pos > line.to) return null
  const rest = state.sliceDoc(open.to, line.to)
  const end = open.to + (/^\S*/.exec(rest)?.[0].length ?? 0)
  if (pos > end || /\s/.test(state.sliceDoc(open.to, pos))) return null
  return { fence: state.sliceDoc(open.from, open.to), from: open.to, to: end }
}

/**
 * The fence language completion: on an opening fence line, when asked for
 * (Code Block opens it) or once a letter of the language is typed; a fence
 * typed by hand opens nothing on its own.
 */
export function languageSource(cx: CompletionContext): CompletionResult | null {
  if (cx.view?.composing) return null
  const info = fenceInfoAt(cx.state)
  if (!info) return null
  const query = cx.state.sliceDoc(info.from, cx.pos)
  if (!cx.explicit && query === '') return null
  const matches = languageOptions(query)
  if (matches.length === 0) return null
  const matched = new Map<Completion, readonly number[]>()
  const options = matches.map((language): Completion => {
    const option: Completion = withLook(
      {
        label: language.alias,
        displayLabel: `${info.fence}${language.alias}`,
        detail: language.name,
        apply: (view, _c, from) => {
          const now = fenceInfoAt(view.state)
          const to = now ? now.to : from
          view.dispatch({
            changes: { from, to, insert: language.alias },
            selection: { anchor: from + language.alias.length },
            userEvent: 'input.complete',
          })
        },
      },
      { list: 'language' },
    )
    matched.set(
      option,
      language.ranges.flatMap(([a, b]) => [a + info.fence.length, b + info.fence.length]),
    )
    return option
  })
  return {
    from: info.from,
    to: info.to,
    options,
    filter: false,
    getMatch: (c) => matched.get(c) ?? [],
    update: (_current, _from, _to, next) => languageSource(next),
  }
}

/** Opens the language list when the cursor is right after an opening fence (a new block). */
export function openLanguageList(view: EditorView): void {
  if (fenceInfoAt(view.state)) startCompletion(view)
}

/** Where the cursor is in a block's text, with what Return and Tab need of the block. */
interface BlockText {
  pos: number
  /** The block's container prefix (a quote's markers, a list item's indent) as spaces and `>`. */
  prefix: string
  body: boolean
  info: string
  lines: string[]
}

function inBlockText(state: EditorState): BlockText | null {
  const { ranges, main } = state.selection
  if (ranges.length > 1 || !main.empty) return null
  const block = blockAt(state, main.head)
  const marks = block?.getChildren('CodeMark') ?? []
  const open = marks[0]
  if (!block || !open || open.from !== block.from || main.head < open.to) return null
  const { doc } = state
  const line = doc.lineAt(main.head)
  const close = marks.length > 1 ? marks.at(-1) : undefined
  const last = close ? doc.lineAt(close.from).number - 1 : doc.lines
  if (close && line.number > last) return null
  const openLine = doc.lineAt(open.from)
  const prefix = openLine.text.slice(0, open.from - openLine.from).replace(/[^>\s]/g, ' ')
  const body = line.number > openLine.number
  // Left of a body line's container prefix, the default command applies: the
  // caret is outside the block's text.
  if (body && main.head - line.from < prefix.length) return null
  const info = state.sliceDoc(open.to, openLine.to)
  const lines: string[] = []
  for (let n = openLine.number + 1; n <= last; n++)
    lines.push(doc.line(n).text.slice(prefix.length))
  return { pos: main.head, prefix, body, info, lines }
}

function blockIndentUnit(state: EditorState, at: BlockText): string {
  return blockUnit(at.lines) ?? codeStyle(at.info).unit ?? state.facet(indentUnit)
}

/**
 * Return in a block: a new line with the block's container prefix (a quote's
 * or a list item's) and the indent the block's language gives it (see
 * codeIndent.ts): the line's own, a level in after what opens one, a level
 * out after what ends one. Between a pair (brackets, tags) the closing one
 * goes to a line of its own at the line's indent.
 */
export function codeReturn(state: EditorState) {
  const at = inBlockText(state)
  if (!at) return null
  const line = state.doc.lineAt(at.pos)
  const before = line.text.slice(at.prefix.length, at.pos - line.from)
  const after = line.text.slice(at.pos - line.from)
  const { indent, closing } = at.body
    ? nextLine(codeStyle(at.info), blockIndentUnit(state, at), before, after)
    : { indent: '' }
  // Spaces typed at the end of a line that opens a level go.
  const typed = at.body && indent.length > /^[ \t]*/.exec(before)![0].length
  const from = typed ? line.from + at.prefix.length + before.trimEnd().length : at.pos
  const inner = `\n${at.prefix}${indent}`
  const own = /^[ \t]*/.exec(before)![0]
  const insert = closing ? `${inner}\n${at.prefix}${own}` : inner
  return {
    changes: { from: Math.min(from, at.pos), to: at.pos, insert },
    selection: { anchor: Math.min(from, at.pos) + inner.length },
    scrollIntoView: true,
    userEvent: 'input',
  }
}

export function codeTab(state: EditorState) {
  const at = inBlockText(state)
  if (!at?.body) return null
  const insert = blockIndentUnit(state, at)
  return {
    changes: { from: at.pos, to: at.pos, insert },
    selection: { anchor: at.pos + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  }
}

const typingKeys = Prec.highest(
  keymap.of([
    {
      key: 'Enter',
      run: (view) => {
        const tr = codeReturn(view.state)
        if (tr) view.dispatch(tr)
        return tr !== null
      },
    },
    {
      key: 'Tab',
      run: (view) => {
        const tr = codeTab(view.state)
        if (tr) view.dispatch(tr)
        return tr !== null
      },
    },
  ]),
)

const theme = EditorView.theme({
  ...motionKeyframes,
  '.cm-line.cm-codeblock': {
    position: 'relative',
    zIndex: '0',
    fontFamily: 'var(--code-font-family, var(--font-family-mono))',
  },
  // The box is drawn behind the text, inset by the margin on the outer lines.
  // It reaches past the line's sides (as the quote bar does, see lineStyles.ts):
  // the text keeps the note's column, and its inset from the box's side
  // matches the one from its top and bottom.
  '.cm-line.cm-codeblock::before': {
    content: '""',
    position: 'absolute',
    inset: `0 calc(-1 * ${BOX_HANG})`,
    zIndex: '-1',
    pointerEvents: 'none',
    background: 'var(--color-code-block-bg)',
    borderInline: '1px solid var(--color-code-block-border)',
  },
  // Above the lines under it: the copy button reaches down over them.
  '.cm-line.cm-codeblock-first': { paddingTop: `calc(${BOX_MARGIN} + ${BOX_PAD})`, zIndex: '1' },
  '.cm-line.cm-codeblock-last': { paddingBottom: `calc(${BOX_MARGIN} + var(--space-1))` },
  '.cm-line.cm-codeblock-first::before': {
    top: BOX_MARGIN,
    borderTop: '1px solid var(--color-code-block-border)',
    borderTopLeftRadius: 'var(--radius-button)',
    borderTopRightRadius: 'var(--radius-button)',
  },
  '.cm-line.cm-codeblock-last::before': {
    bottom: BOX_MARGIN,
    borderBottom: '1px solid var(--color-code-block-border)',
    borderBottomLeftRadius: 'var(--radius-button)',
    borderBottomRightRadius: 'var(--radius-button)',
  },
  // A closing fence's backticks sit high in their line: the box's bottom comes
  // up a little under them, so they stand as far from it as the opening
  // fence stands from the top.
  '.cm-line.cm-codeblock-closing': { paddingBottom: BOX_MARGIN },
  '.cm-line.cm-codeblock-closing::before': { bottom: `calc(${BOX_MARGIN} + var(--space-1))` },
  '.cm-gutterElement.cm-codeblock-gutter-first': {
    boxSizing: 'border-box',
    paddingTop: `calc(${BOX_MARGIN} + ${BOX_PAD})`,
  },
  '.cm-codeblock-fence, .cm-codeblock-fence *': { color: 'var(--color-syntax-markup)' },
  '.cm-codeblock-info, .cm-codeblock-info *': { color: 'var(--color-syntax-heading)' },
  '.cm-codeblock-copy': {
    position: 'absolute',
    // In the box's corner, as far from its top as from its side.
    top: `calc(${BOX_MARGIN} + var(--space-2))`,
    right: `calc(var(--space-2) - ${BOX_HANG})`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 'var(--space-10)',
    height: 'calc(var(--space-10) - var(--space-1))',
    padding: '0',
    border: '1px solid var(--color-line-control)',
    borderRadius: 'var(--radius-card)',
    background: 'var(--color-fill-button)',
    color: 'var(--color-text-secondary)',
    cursor: 'default',
    animation: buttonIn,
    transition: 'color var(--motion-duration-color) var(--motion-easing-standard)',
  },
  '.cm-codeblock-copy:hover': { color: 'var(--color-text-primary)' },
  '.cm-codeblock-copy[data-state="copied"]': { color: 'var(--color-status-done)' },
  '.cm-codeblock-copy .icon': {
    display: 'inline-block',
    width: 'var(--size-icon-menu)',
    height: 'var(--size-icon-menu)',
    backgroundColor: 'currentColor',
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
  },
})

export function codeBlocks(): Extension {
  return [toolbarStateExtension, boxes, gutterLines, typingKeys, theme]
}
