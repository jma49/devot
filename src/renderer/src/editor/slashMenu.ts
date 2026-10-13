// The slash menu: a `/` typed at the start of a line (column 0) lists
// insertions in three groups, Basic Formatting, Alerts and Other, each row
// with an icon, a label and the Markdown it writes as a hint. Most items are
// registry commands: picking one runs that format (formats.ts) or insertion
// (insert.ts) in place of the typed `/query`, as one transaction, one undo
// step. Remote Image writes `![alt](url)` as a snippet (Tab goes from `alt`
// to `url`); Image File takes the query out and asks for image files.
//
// The text typed after the slash filters the list: a case-insensitive
// substring of the label, best match position first, then the menu's order.
// When nothing matches, the list closes and stays closed for that slash
// (Backspace does not bring it back): a new `/` opens it again. Return picks,
// Escape closes it and keeps the text. It never opens where a slash is
// literal text: code, HTML, front matter, link addresses.
import {
  completionStatus,
  currentCompletions,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  Facet,
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
import { formatOf, insertOf, type CommandId } from '../commands/registry'
import { t, type MessageKey } from '../i18n'
import type { IconName } from '../icons/symbols'
import { isImeKey } from '../ime'
import { alertKind, listBullet, type AlertKind } from './blocks'
import { openLanguageList } from './codeBlocks'
import {
  blockAround,
  context,
  inFrontMatter,
  LITERAL_TEXT,
  TOOLBAR_PARSE_MS,
} from './formatContext'
import { alertFormat, FORMAT_COMMANDS, formatState, type ToolbarFormat } from './formats'
import { imeKeys } from './imeKeys'
import { AFTER_INSERT, INSERT_COMMANDS } from './insert'
import { ALERT_ICONS, withLook } from './popupLook'
import { releaseToolbar } from './toolbarState'
import { inTable } from './tableCommands'

export type SlashGroup = 'basic' | 'alerts' | 'other'

/** The groups, in the order the menu shows them, and their headers. */
export const SLASH_GROUPS: readonly { id: SlashGroup; label: MessageKey }[] = [
  { id: 'basic', label: 'slash.groupBasic' },
  { id: 'alerts', label: 'slash.groupAlerts' },
  { id: 'other', label: 'slash.groupOther' },
]

/** What picking an item does. */
type SlashAction =
  /** Runs this registry command (a format or an insertion) in place of the query. */
  | { command: CommandId }
  /** Writes `![alt](url)` as a snippet. */
  | { remoteImage: true }
  /** Takes the query out and asks for image files (see `chooseImageFiles`). */
  | { imageFile: true }

interface SlashDef {
  id: string
  group: SlashGroup
  label: MessageKey
  icon: IconName
  /** An alert's kind: its icon takes the alert's colour. */
  tone?: AlertKind
  /** The Markdown the item writes, shown on the right. */
  hint: (state: EditorState) => string
  action: SlashAction
  /** Text in a line (where the line's block does not matter) rather than a block. */
  inline?: boolean
}

const alertItem = (kind: AlertKind): SlashDef => ({
  id: `alert-${kind}`,
  group: 'alerts',
  label: `alert.${kind}`,
  icon: ALERT_ICONS[kind],
  tone: kind,
  hint: () => `> [!${kind.toUpperCase()}]`,
  action: { command: `format.${alertFormat(kind)}` },
})

const heading = (level: 1 | 2 | 3 | 4): SlashDef => ({
  id: `heading${level}`,
  group: 'basic',
  label: `command.heading${level}`,
  icon: 'slash.heading',
  hint: () => '#'.repeat(level),
  action: { command: `format.heading${level}` },
})

/** The menu's items, in the order an empty query lists them. */
export const SLASH_ITEMS: readonly SlashDef[] = [
  {
    id: 'blockquote',
    group: 'basic',
    label: 'slash.blockquote',
    icon: 'format.quote',
    hint: () => `> ${t('format.quote')}`,
    action: { command: 'format.quote' },
  },
  {
    id: 'codeblock',
    group: 'basic',
    label: 'slash.codeblock',
    icon: 'format.code',
    hint: () => '```',
    action: { command: 'format.codeBlock' },
  },
  heading(1),
  heading(2),
  heading(3),
  heading(4),
  {
    id: 'horizontalRule',
    group: 'basic',
    label: 'format.horizontalRule',
    icon: 'slash.rule',
    hint: () => '---',
    action: { command: 'format.horizontalRule' },
  },
  {
    id: 'imageFile',
    group: 'basic',
    label: 'slash.imageFile',
    icon: 'slash.imageFile',
    hint: () => `![${t('slash.hintAlt')}](devot://file/…)`,
    action: { imageFile: true },
    inline: true,
  },
  {
    id: 'link',
    group: 'basic',
    label: 'format.link',
    icon: 'format.link',
    hint: () => `[${t('slash.hintText')}](${t('slash.hintUrl')})`,
    action: { command: 'format.link' },
    inline: true,
  },
  {
    id: 'orderedList',
    group: 'basic',
    label: 'slash.orderedList',
    icon: 'format.numberedList',
    hint: () => '1.',
    action: { command: 'format.numberedList' },
  },
  {
    id: 'remoteImage',
    group: 'basic',
    label: 'slash.remoteImage',
    icon: 'slash.remoteImage',
    hint: () => `![${t('slash.hintAlt')}](${t('slash.hintUrl')})`,
    action: { remoteImage: true },
    inline: true,
  },
  {
    id: 'taskList',
    group: 'basic',
    label: 'format.taskList',
    icon: 'format.taskList',
    hint: (state) => `${state.facet(listBullet)} [ ]`,
    action: { command: 'format.taskList' },
  },
  {
    id: 'unorderedList',
    group: 'basic',
    label: 'slash.unorderedList',
    icon: 'format.bulletList',
    hint: (state) => state.facet(listBullet),
    action: { command: 'format.bulletList' },
  },
  alertItem('caution'),
  alertItem('important'),
  alertItem('note'),
  alertItem('tip'),
  alertItem('warning'),
  {
    id: 'noteLink',
    group: 'other',
    label: 'command.insertNoteLink',
    icon: 'slash.noteLink',
    hint: () => `[${t('slash.hintTitle')}](devot://note/…)`,
    action: { command: 'insert.noteLink' },
    inline: true,
  },
]

export type SlashId = string

const itemById = new Map(SLASH_ITEMS.map((item) => [item.id, item]))

/** The slash and the query typed after it: the line up to the cursor, no other slash, no leading space. */
const QUERY = /^\/(?!\s)([^/\n]{0,32})$/

/** Where the menu's text is: the slash at `from`, the query up to the cursor at `to`. */
export interface SlashTrigger {
  from: number
  to: number
  query: string
}

/** The `/query` before the only cursor when its slash is at column 0; the syntax tree is not consulted. */
function typedQuery(doc: Text, selection: EditorSelection): SlashTrigger | null {
  const { ranges, main } = selection
  if (ranges.length > 1 || !main.empty) return null
  const head = main.head
  const line = doc.lineAt(head)
  if (head - line.from > 33) return null
  const match = QUERY.exec(doc.sliceString(line.from, head))
  if (!match) return null
  return { from: line.from, to: head, query: match[1] ?? '' }
}

/**
 * The `/query` that opens the menu, or null: one cursor, after a slash at
 * the start of its line, outside code, HTML, comments, front matter and
 * link addresses. Null too while the parser has not reached the cursor:
 * unparsed code would look like text.
 */
export function slashTrigger(state: EditorState): SlashTrigger | null {
  const typed = typedQuery(state.doc, state.selection)
  if (!typed) return null
  const cx = context(state, TOOLBAR_PARSE_MS)
  if (!cx || inFrontMatter(cx, typed.from) || blockAround(cx, typed.from, LITERAL_TEXT)) return null
  return typed
}

/** An item the label match keeps: where the query is in its label. */
interface Matched {
  item: SlashDef
  label: string
  at: number
}

const GROUP_RANK: Record<SlashGroup, number> = { basic: 0, alerts: 1, other: 2 }

/**
 * The items whose label has the query in it (any case), grouped in the
 * menu's group order and, in a group, by where the query starts in the
 * label, then in the menu's order.
 */
function matching(query: string): Matched[] {
  const q = query.toLowerCase()
  const out: (Matched & { order: number })[] = []
  SLASH_ITEMS.forEach((item, order) => {
    const label = t(item.label)
    const at = label.toLowerCase().indexOf(q)
    if (at >= 0) out.push({ item, label, at, order })
  })
  return out.sort(
    (a, b) =>
      GROUP_RANK[a.item.group] - GROUP_RANK[b.item.group] || a.at - b.at || a.order - b.order,
  )
}

/** The `/query` taken out: the changes, and the state an item's command runs on. */
interface QueryOut {
  changes: ChangeSet
  state: EditorState
  /** Where a placeholder stands in `state` (an inline command runs beside it), if one does. */
  placeholder?: number
}

/**
 * Stands in for the `/query` while an inline command runs, so the command
 * finds text of the line to act in; the command's text goes beside it and
 * it goes again after.
 */
const PLACEHOLDER = 'x'

/**
 * Where the text the menu's commands read starts: the top-level block the
 * slash is in (or starts). Blocks
 * at the top level read alone (a list, a quote or a table is one block), so
 * the states made to ask the commands can leave the text above out: parsing
 * a note again takes time in proportion to its length, even for one key.
 * 0 (all of it) when the parsed tree does not reach the slash, or the block
 * could read as front matter.
 */
function blockStart(state: EditorState, at: number): number {
  const tree = syntaxTree(state)
  let node = tree.resolveInner(at, 1)
  if (!node.parent) node = tree.resolveInner(at, -1)
  while (node.parent?.parent) node = node.parent
  if (!node.parent) return 0
  const start = state.doc.lineAt(node.from).from
  return state.sliceDoc(start, start + 3) === '---' ? 0 : start
}

/**
 * The state with `from`–`to` (the `/query`) taken out (or a placeholder in
 * its place), the cursor there; `head` leaves out the text before it (only
 * the state differs: `changes` is for the whole note when `head` is 0).
 */
function withoutQuery(
  state: EditorState,
  from: number,
  to: number,
  inline: boolean,
  head = 0,
): QueryOut {
  const keep = inline ? PLACEHOLDER : ''
  const changes = state.changes({ from, to, insert: keep })
  if (head > 0) {
    const cut = state.changes([
      { from: 0, to: head },
      { from, to, insert: keep },
    ])
    const anchor = cut.mapPos(from, -1)
    return {
      changes,
      state: state.update({ changes: cut, selection: { anchor } }).state,
      ...(inline ? { placeholder: anchor } : {}),
    }
  }
  const anchor = changes.mapPos(from, -1)
  return {
    changes,
    state: state.update({ changes, selection: { anchor } }).state,
    ...(inline ? { placeholder: anchor } : {}),
  }
}

/** The command that stands for an item where it is offered: Image File and Remote Image go where an image does. */
function commandOf(item: SlashDef): CommandId {
  return 'command' in item.action ? item.action.command : 'insert.image'
}

/** What a registry command does in a state, or null when it does nothing there. */
function commandSpec(id: CommandId, state: EditorState): TransactionSpec | null {
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
  id: CommandId,
  on: Record<ToolbarFormat, boolean>,
  alert: string | null,
): boolean {
  const format = formatOf(id)
  if (!format) return false
  if (format === 'quote' && alert !== null) return true
  return (format in on && on[format as ToolbarFormat]) || format === alert
}

/** An item the menu lists: its id, group, label, hint, icon and the letters the query matched. */
export interface SlashItem {
  id: SlashId
  group: SlashGroup
  label: string
  hint: string
  icon: IconName
  tone?: AlertKind
  ranges: [number, number][]
}

/** Whether a query matches no item's label: the menu closes for good for that slash. */
export function matchesNothing(query: string): boolean {
  return matching(query).length === 0
}

/**
 * The items for a trigger, in the menu's order: those whose label has the
 * query in it and whose command adds something where the slash is (a format
 * already on there would be taken off; a link cannot go into a link; a
 * table cell takes no block of its own).
 */
export function slashItems(state: EditorState, trigger: SlashTrigger): SlashItem[] {
  const matched = matching(trigger.query)
  if (matched.length === 0) return []
  const head = blockStart(state, trigger.from)
  const inline = withoutQuery(state, trigger.from, trigger.to, true, head).state
  const block = withoutQuery(state, trigger.from, trigger.to, false, head).state
  const there = (item: SlashDef) => (item.inline ? inline : block)
  const on = formatState(block)
  const kind = alertKind(block)
  const alert = kind ? alertFormat(kind) : null
  const cell = inTable(state)
  return matched
    .filter(({ item }) => !(cell && !item.inline && commandOf(item) !== 'format.horizontalRule'))
    .filter(
      ({ item }) =>
        !takesOff(commandOf(item), on, alert) && commandSpec(commandOf(item), there(item)) !== null,
    )
    .map(({ item, label, at }) => ({
      id: item.id,
      group: item.group,
      label,
      hint: item.hint(state),
      icon: item.icon,
      ...(item.tone ? { tone: item.tone } : {}),
      ranges: trigger.query === '' ? [] : [[at, at + trigger.query.length]],
    }))
}

/**
 * Picking `id` with the `/query` at `from`–`to`: the query goes and the
 * item's command runs where it was, as one transaction (the specs are
 * sequential). Null when the slash is gone or the command does nothing
 * there. Image File only takes the query out; Remote Image puts its snippet
 * in its place (see `pick`).
 */
export function slashSpecs(
  state: EditorState,
  id: SlashId,
  from: number,
  to: number,
): TransactionSpec[] | null {
  const item = itemById.get(id)
  if (!item || to < from || state.sliceDoc(from, from + 1) !== '/') return null
  if (!('command' in item.action)) {
    return [{ changes: { from, to }, selection: { anchor: from }, userEvent: 'input.complete' }]
  }
  const there = withoutQuery(state, from, to, item.inline === true)
  const spec = commandSpec(item.action.command, there.state)
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

/** Asks for image files and puts them in at the cursor (the editor's host provides it). */
export const chooseImageFiles = Facet.define<
  (view: EditorView) => void,
  ((view: EditorView) => void) | null
>({
  combine: (values) => values[0] ?? null,
})

/** The Remote Image snippet: `alt` selected, Tab goes to `url`. */
function remoteImageSnippet() {
  const field = (word: string) => `\${${word.replace(/[{}$\\]/g, '')}}`
  return snippet(`![${field(t('slash.hintAlt'))}](${field(t('slash.hintUrl'))})`)
}

function pick(view: EditorView, id: SlashId, from: number, to: number) {
  const item = itemById.get(id)
  if (!item) return
  if ('remoteImage' in item.action) {
    if (view.state.sliceDoc(from, from + 1) !== '/') return
    remoteImageSnippet()(view, { label: item.id }, from, to)
    return
  }
  const specs = slashSpecs(view.state, id, from, to)
  if (!specs) return
  view.dispatch(...specs)
  if ('imageFile' in item.action) {
    view.state.facet(chooseImageFiles)?.(view)
    return
  }
  const command = item.action.command
  const insert = insertOf(command)
  if (insert) AFTER_INSERT[insert]?.(view)
  if (command === 'format.codeBlock') openLanguageList(view)
}

/** Records that the menu of the slash at this position was closed without a pick. */
const dismiss = StateEffect.define<number>()

/**
 * The slash whose menu was closed without a pick (Escape, the editor losing
 * the focus, or a query that matches nothing), by position: that menu stays
 * closed while the slash is there, so typing on, or Backspace, keeps the
 * text as typed.
 */
const dismissed = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    let next = value === null ? null : tr.changes.mapPos(value, 1, MapMode.TrackAfter)
    for (const effect of tr.effects) if (effect.is(dismiss)) next = effect.value
    return next
  },
})

