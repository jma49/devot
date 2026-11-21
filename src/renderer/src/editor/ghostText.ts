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
    /** The request left: the caret shows it is waiting until the answer or a change drops it. */
    sent: () => void,
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

const setWaiting = StateEffect.define<number | null>()

/** Where a sent request will put its suggestion, while it is on its way; a change of the note or the caret drops it. */
export const waitingField = StateField.define<number | null>({
  create: () => null,
  update(at, tr) {
    for (const effect of tr.effects)
      if (effect.is(setWaiting) || effect.is(setGhost))
        at = effect.is(setWaiting) ? effect.value : null
    return tr.docChanged || tr.selection ? null : at
  },
  provide: (field) =>
    EditorView.decorations.from(field, (at): DecorationSet =>
      at === null
        ? Decoration.none
        : Decoration.set([Decoration.widget({ widget: waitingWidget, side: 1 }).range(at)]),
    ),
})

/** Three dots after the caret, drawn rather than typed so they never read as text of the note. */
class WaitingWidget extends WidgetType {
  override eq(): boolean {
    return true
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-ghost-waiting'
    el.setAttribute('aria-hidden', 'true')
    return el
  }

  override ignoreEvent(): boolean {
    return true
  }
}

const waitingWidget = new WaitingWidget()

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
  /** What asked for the request in flight, if one is. */
  private pending: SuggestTrigger | null = null

  constructor(private readonly view: EditorView) {}

  get waitingFor(): SuggestTrigger | null {
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
      this.pending = null
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
    this.pending = trigger
    const settle = () => {
      if (mine !== this.token) return false
      this.pending = null
      if (this.view.state.field(waitingField, false) !== null)
        this.view.dispatch({ effects: setWaiting.of(null) })
      return true
    }
    const sent = () => {
      if (mine === this.token) this.view.dispatch({ effects: setWaiting.of(caret) })
    }
    source
      .suggest(
        suggestContext((from, to) => doc.sliceString(from, to), doc.length, caret),
        trigger,
        sent,
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

/**
 * Escape drops a suggestion or a request still on its way. It is used up only by what the user
 * saw or asked for: after a pause's unseen request it still does the editor's own job too (Escape
 * then Tab leaves the editor).
 */
function dismiss(view: EditorView): boolean {
  const plugin = view.plugin(requests)
  const shown = view.state.field(ghostField, false)
  const waiting = plugin?.waitingFor ?? null
  if (!shown && !waiting) return false
  plugin?.stop()
  if (shown || view.state.field(waitingField, false) !== null)
    view.dispatch({ effects: [setGhost.of(null), setWaiting.of(null)] })
  return !!shown || waiting === 'key'
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

const DOT = 'radial-gradient(circle closest-side, var(--color-text-tertiary) 90%, transparent 100%)'

const theme = EditorView.theme({
  '.cm-ghost-text': {
    color: 'var(--color-text-tertiary)',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
  },
  // Static, so it reads as a state (design/motion.md, rule 2), in the ghost text's own colour.
  '.cm-ghost-waiting': {
    display: 'inline-block',
    boxSizing: 'content-box',
    width: '1.1em',
    // A text's height, so the caret beside it keeps its own; the dots sit on the baseline.
    height: '1em',
    // The caret is drawn at the box's start: the padding keeps it clear of the first dot.
    paddingInlineStart: '0.3em',
    verticalAlign: '-0.2em',
    pointerEvents: 'none',
    backgroundImage: Array(3).fill(DOT).join(', '),
    backgroundOrigin: 'content-box',
    backgroundPosition: 'left bottom 0.2em, center bottom 0.2em, right bottom 0.2em',
    backgroundSize: '0.3em 0.3em',
    backgroundRepeat: 'no-repeat',
  },
})

export function ghostText(source: GhostSource): Extension {
  return [ghostSource.of(source), ghostField, waitingField, requests, keys, triggerKeys(), theme]
}
