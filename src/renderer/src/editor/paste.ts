// Pasting in the note editor. A URL pasted over selected text makes it a link; a lone URL goes in as the setting
// says (as copied, an autolink, an empty link, or as copied with the paste chooser open: pasteChooser.ts). Paste as
// Plain Text inserts the clipboard's text as is. This replaces the Markdown language's own paste-as-link, so a
// paste is handled once.
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, Facet, type EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { PasteUrlStyle } from '../../../core/editorSettings'
import {
  containerEnd,
  context,
  inFrontMatter,
  LITERAL_BLOCKS,
  nodeAt,
  type Cx,
} from './formatContext'
import { escapeBangBefore, linkAddress, linkTo } from './formats'
import { chooserOn, chooserPaste, showChooser } from './pasteChooser'

export const pasteUrlStyle = Facet.define<PasteUrlStyle, PasteUrlStyle>({
  combine: (values) => values[0] ?? 'plain',
})

const PASTE_EVENT = 'input.paste'

const URL = /^(?:https?:\/\/|mailto:|devot:\/\/)[^\s]+$/i
const WWW = /^www\.[^\s]+$/i
const AFTER_SCHEME = /^(?:https?:\/\/|mailto:|devot:\/\/)./i

export function pastedUrl(text: string): string | null {
  const url = text.trim()
  if (WWW.test(url)) return `https://${url}`
  return URL.test(url) && AFTER_SCHEME.test(url) ? url : null
}

/** Syntax a pasted URL must not go into as a link: it would nest, or not be Markdown. */
const NO_LINK = new Set([
  ...LITERAL_BLOCKS,
  'InlineCode',
  'Link',
  'Image',
  'Autolink',
  'URL',
  'HTMLTag',
  'Comment',
])

function asCopiedAt(cx: Cx, pos: number): boolean {
  if (inFrontMatter(cx, pos)) return true
  for (let node: SyntaxNode | null = nodeAt(cx, pos); node; node = node.parent) {
    // Inside it, not at its edge (a link may follow another).
    if (NO_LINK.has(node.name) && node.from < pos && pos < node.to) return true
    // A block holds the end of its last line too.
    if (LITERAL_BLOCKS.includes(node.name) && node.from <= pos && pos <= node.to) return true
  }
  return false
}

function urlAtCursors(
  state: EditorState,
  url: string,
  style: PasteUrlStyle,
): TransactionSpec | null {
  if (style === 'plain' || state.selection.ranges.some((r) => !r.empty)) return null
  // The chooser belongs to one cursor; with more, the URL goes in as copied.
  if (style === 'choose') {
    const cx = context(state)
    const one = state.selection.ranges.length === 1
    return one && cx && !asCopiedAt(cx, state.selection.main.head) ? chooserPaste(state, url) : null
  }
  // An autolink cannot hold angle brackets.
  if (style === 'autolink' && /[<>]/.test(url)) return null
  const cx = context(state)
  if (!cx || state.selection.ranges.some((r) => asCopiedAt(cx, r.head))) return null
  // `|` would end a table cell, inside an autolink too.
  const text = style === 'autolink' ? `<${url.replace(/\|/g, '%7C')}>` : `[](${linkAddress(url)})`
  // The cursor goes after an autolink, and into an empty link's text.
  const back = style === 'autolink' ? 0 : text.length - 1
  // A `!` right before an empty link would make it an image.
  const bang = (pos: number) => (style === 'link' ? escapeBangBefore(state, pos) : [])
  return {
    ...state.changeByRange((range) => {
      const changes = state.changes([...bang(range.head), { from: range.head, insert: text }])
      return {
        changes,
        range: EditorSelection.cursor(changes.mapPos(range.head, 1) - back),
      }
    }),
    userEvent: PASTE_EVENT,
    scrollIntoView: true,
  }
}

/**
 * What pasting `text` does beyond the usual paste: a link over the
 * selection, or a lone URL as the setting says. Null when the editor's own
 * paste should run (text that is not one URL, a URL pasted as copied).
 */
export function pasteTransaction(
  state: EditorState,
  text: string,
  style: PasteUrlStyle,
): TransactionSpec | null {
  const url = pastedUrl(text)
  if (url === null) return containedPaste(state, text)
  return state.selection.ranges.some((r) => !r.empty)
    ? linkTo(state, url)
    : urlAtCursors(state, url, style)
}

export function plainPaste(state: EditorState, text: string): TransactionSpec | null {
  if (text === '') return null
  return (
    containedPaste(state, text) ?? {
      ...state.replaceSelection(text),
      userEvent: PASTE_EVENT,
      scrollIntoView: true,
    }
  )
}

