// The paste chooser: after a lone URL goes in as copied (Paste URL as Link
// set to Choose each time, or Paste URL As… from the palette), a popup
// lists the formats it can take (pasteFormats.ts). The highlighted format
// shows in the URL's place; picking one swaps the URL for it, as one undo
// step with the paste. Closing the popup (Esc, moving the caret), an edit
// over the URL, undo or redo keep the URL as it is. A page title or a GitHub
// file is fetched (through Rust) only while a format that needs it is
// highlighted or picked, never on the paste itself.
import {
  closeCompletion,
  completionStatus,
  selectedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { isolateHistory, undo } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
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
import { parseGithubBlobUrl } from '../../../core/codeMeta'
import { t, type MessageKey } from '../i18n'
import { escapeBangBefore } from './formats'
import {
  formatUrl,
  pasteFormats,
  snippetFence,
  type PasteFetch,
  type PasteFormat,
  type PasteFormatType,
} from './pasteFormats'
import { withLook } from './popupLook'

/** How the chooser fetches (Rust's `link_title` and `github_snippet` in the app). */
export interface PasteFetcher {
  /** The page's title; null when it has none. Rejects with an error code. */
  title: (url: string) => Promise<string | null>
  /** The text of a GitHub file. Rejects with an error code. */
  snippet: (url: string) => Promise<string>
}

export const pasteFetcher = Facet.define<PasteFetcher, PasteFetcher | null>({
  combine: (values) => values[0] ?? null,
})

/** A fetch's state: under way, finished (the format's text), or failed. */
export type FetchState =
  | { status: 'loading' }
  | { status: 'done'; text: string }
  | { status: 'error'; message: MessageKey }

/** An open chooser: the URL's place in the note and what it fetched. */
export interface Chooser {
  /** Tells this chooser's late fetch results from another's. */
  id: number
  from: number
  to: number
  url: string
  formats: readonly PasteFormat[]
  fetches: ReadonlyMap<PasteFetch, FetchState>
  /** A format picked while its fetch was under way: it applies when that ends. */
  picked: PasteFormatType | null
  /** The URL is the last change, from a paste: a pick replaces that paste (one undo step). */
  pasted: boolean
}

const openEffect = StateEffect.define<{
  from: number
  to: number
  url: string
  pasted: boolean
  block: boolean
}>()
const closeEffect = StateEffect.define<null>()
const fetchEffect = StateEffect.define<{ id: number; kind: PasteFetch; state: FetchState }>()
const pickEffect = StateEffect.define<{ id: number; type: PasteFormatType }>()

let lastId = 0

const chooserField = StateField.define<Chooser | null>({
  create: () => null,
  update(value, tr) {
    // Typing with no chooser open: nothing to map, nothing to open.
    if (!value && tr.effects.length === 0) return null
    let next = value
    if (next) {
      if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) next = null
      else if (tr.docChanged) {
        next = tr.changes.touchesRange(next.from, next.to)
          ? null
          : {
              ...next,
              from: tr.changes.mapPos(next.from, 1),
              to: tr.changes.mapPos(next.to, -1),
              pasted: false,
            }
      }
    }
    for (const effect of tr.effects) {
      if (effect.is(openEffect)) {
        const { from, to, url, pasted, block } = effect.value
        lastId += 1
        next = {
          id: lastId,
          from,
          to,
          url,
          formats: pasteFormats(url, { block }),
          fetches: new Map(),
          picked: null,
          pasted,
        }
      } else if (effect.is(closeEffect)) next = null
      else if (next && effect.is(fetchEffect) && effect.value.id === next.id) {
        const fetches = new Map(next.fetches)
        fetches.set(effect.value.kind, effect.value.state)
        next = { ...next, fetches }
      } else if (next && effect.is(pickEffect) && effect.value.id === next.id)
        next = { ...next, picked: effect.value.type }
    }
    // The chooser belongs to one caret, right after the URL.
    const sel = tr.newSelection
    if (next && (sel.ranges.length > 1 || !sel.main.empty || sel.main.head !== next.to)) next = null
    return next
  },
})

/** The open chooser, if any. */
export function chooserOf(state: EditorState): Chooser | null {
  return state.field(chooserField, false) ?? null
}

