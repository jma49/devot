// Next edit suggestions as ghost text: a suggestion is only a decoration after the caret. It enters the document (and
// so the note's Yjs text) when accepted with Tab, as one undo step; Escape, typing or moving the caret drops it.
import { isolateHistory } from '@codemirror/commands'
import {
  Facet,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { SUGGEST_IDLE_MS, suggestContext, type SuggestTrigger } from '../../../core/aiSuggest'
import { errorCode } from '../../../core/errors'
import { editorCommandKeys } from '../commands/registry'
import { format, t } from '../i18n'
import { registryKeys } from './registryKeys'

export interface GhostSource {
  /** The text to show at the caret, or null for none (the core refuses with a code when the user asked and AI is not available). */
  suggest(
    context: { before: string; after: string },
    trigger: SuggestTrigger,
  ): Promise<string | null>
  cancel(): void
  /** The user asked (the key) and got no suggestion. */
  failed(code: string): void
}

const ghostSource = Facet.define<GhostSource, GhostSource | undefined>({
  combine: (all) => all[0],
})

export interface Ghost {
  pos: number
  text: string
}

const setGhost = StateEffect.define<Ghost | null>()

export const showGhost = (pos: number, text: string): StateEffect<Ghost | null> =>
  setGhost.of({ pos, text })

export const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(ghost, tr) {
    for (const effect of tr.effects) if (effect.is(setGhost)) return effect.value
    return tr.docChanged || tr.selection ? null : ghost
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghost): DecorationSet =>
      ghost
        ? Decoration.set([
            Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.pos),
          ])
        : Decoration.none,
    ),
})

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  override eq(other: GhostWidget): boolean {
    return other.text === this.text
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-ghost-text'
    el.setAttribute('aria-hidden', 'true')
    el.textContent = this.text
    return el
  }

  override ignoreEvent(): boolean {
    return true
  }
}

/** The transaction that takes the suggestion into the note: its own undo step, the caret after it. */
export function acceptSpec(state: EditorState): TransactionSpec | null {
  const ghost = state.field(ghostField, false)
  if (!ghost) return null
  return {
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
    userEvent: 'input.complete',
  }
}

const typed = (update: ViewUpdate) =>
  update.transactions.some((tr) => tr.docChanged && tr.isUserEvent('input.type'))

/** An idle suggestion is asked for only where the line ends at the caret, and never while composing text. */
function idleSpot(view: EditorView): boolean {
  if (!view.hasFocus || view.composing) return false
  const { main, ranges } = view.state.selection
  return ranges.length === 1 && main.empty && view.state.doc.lineAt(main.head).to === main.head
}

class GhostRequests {
  /** Bumped by every change of the note or the caret, and by every request: an answer for an older one is dropped. */
  private token = 0
  private idle: ReturnType<typeof setTimeout> | undefined
  private pending = false

  constructor(private readonly view: EditorView) {}

  get busy(): boolean {
    return this.pending
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged && !update.selectionSet) return
    this.stop()
    if (typed(update) && update.state.facet(ghostSource)) {
      this.idle = setTimeout(() => {
        this.idle = undefined
        if (idleSpot(this.view)) this.request('idle')
      }, SUGGEST_IDLE_MS)
    }
  }

  /** Drops a request in flight, a suggestion shown and a timer waiting. */
  stop(): void {
    this.token += 1
    clearTimeout(this.idle)
    this.idle = undefined
    if (this.pending) {
      this.pending = false
      this.view.state.facet(ghostSource)?.cancel()
    }
  }

  request(trigger: SuggestTrigger): boolean {
    const source = this.view.state.facet(ghostSource)
    const { main, ranges } = this.view.state.selection
    if (!source || ranges.length !== 1 || !main.empty) return false
    this.stop()
    const mine = this.token
    const { doc } = this.view.state
    const caret = main.head
    this.pending = true
    const settle = () => {
      if (mine !== this.token) return false
      this.pending = false
      return true
    }
    source
      .suggest(
        suggestContext((from, to) => doc.sliceString(from, to), doc.length, caret),
        trigger,
      )
      .then(
        (text) => {
          if (!settle()) return
          if (text) {
            this.view.dispatch({
              effects: [
                setGhost.of({ pos: caret, text }),
                EditorView.announce.of(format(t('aiSuggest.live'), { text })),
              ],
            })
          } else if (trigger === 'key') source.failed('E_AI_SUGGESTION_NONE')
        },
        (e: unknown) => {
          if (!settle()) return
          if (trigger === 'key') source.failed(errorCode(e))
          else console.warn('W_AI_SUGGEST_FAILED', errorCode(e))
        },
      )
    return true
  }

  destroy(): void {
    this.stop()
  }
}

const requests = ViewPlugin.fromClass(GhostRequests)

/** Escape drops a suggestion or a request still on its way; with neither it falls through to the editor's own. */
function dismiss(view: EditorView): boolean {
  const plugin = view.plugin(requests)
  const shown = view.state.field(ghostField, false)
  if (!shown && !plugin?.busy) return false
  plugin?.stop()
  if (shown) view.dispatch({ effects: setGhost.of(null) })
  return true
}

const keys = Prec.highest(
  keymap.of([
    {
      key: 'Tab',
      run(view) {
        const spec = acceptSpec(view.state)
        if (!spec) return false
        view.dispatch(spec)
        return true
      },
    },
    { key: 'Escape', run: dismiss },
  ]),
)

const triggerKeys = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorCommandKeys('ai.suggest').map((key) => ({
        key,
        run: (view: EditorView) => suggestAt(view),
        preventDefault: true,
      })),
    ),
  ),
)

/** Asks for a suggestion at the caret, as the user's own request; false where the editor has no AI source or the selection is not a lone caret. */
export function suggestAt(view: EditorView): boolean {
  return view.plugin(requests)?.request('key') ?? false
}

const theme = EditorView.theme({
  '.cm-ghost-text': {
    color: 'var(--color-text-tertiary)',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
  },
})

export function ghostText(source: GhostSource): Extension {
  return [ghostSource.of(source), ghostField, requests, keys, triggerKeys(), theme]
}
