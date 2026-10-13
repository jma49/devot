// Find and replace in the Markdown source: the editor side of the find bar.
// The query lives in a state field; matches are marked with decorations and
// the current match is the selection. Replacements are ordinary transactions,
// so they reach the Yjs document like typing, each as its own undo step.
import { isolateHistory } from '@codemirror/commands'
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import {
  expandReplacement,
  findMatches,
  replacementChanges,
  type FindMatch,
  type FindOptions,
  type FindResult,
} from '../../../core/find'
import { shortcutCodeMirror } from '../commands/keys'
import { commandKeys } from '../commands/registry'
import { registryKeys } from './registryKeys'
import { NO_MATCHES, seedQuery, type FindChange, type FindTarget } from '../find/target'
import { hideToolbar } from './toolbarState'

const setFind = StateEffect.define<FindOptions | null>()

interface FindValue {
  options: FindOptions | null
  result: FindResult
  /** Every match, marked (empty matches have nothing to mark). */
  marks: DecorationSet
}

const EMPTY: FindResult = { matches: [], invalid: false, capped: false }
const matchMark = Decoration.mark({ class: 'cm-find-match' })
const currentMark = Decoration.mark({ class: 'cm-find-current' })

const findField = StateField.define<FindValue>({
  create: () => ({ options: null, result: EMPTY, marks: Decoration.none }),
  update(value, tr) {
    let { options } = value
    let set = false
    for (const effect of tr.effects) {
      if (effect.is(setFind)) {
        options = effect.value
        set = true
      }
    }
    if (!set && !(tr.docChanged && options)) return value
    const result = options ? findMatches(tr.newDoc.toString(), options) : EMPTY
    const marks = Decoration.set(
      result.matches.filter((m) => m.to > m.from).map((m) => matchMark.range(m.from, m.to)),
    )
    return { options, result, marks }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
})

/** The index of the match that is exactly the main selection, or -1. */
function currentIndex(matches: readonly FindMatch[], from: number, to: number): number {
  // Matches are in order and no two start at the same place.
  let lo = 0
  let hi = matches.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m = matches[mid]!
    if (m.from === from) return m.to === to ? mid : -1
    if (m.from < from) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

// The current match, on top of the others; kept apart so that moving the
// selection does not rebuild every mark.
const currentMarks = EditorView.decorations.compute([findField, 'selection'], (state) => {
  const { matches } = state.field(findField).result
  const { from, to } = state.selection.main
  if (from === to || currentIndex(matches, from, to) < 0) return Decoration.none
  return Decoration.set([currentMark.range(from, to)])
})

// While find is on, the editor's own marks for the selected word would
// cover the find marks.
const findAttributes = EditorView.editorAttributes.compute([findField], (state) =>
  state.field(findField).options ? { 'data-find': '' } : {},
)

const listeners = new WeakMap<EditorView, Set<(change: FindChange) => void>>()
const notify = (view: EditorView, change: FindChange) => {
  for (const listener of listeners.get(view) ?? []) listener(change)
}

const notifier = EditorView.updateListener.of((update) => {
  if (update.selectionSet || update.state.field(findField) !== update.startState.field(findField))
    notify(update.view, 'status')
})

/** Passes a key to the find bar while a query is set. */
const toBar =
  (change: FindChange) =>
  (view: EditorView): boolean => {
    if (!view.state.field(findField).options) return false
    notify(view, change)
    return true
  }

const keys = registryKeys(() =>
  Prec.high(
    keymap.of([
      // After the selection toolbar's Escape (it hides first), before the
      // default Escape that collapses the selection.
      { key: 'Escape', run: toBar('close') },
      // F3 and Shift+F3 (the registry's keys) step through matches with the
      // bar open; they never open CodeMirror's own search panel.
      ...commandKeys('find.nextInEditor').map((key) => ({
        key: shortcutCodeMirror(key),
        run: (view: EditorView) => toBar('next')(view) || true,
        preventDefault: true,
      })),
      ...commandKeys('find.previousInEditor').map((key) => ({
        key: shortcutCodeMirror(key),
        run: (view: EditorView) => toBar('previous')(view) || true,
        preventDefault: true,
      })),
    ]),
  ),
)

const theme = EditorView.theme({
  '.cm-find-match': {
    borderRadius: 'var(--space-1)',
    backgroundColor: 'var(--color-fill-match)',
  },
  '.cm-find-current, .cm-find-current .cm-find-match': {
    borderRadius: 'var(--space-1)',
    backgroundColor: 'var(--color-fill-match-current)',
    outline: '1px solid var(--color-line-match)',
  },
  '&[data-find] .cm-selectionMatch': { backgroundColor: 'transparent' },
})

/** The editor's find support; add after the selection toolbar. */
export function editorFind(): Extension {
  return [findField, currentMarks, findAttributes, notifier, keys(), theme]
}

/** The find bar's handle on an editor that has `editorFind()`. */
export function editorFindTarget(view: EditorView): FindTarget {
  const value = () => view.state.field(findField)
  const current = (matches: readonly FindMatch[]) => {
    const { from, to } = view.state.selection.main
    return currentIndex(matches, from, to)
  }
  const select = (m: FindMatch | undefined) => {
    if (!m) return
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      // The selection toolbar stays away: the user did not select this.
      effects: [EditorView.scrollIntoView(m.from, { y: 'center' }), hideToolbar.of(null)],
      userEvent: 'select.search',
    })
  }
  // The first match after (or the last before) the selection, wrapping around.
  const after = (matches: FindMatch[]) => {
    const { from, to } = view.state.selection.main
    return matches.find((m) => m.from > from || (m.from === from && m.to > to)) ?? matches[0]
  }
  const before = (matches: FindMatch[]) => {
    const { from, to } = view.state.selection.main
    return (
      matches.findLast((m) => m.from < from || (m.from === from && m.to < to)) ?? matches.at(-1)
    )
  }

  return {
    canReplace: true,
    search(options, step) {
      view.dispatch({ effects: setFind.of(options) })
      const { matches } = value().result
      if (step === 'next') select(after(matches))
      else if (step === 'previous') select(before(matches))
      else {
        // Typing a query keeps the match it extends; otherwise the next one.
        const { from } = view.state.selection.main
        select(matches.find((m) => m.from >= from) ?? matches[0])
      }
    },
    next() {
      select(after(value().result.matches))
    },
    previous() {
      select(before(value().result.matches))
    },
    replace(template) {
      const { options, result } = value()
      const match = result.matches[current(result.matches)]
      if (!options || !match) {
        select(after(result.matches))
        return
      }
      const insert = expandReplacement(template, match, view.state.doc.toString(), options.regexp)
      view.dispatch({
        changes: { from: match.from, to: match.to, insert },
        selection: { anchor: match.from + insert.length },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.replace',
      })
      // Go on after the new text (an empty match only once per place).
      const end = match.from + insert.length
      const { matches } = value().result
      select(
        matches.find(
          (m) => m.from > end || (m.from === end && (m.to > end || match.to > match.from)),
        ) ?? matches[0],
      )
    },
    replaceAll(template) {
      const { options } = value()
      if (!options) return
      const changes = replacementChanges(view.state.doc.toString(), options, template)
      if (changes.length === 0) return
      view.dispatch({
        changes,
        annotations: isolateHistory.of('full'),
        userEvent: 'input.replace.all',
        scrollIntoView: true,
      })
    },
    clear() {
      if (value().options) view.dispatch({ effects: setFind.of(null) })
    },
    status() {
      const { options, result } = value()
      if (!options) return NO_MATCHES
      const index = current(result.matches)
      return {
        total: result.matches.length,
        current: index < 0 ? null : index,
        invalid: result.invalid,
        capped: result.capped,
      }
    },
    selectedText() {
      const { from, to } = view.state.selection.main
      return seedQuery(view.state.sliceDoc(from, to))
    },
    owns(node) {
      const root = view.dom.getRootNode()
      const host = root instanceof ShadowRoot ? root.host : view.dom
      return node !== null && host.contains(node)
    },
    focus() {
      view.focus()
    },
    subscribe(listener) {
      const set = listeners.get(view) ?? new Set()
      listeners.set(view, set)
      set.add(listener)
      return () => set.delete(listener)
    },
  }
}