/** Blocks a fenced snippet cannot go into without ending or breaking them. */
const CONTAINERS = new Set(['Blockquote', 'ListItem', 'BulletList', 'OrderedList', 'Table'])

/** Whether a block (a fenced snippet) can go at `pos`: not inside a quote, a list or a table. */
function blockFits(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node.parent; node = node.parent)
    if (CONTAINERS.has(node.name)) return false
  return true
}

/**
 * Inserts `url` as copied at the cursor and opens the chooser on it; the
 * paste is its own undo event, so a pick can take its place.
 */
export function chooserPaste(state: EditorState, url: string): TransactionSpec {
  const at = state.selection.main.head
  const to = at + url.length
  return {
    changes: { from: at, insert: url },
    selection: EditorSelection.cursor(to),
    userEvent: 'input.paste',
    annotations: isolateHistory.of('full'),
    effects: openEffect.of({ from: at, to, url, pasted: true, block: blockFits(state, at) }),
    scrollIntoView: true,
  }
}

/** Opens the chooser on text already in the note (a link at the caret). */
export function chooserOn(
  state: EditorState,
  from: number,
  to: number,
  url: string,
): TransactionSpec {
  return {
    selection: EditorSelection.cursor(to),
    effects: openEffect.of({ from, to, url, pasted: false, block: blockFits(state, from) }),
  }
}

/** What the chooser acts through: an editor view, or a state and its dispatch in tests. */
export interface ChooserTarget {
  readonly state: EditorState
  dispatch: (tr: Transaction) => void
}

/** The error messages of Rust's error codes; any other code reads as a failed fetch. */
const ERROR_MESSAGES: Readonly<Record<string, MessageKey>> = {
  E_LINK_NOT_HTML: 'pasteFormat.notHtml',
  E_GITHUB_NOT_FOUND: 'pasteFormat.notFound',
  E_GITHUB_RATE_LIMITED: 'pasteFormat.rateLimited',
  E_LINK_TOO_LARGE: 'pasteFormat.tooLarge',
}

function errorMessage(error: unknown): MessageKey {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  if (/^[EW]_[A-Z0-9_]+$/.test(code)) console.warn('W_PASTE_FETCH_FAILED', code)
  return ERROR_MESSAGES[code] ?? 'pasteFormat.failed'
}

/** The format `type` of the open chooser. */
const formatIn = (c: Chooser, type: PasteFormatType) => c.formats.find((f) => f.type === type)

/** Whether the line around [from, to) has other text before and after it. */
function lineAround(state: EditorState, from: number, to: number) {
  const line = state.doc.lineAt(from)
  return {
    // Even spaces before it: an indented fence could read as indented code.
    before: from > line.from,
    after: state.sliceDoc(to, state.doc.lineAt(to).to).trim() !== '',
  }
}

/** Swaps the chooser's URL for format `type`, and closes the chooser. */
function apply(target: ChooserTarget, c: Chooser, type: PasteFormatType, fetched: string | null) {
  // A pick right after the paste takes the paste's place in the history:
  // undoing it then removes the link at once, not the link and then the URL.
  const replacePaste = c.pasted && undo(target)
  const state = target.state
  const from = c.from
  const to = replacePaste ? from : c.to
  const text = formatUrl(type, c.url, fetched, lineAround(state, from, to))
  // A `!` right before a link would make it an image.
  const bang = type === 'title' || type === 'emptyText' ? escapeBangBefore(state, from) : []
  const changes = state.changes([...bang, { from, to, insert: text.insert }])
  const start = changes.mapPos(from, -1)
  target.dispatch(
    state.update({
      changes,
      selection: EditorSelection.range(start + text.anchor, start + text.head),
      userEvent: 'input.paste',
      effects: closeEffect.of(null),
      scrollIntoView: true,
    }),
  )
}

/** Closes the chooser, keeping the URL. */
function close(target: ChooserTarget) {
  if (chooserOf(target.state))
    target.dispatch(target.state.update({ effects: closeEffect.of(null) }))
}

/**
 * Starts the fetch format `type` needs, unless it ran already; a pick made
 * meanwhile applies when it ends. Results for a chooser that closed are
 * dropped. `alive` says whether the target still takes dispatches.
 */
