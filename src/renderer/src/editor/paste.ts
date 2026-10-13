// Pasting in the note editor. A URL pasted over selected text makes that
// text a link to it; a lone URL (nothing selected) goes in as the setting
// says: as copied, as an autolink (`<url>`) or as a link with empty text
// (`[](url)`). Paste as Plain Text inserts the clipboard's text as it is,
// with none of this (nor images). This replaces the Markdown language's own
// paste-as-link, so a paste is handled once.
import { EditorSelection, Facet, type EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { PasteUrlStyle } from '../../../core/editorSettings'
import { context, inFrontMatter, LITERAL_BLOCKS, nodeAt, type Cx } from './formatContext'
import { escapeBangBefore, linkAddress, linkTo } from './formats'

/** How a lone URL is pasted (Settings > Editing); a link by default. */
export const pasteUrlStyle = Facet.define<PasteUrlStyle, PasteUrlStyle>({
  combine: (values) => values[0] ?? 'plain',
})

/** The user event of a paste. */
const PASTE_EVENT = 'input.paste'

/** Schemes a pasted URL may have: web, mail and Devot's own (a copied note URI). */
const URL = /^(?:https?:\/\/|mailto:|devot:\/\/)[^\s]+$/i
const WWW = /^www\.[^\s]+$/i
/** Something after the scheme: `https://` alone is not a URL. */
const AFTER_SCHEME = /^(?:https?:\/\/|mailto:|devot:\/\/)./i

/** The URL a pasted text is, trimmed (`www.` gets `https://`), or null. */
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

/** Whether a lone URL pasted at `pos` must go in as copied. */
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

/** A lone URL at every cursor as an autolink or an empty link; null to paste it as copied. */
function urlAtCursors(
  state: EditorState,
  url: string,
  style: PasteUrlStyle,
): TransactionSpec | null {
  if (style === 'plain' || state.selection.ranges.some((r) => !r.empty)) return null
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
  if (url === null) return null
  return state.selection.ranges.some((r) => !r.empty)
    ? linkTo(state, url)
    : urlAtCursors(state, url, style)
}

/** Paste as Plain Text: the text as it is, over the selection; null for no text. */
export function plainPaste(state: EditorState, text: string): TransactionSpec | null {
  if (text === '') return null
  return { ...state.replaceSelection(text), userEvent: PASTE_EVENT, scrollIntoView: true }
}

/** The editor's paste handling for URLs (images are attachments.ts's). */
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
    return true
  },
})
