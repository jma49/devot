// Fenced code blocks in the note editor. Every line of a block, its fences
// included, sits in one box (a line decoration: the top and bottom lines are
// rounded); a fence the note never closes boxes the rest of the note, as the
// parser reads it. The fence's backticks and its info string take the markup
// and heading syntax colours. While the selection is in a block (one not in
// a quote or alert), a copy button in the box's top-right corner copies the
// code without its fences. On an opening fence line, right after the
// backticks, a completion lists the fence languages by alias.
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { startCompletion } from '@codemirror/autocomplete'
import { indentUnit, syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Prec, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
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
import { context, TOOLBAR_PARSE_MS } from './formatContext'
import { withLook } from './popupLook'

/** A line of a fenced block: where it starts, and whether it is the box's top or bottom line. */
export interface CodeBlockLine {
  from: number
  first: boolean
  last: boolean
}

/** The fenced blocks the tree has between `from` and `to`. */
function fencedBlocks(state: EditorState, from: number, to: number): SyntaxNode[] {
  const blocks: SyntaxNode[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name !== 'FencedCode') return undefined
      blocks.push(node.node)
      return false
    },
  })
  return blocks
}

/** The lines of a block, from its opening fence's line to its closing fence's (or its last). */
function blockLines(state: EditorState, block: SyntaxNode): { first: number; last: number } {
  const { doc } = state
  return { first: doc.lineAt(block.from).number, last: doc.lineAt(block.to).number }
}

/** Every line of the fenced blocks between `from` and `to`, in order. */
export function codeBlockLines(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): CodeBlockLine[] {
  const out: CodeBlockLine[] = []
  for (const block of fencedBlocks(state, from, to)) {
    const { first, last } = blockLines(state, block)
    for (let n = first; n <= last; n++) {
      out.push({ from: state.doc.line(n).from, first: n === first, last: n === last })
    }
  }
  return out
}

/** The fenced block around `pos`, if any. */
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
    ]
      .filter(Boolean)
      .join(' '),
  })
const fenceMark = Decoration.mark({ class: 'cm-codeblock-fence' })
const infoMark = Decoration.mark({ class: 'cm-codeblock-info' })

/** How long the copy button shows its check after a copy. */
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

/** The block the selection is in, for its copy button: the main range's both ends inside it. */
function selectedBlock(state: EditorState): SyntaxNode | null {
  const { main } = state.selection
  const block = blockAt(state, main.head)
  if (!block || inQuote(block)) return null
  if (main.from < block.from || main.to > block.to) return null
  return block
}

function decorations(view: EditorView): DecorationSet {
  const { state } = view
  const builder = new RangeSetBuilder<Decoration>()
  const active = selectedBlock(state)
  for (const { from, to } of view.visibleRanges) {
    for (const block of fencedBlocks(state, from, to)) {
      const { first, last } = blockLines(state, block)
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
          lineDeco({ from: line.from, first: n === first, last: n === last }),
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
        syntaxTree(update.state) !== syntaxTree(update.startState)
      )
        this.decorations = decorations(update.view)
    }
  },
  { decorations: (v) => v.decorations },
)

// Languages

/** A fence language: an alias written after the fence, and its display name. */
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

/** Where a fence's language goes: the info string from its start to its end, and the fence. */
export interface FenceInfo {
  /** The fence itself (its backticks or tildes). */
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

// Typing inside

/**
 * Where the cursor is in a block's text, with the block's container prefix
 * (its quote markers, and spaces for its list markers), or null: one empty
 * cursor past the opening fence and before the closing one.
 */
function inBlockText(state: EditorState): { pos: number; prefix: string; body: boolean } | null {
  const { ranges, main } = state.selection
  if (ranges.length > 1 || !main.empty) return null
  const block = blockAt(state, main.head)
  const marks = block?.getChildren('CodeMark') ?? []
  const open = marks[0]
  if (!block || !open || open.from !== block.from || main.head < open.to) return null
  const { doc } = state
  const line = doc.lineAt(main.head)
  const close = marks.length > 1 ? marks.at(-1) : undefined
  if (close && line.number >= doc.lineAt(close.from).number) return null
  const openLine = doc.lineAt(open.from)
  const prefix = openLine.text.slice(0, open.from - openLine.from).replace(/[^>\s]/g, ' ')
  return { pos: main.head, prefix, body: line.number > openLine.number }
}

/** Return in a block: a new line with no indent of its own (only the block's container prefix). */
export function codeReturn(state: EditorState) {
  const at = inBlockText(state)
  if (!at) return null
  const insert = `\n${at.prefix}`
  return {
    changes: { from: at.pos, insert },
    selection: { anchor: at.pos + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  }
}

/** Tab in a block's text: the indent unit at the cursor. */
export function codeTab(state: EditorState) {
  const at = inBlockText(state)
  if (!at?.body) return null
  const insert = state.facet(indentUnit)
  return {
    changes: { from: at.pos, insert },
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
  '@keyframes cm-codeblock-copy-in': {
    from: { opacity: '0', transform: 'scale(0.9)' },
    to: { opacity: '1', transform: 'scale(1)' },
  },
  '.cm-line.cm-codeblock': {
    position: 'relative',
    zIndex: '0',
    fontFamily: 'var(--font-family-mono)',
  },
  // The box is drawn behind the text, inset by the margin on the outer lines.
  '.cm-line.cm-codeblock::before': {
    content: '""',
    position: 'absolute',
    inset: '0',
    zIndex: '-1',
    pointerEvents: 'none',
    background: 'var(--color-code-block-bg)',
    borderInline: '1px solid var(--color-code-block-border)',
  },
  // Above the lines under it: the copy button reaches down over them.
  '.cm-line.cm-codeblock-first': { paddingTop: 'var(--space-2)', zIndex: '1' },
  '.cm-line.cm-codeblock-last': { paddingBottom: 'var(--space-2)' },
  '.cm-line.cm-codeblock-first::before': {
    top: 'var(--space-2)',
    borderTop: '1px solid var(--color-code-block-border)',
    borderTopLeftRadius: 'var(--radius-button)',
    borderTopRightRadius: 'var(--radius-button)',
  },
  '.cm-line.cm-codeblock-last::before': {
    bottom: 'var(--space-2)',
    borderBottom: '1px solid var(--color-code-block-border)',
    borderBottomLeftRadius: 'var(--radius-button)',
    borderBottomRightRadius: 'var(--radius-button)',
  },
  // A highlight span inside a fence keeps the fence's colour.
  '.cm-codeblock-fence, .cm-codeblock-fence *': { color: 'var(--color-syntax-markup)' },
  '.cm-codeblock-info, .cm-codeblock-info *': { color: 'var(--color-syntax-heading)' },
  '.cm-codeblock-copy': {
    position: 'absolute',
    top: 'calc(var(--space-2) + var(--space-2))',
    right: 'var(--space-2)',
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
    animation: 'cm-codeblock-copy-in 0.2s ease-out',
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

/** The code block boxes, fence colours and copy button, for the note editor. */
export function codeBlocks(): Extension {
  return [boxes, typingKeys, theme]
}
