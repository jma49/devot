// Completions inside a line, in the slash menu's popup style: `:` and two or
// more word characters list the emoji whose shortcode matches (picking one
// inserts the character), and `> [!` lists the alert kinds (picking one
// completes the `[!KIND]` line). Neither opens where the text is literal:
// code, HTML, front matter, link addresses.
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import { ALERT_KINDS, type AlertKind } from './blocks'
import {
  blockAround,
  context,
  inFrontMatter,
  LITERAL_TEXT,
  TOOLBAR_PARSE_MS,
} from './formatContext'
import { ALERT_ICONS, withLook } from './popupLook'

/** Whether `pos` is in text that completes (not code, HTML, front matter or an address). */
function inProse(state: EditorState, pos: number): boolean {
  const cx = context(state, TOOLBAR_PARSE_MS)
  return cx !== null && !inFrontMatter(cx, pos) && !blockAround(cx, pos, LITERAL_TEXT)
}

export interface Emoji {
  name: string
  emoji: string
}

const EMOJI_QUERY = /(?:^|[\s([{])(:([\w+-]{2,32}))$/
const EMOJI_MAX = 50

let emojiList: Promise<Emoji[]> | null = null

function allEmoji(): Promise<Emoji[]> {
  emojiList ??= import('gemoji').then(({ gemoji }) =>
    gemoji.flatMap((g) => g.names.map((name) => ({ name, emoji: g.emoji }))),
  )
  return emojiList
}

/**
 * The emoji whose shortcode has the query in it, best first: shortcodes
 * that start with it, then the rest, each shorter first, then A to Z.
 */
export function emojiMatches(list: readonly Emoji[], query: string, max = EMOJI_MAX): Emoji[] {
  const q = query.toLowerCase()
  const scored: { e: Emoji; at: number }[] = []
  for (const e of list) {
    const at = e.name.indexOf(q)
    if (at >= 0) scored.push({ e, at })
  }
  scored.sort(
    (a, b) =>
      Number(a.at > 0) - Number(b.at > 0) ||
      a.e.name.length - b.e.name.length ||
      (a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : 0),
  )
  return scored.slice(0, max).map((s) => s.e)
}

export function emojiTrigger(state: EditorState): { from: number; query: string } | null {
  const { ranges, main } = state.selection
  if (ranges.length > 1 || !main.empty) return null
  const line = state.doc.lineAt(main.head)
  const before = state.sliceDoc(Math.max(line.from, main.head - 40), main.head)
  const match = EMOJI_QUERY.exec(before)
  const typed = match?.[1]
  if (!typed || !match[2]) return null
  return { from: main.head - typed.length, query: match[2] }
}

export async function emojiSource(cx: CompletionContext): Promise<CompletionResult | null> {
  if (cx.view?.composing) return null
  const trigger = emojiTrigger(cx.state)
  if (!trigger || !inProse(cx.state, trigger.from)) return null
  const list = await allEmoji()
  const matches = emojiMatches(list, trigger.query)
  if (matches.length === 0) return null
  const q = trigger.query.toLowerCase()
  const options = matches.map((e): Completion => {
    return withLook<Completion>(
      { label: `:${e.name}:`, apply: e.emoji },
      { list: 'emoji', glyph: e.emoji },
    )
  })
  return {
    from: trigger.from,
    options,
    filter: false,
    getMatch: (c) => {
      const at = c.label.indexOf(q, 1)
      return at < 0 ? [] : [at, at + q.length]
    },
  }
}

const ALERT_QUERY = /^ {0,3}(?:>[ \t]?)+\[!([A-Za-z]{0,9})$/

export function alertTrigger(
  state: EditorState,
): { from: number; to: number; query: string } | null {
  const { ranges, main } = state.selection
  if (ranges.length > 1 || !main.empty) return null
  const line = state.doc.lineAt(main.head)
  const match = ALERT_QUERY.exec(state.sliceDoc(line.from, main.head))
  if (!match) return null
  const query = match[1] ?? ''
  const from = main.head - query.length - 2
  // A `]` the bracket closing put after the cursor goes with the pick.
  const after = state.sliceDoc(main.head, line.to)
  const to = main.head + (/^[A-Za-z]*\]/.exec(after)?.[0].length ?? 0)
  return { from, to, query }
}

export function alertMatches(query: string): AlertKind[] {
  const q = query.toLowerCase()
  return ALERT_KINDS.filter((kind) => kind.startsWith(q))
}

export function alertSource(cx: CompletionContext): CompletionResult | null {
  if (cx.view?.composing) return null
  const trigger = alertTrigger(cx.state)
  if (!trigger) return null
  const kinds = alertMatches(trigger.query)
  if (kinds.length === 0) return null
  const options = kinds.map((kind): Completion => {
    const label = `[!${kind.toUpperCase()}]`
    return withLook<Completion>(
      {
        label,
        apply: (view, _c, from) => {
          const now = alertTrigger(view.state)
          const to = now ? now.to : view.state.selection.main.head
          view.dispatch({
            changes: { from, to, insert: label },
            selection: { anchor: from + label.length },
            userEvent: 'input.complete',
          })
        },
      },
      { list: 'alert', icon: ALERT_ICONS[kind], tone: kind },
    )
  })
  const q = trigger.query.length
  return {
    from: trigger.from,
    to: trigger.to,
    options,
    filter: false,
    getMatch: () => [0, 2 + q],
    update: (_current, _from, _to, next) => alertSource(next),
  }
}
