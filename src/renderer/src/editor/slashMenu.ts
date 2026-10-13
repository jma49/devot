// The slash menu: a `/` typed at the start of a line or after a space or tab
// opens a list of insertions at the cursor (a link, an image, a quote, the
// alerts, a note link, a code block, a table, the lists and a rule). Each
// item is a command of the registry, under the registry's label and with its
// key: picking one runs that format (formats.ts) or insertion (insert.ts) in
// place of the typed `/query`, as one transaction, one undo step. The list
// is a completion source like the `[[` note popup (linkCompletion.ts), so the
// two look and work alike: the query typed after the slash filters it
// (fuzzy, as the palette does), Return picks, Escape closes it and keeps the
// text, and a space ends it. It never opens where a slash is literal text:
// code, HTML, front matter, link addresses, or after another character
// (`a/b`, `1/2`, `src/x`).
import {
  completionStatus,
  currentCompletions,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import {
  EditorState,
  MapMode,
  Prec,
  StateEffect,
  StateField,
  type ChangeSet,
  type Extension,
  type Text,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { fuzzyRank } from '../../../core/fuzzy'
import { shortcutLabel } from '../commands/keys'
import { command, commandKeys, formatOf, insertOf, type CommandId } from '../commands/registry'
import { t } from '../i18n'
import { isImeKey } from '../ime'
import { alertKind } from './blocks'
import { imeKeys } from './imeKeys'
import { LINK_TRIGGER } from '../linkCompletion'
import {
  blockAround,
  context,
  inFrontMatter,
  LITERAL_BLOCKS,
  nodeAt,
  TOOLBAR_PARSE_MS,
} from './formatContext'
import { alertFormat, FORMAT_COMMANDS, formatState, type ToolbarFormat } from './formats'
import { AFTER_INSERT, INSERT_COMMANDS } from './insert'
import { QUOTE_PREFIX } from './rule'
import { inTable } from './tableCommands'

/** The menu's items, in the order an empty query lists them. */
export const SLASH_COMMANDS = [
  'format.link',
  'insert.image',
  'format.quote',
  'format.alertNote',
  'format.alertTip',
  'format.alertImportant',
  'format.alertWarning',
  'format.alertCaution',
  'insert.noteLink',
  'format.codeBlock',
  'insert.table',
  'format.bulletList',
  'format.numberedList',
  'format.taskList',
  'format.horizontalRule',
] as const satisfies readonly CommandId[]

export type SlashCommandId = (typeof SLASH_COMMANDS)[number]

/** The slash and the query typed after it, up to the cursor: no space, no other slash. */
const QUERY = /\/([^\s/]{0,32})$/
/** How far back from the cursor the slash may be. */
const LOOK_BACK = 33
/** How far back the `[[` of a note link being typed is looked for. */
const LINK_LOOK_BACK = 250

/** Syntax in which a slash is text: code, HTML, comments and link addresses. */
const NO_MENU = new Set([
  ...LITERAL_BLOCKS,
  'InlineCode',
  'URL',
  'Autolink',
  'LinkTitle',
  'HTMLTag',
  'Comment',
  'ProcessingInstruction',
])

/** Items that make the slash's line a block: in a table they would split it. */
const LINE_BLOCKS: ReadonlySet<SlashCommandId> = new Set([
  'format.quote',
  'format.alertNote',
  'format.alertTip',
  'format.alertImportant',
  'format.alertWarning',
  'format.alertCaution',
  'format.codeBlock',
  'format.bulletList',
  'format.numberedList',
  'format.taskList',
])

/** Items that go into the line's text, where the line's block does not matter. */
const INLINE: ReadonlySet<SlashCommandId> = new Set([
  'format.link',
  'insert.image',
  'insert.noteLink',
])

/** Where the menu's text is: the slash at `from`, the query up to the cursor at `to`. */
export interface SlashTrigger {
  from: number
  to: number
  query: string
}

/**
 * The `/query` before the only cursor, when its slash starts the line or
 * follows a space or tab; the syntax tree is not consulted.
 */
function typedQuery(state: EditorState): SlashTrigger | null {
  const { ranges, main } = state.selection
  if (ranges.length > 1 || !main.empty) return null
  const head = main.head
  const line = state.doc.lineAt(head)
  const start = Math.max(line.from, head - LOOK_BACK)
  const match = QUERY.exec(state.sliceDoc(start, head))
  if (!match) return null
  const from = start + match.index
  const before = from > line.from ? state.sliceDoc(from - 1, from) : ''
  if (before !== '' && before !== ' ' && before !== '\t') return null
  // A slash in the query of a note link being typed (`[[Q1 /`) is the `[[` popup's.
  if (LINK_TRIGGER.test(state.sliceDoc(Math.max(line.from, from - LINK_LOOK_BACK), from)))
    return null
  return { from, to: head, query: match[1] ?? '' }
}

/**
 * The `/query` that opens the menu, or null: one cursor, after a slash that
 * starts its line or follows a space or tab, outside code, HTML, comments,
 * front matter and link addresses. Null too while the parser has not reached
 * the cursor: unparsed code would look like text.
 */
export function slashTrigger(state: EditorState): SlashTrigger | null {
  const typed = typedQuery(state)
  if (!typed) return null
  const cx = context(state, TOOLBAR_PARSE_MS)
  if (!cx || inFrontMatter(cx, typed.from) || blockAround(cx, typed.from, NO_MENU)) return null
  return typed
}

/** The `/query` taken out: the changes, and the state an item's command runs on. */
interface QueryOut {
  changes: ChangeSet
  state: EditorState
  /** Where a placeholder stands in `state` (an inline command runs beside it), if one does. */
  placeholder?: number
}

/**
 * Stands in for the `/query` while an inline command runs. A list item that
 * was only the query is not an item without it (an empty item cannot follow a
 * paragraph's line: `- ` there is a setext underline), so the command would
 * find no text to act in; the command fills the item and the placeholder goes
 * after it.
 */
const PLACEHOLDER = 'x'

const LIST_ITEM: ReadonlySet<string> = new Set(['ListItem'])

/** Whether a list item's marker starts at `pos` in a state. */
function listMarkAt(state: EditorState, pos: number): boolean {
  const cx = context(state)
  const mark = cx && nodeAt(cx, pos)
  return mark?.name === 'ListMark' && mark.from === pos
}

/**
 * The state with `from`–`to` (the `/query`) taken out, the cursor where it
 * was. For a block item, the slash's line keeps the block it was: a list
 * item that was only the query is an empty item under a paragraph then,
 * which Markdown reads as the paragraph's text (`- ` as a setext
 * underline), so a blank line (in the line's quote) goes above it.
 */
function withoutQuery(state: EditorState, from: number, to: number, block: boolean): QueryOut {
  const remove = (extra: { from: number; insert: string }[], keep = ''): QueryOut => {
    const changes = state.changes([...extra, { from, to, insert: keep }])
    const anchor = changes.mapPos(from, -1)
    return {
      changes,
      state: state.update({ changes, selection: { anchor } }).state,
      ...(keep === '' ? {} : { placeholder: anchor }),
    }
  }
  if (!block) return remove([], PLACEHOLDER)
  const plain = remove([])
  const cx = context(state)
  const item = cx && blockAround(cx, from, LIST_ITEM)
  const mark = item?.firstChild
  const line = state.doc.lineAt(from)
  if (!item || mark?.name !== 'ListMark' || mark.from < line.from) return plain
  if (listMarkAt(plain.state, plain.changes.mapPos(mark.from))) return plain
  const bare = (QUOTE_PREFIX.exec(line.text)?.[0] ?? '').trimEnd()
  const apart = remove([{ from: line.from, insert: `${bare}\n` }])
  return listMarkAt(apart.state, apart.changes.mapPos(mark.from, 1)) ? apart : plain
}

/** What an item's command does in a state, or null when it does nothing there. */
function commandSpec(id: SlashCommandId, state: EditorState): TransactionSpec | null {
  const format = formatOf(id)
  if (format) return FORMAT_COMMANDS[format](state)
  const insert = insertOf(id)
  return insert ? INSERT_COMMANDS[insert](state) : null
}

/**
 * Whether the format is on where the cursor is, so its toggle would take it
 * off. In an alert a quote's toggle takes the alert's `> [!KIND]` line off.
 */
function takesOff(
  id: SlashCommandId,
  on: Record<ToolbarFormat, boolean>,
  alert: string | null,
): boolean {
  const format = formatOf(id)
  if (!format) return false
  if (format === 'quote' && alert !== null) return true
  return (format in on && on[format as ToolbarFormat]) || format === alert
}

/** An item the menu lists: its command, label and the letters the query matched. */
export interface SlashItem {
  id: SlashCommandId
  label: string
  ranges: [number, number][]
}

/**
 * The items for a trigger, best match first: those whose label the query
 * matches and whose command adds something where the slash is (a format
 * already on there would be taken off; a link cannot go into a link; a
 * table cell takes no block of its own).
 */
export function slashItems(state: EditorState, trigger: SlashTrigger): SlashItem[] {
  const labelled = SLASH_COMMANDS.map((id) => ({ id, label: t(command(id).label) }))
  const ranked = fuzzyRank(trigger.query, labelled, (item) => item.label)
  if (ranked.length === 0) return []
  const inline = withoutQuery(state, trigger.from, trigger.to, false).state
  const block = withoutQuery(state, trigger.from, trigger.to, true).state
  const there = (id: SlashCommandId) => (INLINE.has(id) ? inline : block)
  const on = formatState(block)
  const kind = alertKind(block)
  const alert = kind ? alertFormat(kind) : null
  // The slash is in the cell the cursor is in.
  const cell = inTable(state)
  return ranked
    .filter(({ item }) => !(cell && LINE_BLOCKS.has(item.id)))
    .filter(
      ({ item }) => !takesOff(item.id, on, alert) && commandSpec(item.id, there(item.id)) !== null,
    )
    .map(({ item, ranges }) => ({ ...item, ranges }))
}

/**
 * Picking `id` with the `/query` at `from`–`to`: the query goes and the
 * command runs where it was, as one transaction (the specs are sequential).
 * Null when the slash is gone or the command does nothing there.
 */
export function slashSpecs(
  state: EditorState,
  id: SlashCommandId,
  from: number,
  to: number,
): TransactionSpec[] | null {
  if (to < from || state.sliceDoc(from, from + 1) !== '/') return null
  const there = withoutQuery(state, from, to, !INLINE.has(id))
  const spec = commandSpec(id, there.state)
  if (!spec) return null
  const specs: TransactionSpec[] = [{ changes: there.changes }, { ...spec, sequential: true }]
  if (there.placeholder !== undefined) {
    const changes = there.state.changes(spec.changes ?? [])
    const out = placeholderOut(changes, there.placeholder, changes.apply(there.state.doc))
    if (!out) return null
    specs.push({ changes: out, sequential: true })
  }
  return specs
}

/**
 * The edit that takes the placeholder at `at` out again after an inline
 * command's `changes` (`doc` is the result), or null when the command
 * changed the placeholder itself, so it is not beside the command's text.
 */
export function placeholderOut(
  changes: ChangeSet,
  at: number,
  doc: Text,
): { from: number; to: number } | null {
  const from = changes.mapPos(at, 1)
  const to = changes.mapPos(at + PLACEHOLDER.length, -1)
  if (to - from !== PLACEHOLDER.length || doc.sliceString(from, to) !== PLACEHOLDER) return null
  return { from, to }
}

function pick(view: EditorView, id: SlashCommandId, from: number, to: number) {
  const specs = slashSpecs(view.state, id, from, to)
  if (!specs) return
  view.dispatch(...specs)
  const insert = insertOf(id)
  if (insert) AFTER_INSERT[insert]?.(view)
}

/** Records that the menu of the slash at this position was closed without a pick. */
const dismiss = StateEffect.define<number>()

/**
 * The slash whose menu was closed without a pick (Escape, or the editor
 * losing the focus), by position: that menu stays closed while the slash is
 * there, so typing on after Escape keeps the text as typed.
 */
const dismissed = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    let next = value === null ? null : tr.changes.mapPos(value, 1, MapMode.TrackAfter)
    for (const effect of tr.effects) if (effect.is(dismiss)) next = effect.value
    return next
  },
})