export function fetchFor(
  target: ChooserTarget,
  type: PasteFormatType,
  alive: () => boolean = () => true,
): void {
  const c = chooserOf(target.state)
  const kind = c && formatIn(c, type)?.fetch
  if (!c || !kind || c.fetches.has(kind)) return
  const { id, url } = c
  const fetcher = target.state.facet(pasteFetcher)
  const settle = (state: FetchState) => {
    if (!alive() || chooserOf(target.state)?.id !== id) return
    target.dispatch(target.state.update({ effects: fetchEffect.of({ id, kind, state }) }))
    const now = chooserOf(target.state)
    if (!now?.picked || formatIn(now, now.picked)?.fetch !== kind) return
    if (state.status === 'done') apply(target, now, now.picked, state.text)
    else if (state.status === 'error') close(target)
  }
  target.dispatch(
    target.state.update({ effects: fetchEffect.of({ id, kind, state: { status: 'loading' } }) }),
  )
  if (!fetcher) {
    settle({ status: 'error', message: 'pasteFormat.failed' })
    return
  }
  const work: Promise<FetchState> =
    kind === 'title'
      ? fetcher
          .title(url)
          .then((title) =>
            title
              ? { status: 'done', text: title }
              : { status: 'error', message: 'pasteFormat.noTitle' },
          )
      : fetcher.snippet(url).then((code) => {
          const blob = parseGithubBlobUrl(url)
          const fence = blob && snippetFence(code, blob, url)
          if (fence) return { status: 'done', text: fence }
          return { status: 'error', message: blob ? 'pasteFormat.noLines' : 'pasteFormat.failed' }
        })
  work.then(settle, (error: unknown) => settle({ status: 'error', message: errorMessage(error) }))
}

/**
 * Picks format `type`: swaps it in now, or, when it waits on a fetch, once
 * the fetch ends. A failed fetch keeps the URL.
 */
export function pickFormat(
  target: ChooserTarget,
  type: PasteFormatType,
  alive: () => boolean = () => true,
): void {
  const c = chooserOf(target.state)
  const format = c && formatIn(c, type)
  if (!c || !format) return
  if (!format.fetch) {
    apply(target, c, type, null)
    return
  }
  const fetched = c.fetches.get(format.fetch)
  if (fetched?.status === 'done') apply(target, c, type, fetched.text)
  else if (fetched?.status === 'error') close(target)
  else {
    target.dispatch(target.state.update({ effects: pickEffect.of({ id: c.id, type }) }))
    fetchFor(target, type, alive)
  }
}

// ---- The popup --------------------------------------------------------------

const formatOfOption = new WeakMap<Completion, PasteFormatType>()

/** The views whose chooser plugin is live; late fetch results for any other are dropped. */
const liveViews = new WeakSet<EditorView>()

/** The chooser's list, while it is open and the caret is right after the URL. */
const chooserSource: CompletionSource = (ctx: CompletionContext): CompletionResult | null => {
  const c = chooserOf(ctx.state)
  if (!c || ctx.pos !== c.to || c.picked) return null
  const options = c.formats.map((format, index) => {
    const option: Completion = withLook(
      {
        label: t(format.label),
        detail: t(format.detail),
        // The list keeps its order (options with equal scores sort by label).
        boost: 99 - index,
        apply: (view: EditorView) => {
          pickFormat(view, format.type, () => liveViews.has(view))
          // A pick that waits on its fetch changes nothing yet: close the list now.
          closeCompletion(view)
        },
      },
      { list: 'paste' },
    )
    formatOfOption.set(option, format.type)
    return option
  })
  return { from: c.to, options, filter: false }
}

/** The chooser's popup source, as one array for every language data lookup. */
const chooserSources = [{ autocomplete: chooserSource }]

/** Wraps another completion source so it offers nothing while the chooser is open. */
export function unlessChoosing(source: CompletionSource): CompletionSource {
  return (ctx) => (chooserOf(ctx.state) ? null : source(ctx))
}