function itemTextColumn(state: EditorState, item: SyntaxNode): number {
  const line = state.doc.lineAt(item.from)
  const mark = item.getChild('ListMark')
  if (!mark) return item.from - line.from
  const end = mark.to - line.from
  let spaces = 0
  while (line.text.charAt(end + spaces) === ' ') spaces++
  // CommonMark: one space when the item is empty or its text is indented code.
  return end + (spaces === 0 || spaces > 4 || end + spaces === line.length ? 1 : spaces)
}

/**
 * What keeps a line in the quotes and list items that the line at `pos` is
 * in: their quote markers, and spaces up to the item's text. Null at the top
 * level, or where the line does not carry that prefix itself (a lazy line).
 */
function containerPrefix(cx: Cx, pos: number): { prefix: string; code: boolean } | null {
  const line = cx.state.doc.lineAt(pos)
  let column = 0
  let code = false
  for (let p: SyntaxNode | null = cx.tree.resolveInner(pos, -1); p; p = p.parent) {
    if (p.name === 'FencedCode') code = true
    else if (p.name === 'ListItem') column = Math.max(column, itemTextColumn(cx.state, p))
  }
  // A line's quote markers may sit in the block they hold (fenced code), not in the quote.
  cx.tree.iterate({
    from: line.from,
    to: pos,
    enter(node) {
      if (node.name !== 'QuoteMark' || node.to > pos) return
      const end = node.to - line.from
      column = Math.max(column, end + (line.text.charAt(end) === ' ' ? 1 : 0))
    },
  })
  if (column === 0 || pos - line.from < column || containerEnd(cx, line) < column) return null
  return { prefix: line.text.slice(0, column).replace(/[^>\t]/g, ' '), code }
}

/**
 * Pasted lines that would otherwise leave the list item or quote they go
 * into, and end it: every line of a code block after the first, and in other
 * text the lines from a blank one on. They get the container's prefix. Null,
 * for the usual paste, when no line needs it or there are several ranges.
 */
function containedPaste(state: EditorState, text: string): TransactionSpec | null {
  const lines = text.split(/\r\n?|\n/)
  if (lines.length < 2 || state.selection.ranges.length > 1) return null
  const cx = context(state)
  const { from, to } = state.selection.main
  const container = cx && containerPrefix(cx, from)
  if (!container) return null
  const { prefix, code } = container
  let inside = code
  let changed = false
  const insert = lines
    .map((line, i) => {
      if (i === 0) return line
      if (line.trim() === '') inside = true
      if (!inside) return line
      changed = true
      return line.trim() === '' ? prefix.trimEnd() : prefix + line
    })
    .join('\n')
  if (!changed) return null
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    userEvent: PASTE_EVENT,
    scrollIntoView: true,
  }
}

export const pasteUrls = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData
    if (!data || data.files.length > 0) return false
    const spec = pasteTransaction(
      view.state,
      data.getData('text/plain'),
      view.state.facet(pasteUrlStyle),
    )
    if (!spec) return false
    event.preventDefault()
    view.dispatch(spec)
    showChooser(view)
    return true
  },
})

function linkRangeAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; url: string } | null {
  const tree = syntaxTree(state)
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== 'Link' && node.name !== 'Autolink' && node.name !== 'URL') continue
      // A Link's address is its URL child; `[text]` alone (a reference) has none.
      const urlNode = node.name === 'URL' ? node : node.getChild('URL')
      const parent = node.name === 'URL' ? node.parent : null
      // An image's or a reference definition's address is not a link to reformat.
      if (parent?.name === 'Image' || parent?.name === 'LinkReference') return null
      const link = parent?.name === 'Link' || parent?.name === 'Autolink' ? parent : node
      const url = urlNode && state.sliceDoc(urlNode.from, urlNode.to).replace(/^<|>$/g, '').trim()
      if (url) return { from: link.from, to: link.to, url }
    }
  }
  return null
}

/**
 * Paste URL As…: pastes the clipboard's URL as copied with the chooser open
 * on it, or, when the clipboard holds none that can go here, opens the
 * chooser on the link at the caret. Null when there is neither.
 */
export function pasteUrlAs(state: EditorState, clipboardText: string): TransactionSpec | null {
  const url = pastedUrl(clipboardText)
  const spec = url === null ? null : urlAtCursors(state, url, 'choose')
  if (spec) return spec
  const link = linkRangeAt(state, state.selection.main.head)
  return link && chooserOn(state, link.from, link.to, link.url)
}