/** Notes a slash whose open list is about to close without a pick. */
function noteDismissal(view: EditorView) {
  if (completionStatus(view.state) === null) return
  const typed = typedQuery(view.state)
  if (typed && view.state.field(dismissed, false) !== typed.from)
    view.dispatch({ effects: dismiss.of(typed.from) })
}

/** Escape and leaving the editor close the list (the completion's own keys and blur do that). */
const dismissal = EditorView.domEventObservers({
  keydown(event, view) {
    if (event.key === 'Escape' && !isImeKey(event)) noteDismissal(view)
  },
  blur(event, view) {
    // Not when the focus goes into the list itself (a click on an item).
    const to = event.relatedTarget
    if (!(to instanceof Node && view.dom.contains(to))) noteDismissal(view)
  },
})

/** The menu's options (as opposed to other popups'), with the position of their slash. */
const optionSlash = new WeakMap<Completion, number>()

/** The menu's completion source (one function for the editor's life, as CodeMirror needs). */
export function slashSource(cx: CompletionContext): CompletionResult | null {
  if (cx.view?.composing) return null
  const trigger = slashTrigger(cx.state)
  if (!trigger || cx.state.field(dismissed, false) === trigger.from) return null
  const items = slashItems(cx.state, trigger)
  if (items.length === 0) return null
  const matched = new Map<Completion, readonly number[]>()
  const options = items.map((item): Completion => {
    const key = commandKeys(item.id)[0] as string | undefined
    const option: Completion = {
      label: item.label,
      ...(key === undefined ? {} : { detail: shortcutLabel(key) }),
      type: 'text',
      apply: (view, _completion, from, to) => pick(view, item.id, from, to),
    }
    matched.set(option, item.ranges.flat())
    optionSlash.set(option, trigger.from)
    return option
  })
  // The items are ranked already; the list keeps that order. Each key typed
  // ranks them again at once: a list waiting for a new query would ignore
  // Return (it would go to the editor as a new line).
  return {
    from: trigger.from,
    options,
    filter: false,
    getMatch: (c) => matched.get(c) ?? [],
    update: (_current, _from, _to, next) => slashSource(next),
  }
}