/** A query that matches nothing closes the menu of its slash for good. */
const dismissUnmatched = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged) return null
  const typed = typedQuery(tr.newDoc, tr.newSelection)
  if (!typed || !matchesNothing(typed.query)) return null
  const before = tr.startState.field(dismissed, false)
  if (before !== undefined && before !== null && tr.changes.mapPos(before, 1) === typed.from)
    return null
  return { effects: dismiss.of(typed.from) }
})

/** Notes a slash whose open list is about to close without a pick. */
function noteDismissal(view: EditorView) {
  if (completionStatus(view.state) === null) return
  const typed = typedQuery(view.state.doc, view.state.selection)
  if (typed && view.state.field(dismissed, false) !== typed.from)
    // The slash typed hid the selection toolbar; closing its menu hands it back.
    view.dispatch({ effects: [dismiss.of(typed.from), releaseToolbar.of(null)] })
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
    const group = SLASH_GROUPS.findIndex((g) => g.id === item.group)
    const option = withLook<Completion>(
      {
        label: item.label,
        detail: item.hint,
        section: { name: t(SLASH_GROUPS[group]?.label ?? 'slash.groupOther'), rank: group },
        apply: (view, _completion, from, to) => pick(view, item.id, from, to),
      },
      { list: 'slash', icon: item.icon, ...(item.tone ? { tone: item.tone } : {}) },
    )
    matched.set(option, item.ranges.flat())
    optionSlash.set(option, trigger.from)
    return option
  })
  // The items are in order already; the list keeps that order. Each key typed
  // lists them again at once: a list waiting for a new query would ignore
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
 * then and the key would be a new line. It picks the query's first item,
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

/** The slash menu for the note editor (its source is registered in editor/completions.ts). */
export function slashMenu(): Extension {
  return [
    dismissed,
    dismissUnmatched,
    dismissal,
    shownList,
    // Ahead of the Markdown keymap's Return; a list that takes keys keeps its own Return.
    Prec.highest(keymap.of([{ key: 'Enter', run: pickGreyedOut }])),
    // Keys an input method composes with neither pick nor close the list:
    // WebKit can report the Return that ends a composition after it ended.
    imeKeys(),
  ]
}
