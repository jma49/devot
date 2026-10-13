// Typing `[[` in the editor offers notes to link to, found with full-text
// search (live notes only, so nothing from the Trash), plus a new note named
// after the query. Picking one replaces `[[query` (and the `]]` that bracket
// closing adds) with a standard `[title](devot://note/<id>)` link. It never
// opens in code, HTML, comments or front matter, where `[[` is text. Picking
// New Note closes the popup at once and remembers the `[[query]]` it will
// replace while the note is made (the text typed meanwhile is kept); a note
// that cannot be linked afterwards is deleted again, so none is left behind.
import {
  closeCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { noteLink } from '../../core/links'
import {
  blockAround,
  context as syntaxContext,
  inFrontMatter,
  LITERAL_TEXT,
  COMMAND_PARSE_MS,
} from './editor/formatContext'
import { format, t } from './i18n'

export interface LinkTarget {
  id: string
  title: string
}

export interface LinkSources {
  /** Notes matching the query (recent notes for an empty one). */
  find: (query: string) => Promise<LinkTarget[]>
  /** Creates a note with this title; resolves to its ID. */
  create: (title: string) => Promise<string>
  /** Deletes a note `create` made that could not be linked after all. */
  discard: (id: string) => Promise<void>
  /** A note `create` made has been linked. */
  linked: (id: string) => void
}

/** A `[[` and the query typed after it, up to the cursor. */
export const LINK_TRIGGER = /\[\[[^[\]\n]*$/
/** How many notes the popup offers. */
export const MAX_LINK_NOTES = 20

/** `[[query]]` of a New Note pick, waiting for its note. */
interface Pending {
  id: number
  from: number
  to: number
  /** The text from `from` to `to` when it was picked. */
  text: string
}

const startPending = StateEffect.define<Pending>()
const endPending = StateEffect.define<number>()

/** The picks waiting for their notes, their ranges following the edits made meanwhile. */
const pendingPicks = StateField.define<readonly Pending[]>({
  create: () => [],
  update(picks, tr) {
    let next = tr.docChanged
      ? picks.map((pick) => {
          // Text typed at an edge stays outside; text typed inside is in.
          const from = tr.changes.mapPos(pick.from, 1)
          return { ...pick, from, to: Math.max(from, tr.changes.mapPos(pick.to, -1)) }
        })
      : picks
    for (const effect of tr.effects) {
      if (effect.is(startPending)) next = [...next, effect.value]
      else if (effect.is(endPending)) next = next.filter((pick) => pick.id !== effect.value)
    }
    return next
  },
})

let picked = 0

/** Replaces `[[query]]` (from `from` to the cursor, plus a closing `]]`) with the link. */
function insertLink(view: EditorView, from: number, title: string, id: string) {
  const state = view.state
  const head = state.selection.main.head
  // The note may have changed meanwhile: check the trigger is still there.
  if (state.sliceDoc(from, from + 2) !== '[[' || head < from) return
  const to = state.sliceDoc(head, head + 2) === ']]' ? head + 2 : head
  const link = noteLink(title || t('note.untitled'), id)
  view.dispatch({
    changes: { from, to, insert: link },
    selection: { anchor: from + link.length },
    userEvent: 'input.complete',
  })
}

/**
 * Makes the note for a New Note pick, then links it in place of the
 * `[[query]]` as it stands by then. When the editor has closed or the
 * brackets were edited, nothing is linked and the note is deleted again.
 */
function createAndLink(sources: LinkSources, view: EditorView, from: number, title: string) {
  const state = view.state
  const head = state.selection.main.head
  if (state.sliceDoc(from, from + 2) !== '[[' || head < from) return
  const to = state.sliceDoc(head, head + 2) === ']]' ? head + 2 : head
  const pick: Pending = { id: (picked += 1), from, to, text: state.sliceDoc(from, to) }
  // The cursor leaves the brackets, so what is typed meanwhile (a second
  // Return, say) lands after them and never inside the text being replaced.
  view.dispatch({ effects: startPending.of(pick), selection: { anchor: to } })
  const finish = (id: string | undefined) => {
    const now = view.dom.isConnected
      ? view.state.field(pendingPicks).find((p) => p.id === pick.id)
      : undefined
    if (now && id !== undefined && view.state.sliceDoc(now.from, now.to) === pick.text) {
      const link = noteLink(title || t('note.untitled'), id)
      const caret = view.state.selection.main
      const inside = caret.empty && caret.head >= now.from && caret.head <= now.to
      view.dispatch({
        changes: { from: now.from, to: now.to, insert: link },
        effects: endPending.of(pick.id),
        ...(inside ? { selection: { anchor: now.from + link.length } } : {}),
        userEvent: 'input.complete',
      })
      sources.linked(id)
      return
    }
    if (now) view.dispatch({ effects: endPending.of(pick.id) })
    if (id !== undefined) {
      console.warn('W_LINK_NOTE_NOT_LINKED', id)
      void sources.discard(id)
    }
  }
  sources.create(title).then(finish, () => {
    console.warn('W_LINK_NOTE_CREATE_FAILED')
    finish(undefined)
  })
}

export function linkCompletionSource(sources: LinkSources): CompletionSource {
  return async (completion: CompletionContext) => {
    const match = completion.matchBefore(LINK_TRIGGER)
    if (!match) return null
    // `[[` is text in code and front matter; and where the parser has not
    // reached yet, code could look like text.
    const cx = syntaxContext(completion.state, COMMAND_PARSE_MS)
    if (!cx || inFrontMatter(cx, match.from) || blockAround(cx, match.from, LITERAL_TEXT)) {
      return null
    }
    const query = match.text.slice(2)
    const found = await sources.find(query.trim()).catch(() => [])
    if (completion.aborted) return null
    const options: Completion[] = found.slice(0, MAX_LINK_NOTES).map((note) => ({
      label: note.title || t('note.untitled'),
      type: 'text',
      apply: (view) => insertLink(view, match.from, note.title, note.id),
    }))
    const title = query.trim()
    options.push({
      label: title ? format(t('links.newNote'), { title }) : t('links.newUntitled'),
      type: 'keyword',
      apply: (view) => {
        // Closed at once: a second Return must not make a second note.
        closeCompletion(view)
        createAndLink(sources, view, match.from, title)
      },
    })
    // Search already filtered and ranked the notes; keep that order.
    return { from: match.from, options, filter: false }
  }
}

/** The `[[` completion for the editor, alongside any other sources. */
export function linkCompletion(sources: LinkSources) {
  // One source for the editor's life: CodeMirror keeps results per source
  // function, so a new function on every lookup would discard each result.
  const source = linkCompletionSource(sources)
  return [EditorState.languageData.of(() => [{ autocomplete: source }]), pendingPicks]
}