/**
 * The slash whose list is on screen, or null: the list is shown with the
 * slash's options, or greyed out (other completion sources rerun on each key
 * typed, and the list takes no key until they answer).
 */
const shownList = ViewPlugin.fromClass(
  class {
    slash: number | null = null
    update(update: ViewUpdate) {
      const [first] = currentCompletions(update.state)
      if (first) this.slash = optionSlash.get(first) ?? null
      else if (completionStatus(update.state) !== 'pending') this.slash = null
      else if (this.slash !== null) this.slash = update.changes.mapPos(this.slash)
    }
  },
)

/**
 * Return while the list is greyed out (about 100 ms after each key, until
 * the other completion sources answer): the list's own Return does nothing
 * then and the key would be a new line. It picks the query's best item,
 * which the list shows first once it catches up.
 */
function pickGreyedOut(view: EditorView): boolean {
  const { state } = view
  if (completionStatus(state) !== 'pending' || currentCompletions(state).length > 0) return false
  const slash = view.plugin(shownList)?.slash ?? null
  const trigger = slashTrigger(state)
  if (slash === null || trigger?.from !== slash || state.field(dismissed, false) === slash)
    return false
  const [best] = slashItems(state, trigger)
  if (!best) return false
  pick(view, best.id, trigger.from, trigger.to)
  return true
}

/** The slash menu for the note editor. */
export function slashMenu(): Extension {
  return [
    dismissed,
    dismissal,
    EditorState.languageData.of(() => [{ autocomplete: slashSource }]),
    shownList,
    // Ahead of the Markdown keymap's Return; a list that takes keys keeps its own Return.
    Prec.highest(keymap.of([{ key: 'Enter', run: pickGreyedOut }])),
    // Keys an input method composes with neither pick nor close the list:
    // WebKit can report the Return that ends a composition after it ended.
    imeKeys(),
  ]
}