/** The highlighted format, or the picked one waiting on its fetch. */
function shownFormat(state: EditorState, c: Chooser): PasteFormatType | null {
  if (c.picked) return c.picked
  if (completionStatus(state) !== 'active') return null
  const option = selectedCompletion(state)
  return (option && formatOfOption.get(option)) ?? null
}

/** The most characters the preview shows (a snippet can be a whole file). */
const MAX_PREVIEW = 200

class PreviewWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly state: 'ready' | 'loading' | 'error',
  ) {
    super()
  }

  override eq(other: PreviewWidget): boolean {
    return other.text === this.text && other.state === this.state
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-link-format-preview'
    span.dataset['state'] = this.state
    span.textContent =
      this.text.length > MAX_PREVIEW ? `${this.text.slice(0, MAX_PREVIEW)}…` : this.text
    return span
  }
}

/** What the URL's place shows for the highlighted format. */
function preview(state: EditorState): DecorationSet {
  const c = chooserOf(state)
  const type = c && shownFormat(state, c)
  if (!c || !type || type === 'plain' || c.from === c.to) return Decoration.none
  const kind = formatIn(c, type)?.fetch
  const fetched = kind ? c.fetches.get(kind) : undefined
  let widget: PreviewWidget
  if (!kind) widget = new PreviewWidget(formatUrl(type, c.url, null).insert, 'ready')
  else if (fetched?.status === 'done')
    widget = new PreviewWidget(formatUrl(type, c.url, fetched.text).insert, 'ready')
  else if (fetched?.status === 'error') widget = new PreviewWidget(t(fetched.message), 'error')
  else widget = new PreviewWidget(t('pasteFormat.loading'), 'loading')
  return Decoration.set(Decoration.replace({ widget }).range(c.from, c.to))
}

const previewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    /** The chooser whose popup has shown: when it closes unpicked, so does the chooser. */
    shown = 0

    constructor(readonly view: EditorView) {
      liveViews.add(view)
      this.decorations = preview(view.state)
    }

    update(update: ViewUpdate) {
      const { state } = update
      const c = chooserOf(state)
      // Typing with no chooser open (nearly every keystroke): nothing to show.
      if (!c) {
        this.decorations = Decoration.none
        return
      }
      this.decorations = preview(state)
      const status = completionStatus(state)
      if (status === 'active') this.shown = c.id
      // Esc, a click elsewhere or a blur closed the popup: the URL stays as it is.
      const closed = status === null && this.shown === c.id && !c.picked
      const type = shownFormat(state, c)
      const kind = type && formatIn(c, type)?.fetch
      const fetch = type && kind && !c.fetches.has(kind) ? type : null
      if (!closed && !fetch) return
      // No dispatch during an update: right after it.
      queueMicrotask(() => {
        if (!liveViews.has(this.view) || chooserOf(this.view.state)?.id !== c.id) return
        if (closed) close(this.view)
        else if (fetch) fetchFor(this.view, fetch, () => liveViews.has(this.view))
      })
    }

    destroy() {
      liveViews.delete(this.view)
    }
  },
  { decorations: (v) => v.decorations },
)

const theme = EditorView.theme({
  '.cm-link-format-preview': {
    borderRadius: 'var(--radius-button)',
    backgroundColor: 'var(--color-fill-completion-selected)',
    color: 'var(--color-text-secondary)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-link-format-preview[data-state="error"]': { color: 'var(--color-text-destructive)' },
  '.cm-link-format-preview[data-state="loading"]': { color: 'var(--color-text-tertiary)' },
})

/** Opens the popup of a chooser just opened in `view`. */
export function showChooser(view: EditorView): void {
  if (chooserOf(view.state)) startCompletion(view)
}

/** The paste chooser of the note editor, fetching through `fetcher`. */
export function pasteChooser(fetcher: PasteFetcher | null): Extension {
  return [
    chooserField,
    previewPlugin,
    theme,
    fetcher ? pasteFetcher.of(fetcher) : [],
    // A pick waiting on its fetch has no list left to close: Esc gives up on it.
    Prec.highest(
      keymap.of([
        {
          key: 'Escape',
          run: (view) => {
            if (!chooserOf(view.state)?.picked) return false
            close(view)
            return true
          },
        },
      ]),
    ),
    EditorState.languageData.of(() => chooserSources),
  ]
}
