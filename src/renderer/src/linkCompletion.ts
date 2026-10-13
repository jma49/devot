// Typing `[[` in the editor offers notes to link to, found with full-text
// search (live notes only, so nothing from the Trash), plus a new note named
// after the query. Picking one replaces `[[query` (and the `]]` that bracket
// closing adds) with a standard `[title](devot://note/<id>)` link.
import type { Completion, CompletionContext, CompletionSource } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { noteLink } from '../../core/links'
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
}

/** A `[[` and the query typed after it, up to the cursor. */
export const LINK_TRIGGER = /\[\[[^[\]\n]*$/
const MAX_OPTIONS = 20

/** Replaces `[[query]]` (from `from` to the cursor, plus a closing `]]`) with the link. */
function insertLink(view: EditorView, from: number, title: string, id: string) {
  const state = view.state
  const head = state.selection.main.head
  // The note may have changed while a new note was created: check the trigger is still there.
  if (state.sliceDoc(from, from + 2) !== '[[' || head < from) return
  const to = state.sliceDoc(head, head + 2) === ']]' ? head + 2 : head
  const link = noteLink(title || t('note.untitled'), id)
  view.dispatch({
    changes: { from, to, insert: link },
    selection: { anchor: from + link.length },
    userEvent: 'input.complete',
  })
}

export function linkCompletionSource(sources: LinkSources): CompletionSource {
  return async (context: CompletionContext) => {
    const match = context.matchBefore(LINK_TRIGGER)
    if (!match) return null
    const query = match.text.slice(2)
    const found = await sources.find(query.trim()).catch(() => [])
    if (context.aborted) return null
    const options: Completion[] = found.slice(0, MAX_OPTIONS).map((note) => ({
      label: note.title || t('note.untitled'),
      type: 'text',
      apply: (view) => insertLink(view, match.from, note.title, note.id),
    }))
    const title = query.trim()
    options.push({
      label: title ? format(t('links.newNote'), { title }) : t('links.newUntitled'),
      type: 'keyword',
      apply: (view) =>
        void sources.create(title).then(
          (id) => insertLink(view, match.from, title, id),
          () => console.warn('W_LINK_NOTE_CREATE_FAILED'),
        ),
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
  return EditorState.languageData.of(() => [{ autocomplete: source }])
}
