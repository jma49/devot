// The note editor's context menu: a native menu for a right-click in the
// text (or the menu key at the caret). Links get Open Link and Copy Link
// Address; a selection gets Look Up and New Note from Selection; the rest is
// the usual edit items and Speech. Cut, Copy, Paste and Select All are the
// system's own items, which act on the web view. Rust shows it, adding the
// system's spelling guesses for the word at the point, Writing Tools,
// Spelling and Grammar and Services (`systemMenu.ts`).
import { Facet, Prec, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { editorCommandKeys } from '../commands/registry'
import {
  commandEntry,
  shownGroups,
  type MenuEntry,
  type MenuGroups,
  type MenuPoint,
} from '../contextMenu'
import {
  leadingSpace,
  lookUpFont,
  lookUpLabel,
  lookUpOrigin,
  lookUpSelection,
  type LookUpFont,
} from '../textServices'
import { selectedText } from './extract'
import { linkAt } from './lineCommands'
import { registryKeys } from './registryKeys'

export type EditorAction =
  | 'openLink'
  | 'copyLink'
  | 'lookUp'
  | 'newNote'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pastePlain'
  | 'selectAll'
  | 'speech'
  | 'startSpeaking'
  | 'stopSpeaking'

/** What the menu needs to know about where it opened. */
export interface EditorMenuTarget {
  /** The address of the link at the point, if any. */
  link: string | null
  /** The selected text to look up and speak, if any. */
  selection: string | null
  /** Whether New Note from Selection can run (a selection, in a note that is not in the Trash). */
  canMakeNote: boolean
}

const hasLink = (target: EditorMenuTarget) => target.link !== null
const hasSelection = (target: EditorMenuTarget) => target.selection !== null

const SPEECH: MenuEntry<EditorAction, EditorMenuTarget>[] = [
  { action: 'startSpeaking', label: 'editorMenu.startSpeaking' },
  { action: 'stopSpeaking', label: 'editorMenu.stopSpeaking' },
]

export const EDITOR_MENU: MenuGroups<EditorAction, EditorMenuTarget> = [
  [
    commandEntry('openLink', 'edit.openLink', { label: 'editorMenu.openLink', shown: hasLink }),
    { action: 'copyLink', label: 'editorMenu.copyLink', shown: hasLink },
  ],
  [
    {
      action: 'lookUp',
      label: 'editorMenu.lookUp',
      shown: hasSelection,
      text: (target) => lookUpLabel(target.selection ?? ''),
    },
  ],
  [
    commandEntry('newNote', 'note.newFromSelection', {
      shown: (target) => target.canMakeNote,
    }),
  ],
  [
    { action: 'undo', label: 'editorMenu.undo', accelerator: 'CmdOrCtrl+Z' },
    { action: 'redo', label: 'editorMenu.redo', accelerator: 'Shift+CmdOrCtrl+Z' },
  ],
  [
    { action: 'cut', label: 'editorMenu.cut', predefined: 'Cut' },
    { action: 'copy', label: 'editorMenu.copy', predefined: 'Copy' },
    { action: 'paste', label: 'editorMenu.paste', predefined: 'Paste' },
    commandEntry('pastePlain', 'edit.pastePlain'),
    { action: 'selectAll', label: 'editorMenu.selectAll', predefined: 'SelectAll' },
  ],
  [{ action: 'speech', label: 'editorMenu.speech', submenu: SPEECH }],
]

/** Whether the menu shows `action` for a target. */
export function editorMenuShows(action: EditorAction, target: EditorMenuTarget): boolean {
  return shownGroups(EDITOR_MENU, target).some((group) =>
    group.some((entry) => entry.action === action),
  )
}

/**
 * The menu's target for a point in the text: `pos` is the position of the
 * point (null: none, as the editor's blank area), where a link is looked for.
 */
export function editorMenuTarget(
  state: EditorState,
  pos: number | null,
  canMakeNote: boolean,
): EditorMenuTarget {
  const selected = selectedText(state)
  return {
    link: pos === null ? null : (linkAt(state, pos)?.href ?? null),
    selection: lookUpSelection(state.sliceDoc(state.selection.main.from, state.selection.main.to)),
    canMakeNote: canMakeNote && selected !== null,
  }
}

/** The longest word the menu offers spelling guesses for (the same as Rust's). */
const MAX_SPELLING_WORD = 100

/** A word in the text, from `from` to `to`. */
export interface WordRange {
  from: number
  to: number
  text: string
}

/**
 * The word at `pos` the system may offer spelling guesses for: none away
 * from the text, or when a selection is something other than that word.
 */
export function spellingWordAt(state: EditorState, pos: number | null): WordRange | null {
  if (pos === null) return null
  const word = state.wordAt(pos)
  if (!word) return null
  const { from, to, empty } = state.selection.main
  if (!empty && (from !== word.from || to !== word.to)) return null
  const text = state.sliceDoc(word.from, word.to)
  if (!/^\p{L}[\p{L}\p{M}'\u2019]*$/u.test(text) || Array.from(text).length > MAX_SPELLING_WORD) {
    return null
  }
  return { from: word.from, to: word.to, text }
}

/** Puts `guess` in place of `word`, if the text still holds it there; the caret goes after it. */
export function replaceWord(view: EditorView, word: WordRange, guess: string): boolean {
  if (view.state.sliceDoc(word.from, word.to) !== word.text) return false
  view.dispatch({
    changes: { from: word.from, to: word.to, insert: guess },
    selection: { anchor: word.from + guess.length },
    userEvent: 'input.spellcheck',
  })
  view.focus()
  return true
}

/** What opens the menu for the editor: the window shows it (`pos`: where in the text, if anywhere). */
export type OpenEditorMenu = (view: EditorView, at: MenuPoint, pos: number | null) => void

const menuOpener = Facet.define<OpenEditorMenu, OpenEditorMenu | undefined>({
  combine: (all) => all[0],
})

/** The menu's key (from the registry): the menu opens at the caret. */
const menuKeys = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorCommandKeys('edit.contextMenu').map((key) => ({
        key,
        run: (view: EditorView) => {
          const open = view.state.facet(menuOpener)
          if (!open) return false
          const head = view.state.selection.main.head
          const caret = view.coordsAtPos(head)
          if (!caret) return false
          open(view, { x: caret.left, y: caret.bottom }, head)
          return true
        },
        preventDefault: true,
      })),
    ),
  ),
)

/** A right-click in the text: the caret goes to the point unless it is in the selection. */
const menuClicks = EditorView.domEventHandlers({
  contextmenu(event, view) {
    // An image under its line has a menu of its own (it prevents the default).
    if (event.defaultPrevented) return false
    const open = view.state.facet(menuOpener)
    if (!open) return false
    const point = { x: event.clientX, y: event.clientY }
    const pos = view.posAtCoords(point)
    const near = pos ?? view.posAtCoords(point, false)
    if (!view.state.selection.ranges.some((r) => near >= r.from && near <= r.to)) {
      view.dispatch({ selection: { anchor: near } })
    }
    event.preventDefault()
    open(view, point, pos)
    return true
  },
})

/** The editor's menu, with the window's `open` to show it. */
export const editorMenu = (open: OpenEditorMenu): Extension => [
  menuOpener.of(open),
  menuKeys(),
  menuClicks,
]

/**
 * Where Look Up gets the main selection (see `lookUpOrigin`) and the font it
 * draws the word in: its first character after any white space, on that
 * character's own line when the selection wraps; null without a selection
 * or when it is out of view.
 */
export function lookUpTarget(view: EditorView): { at: MenuPoint; font: LookUpFont | null } | null {
  const { from, to, empty } = view.state.selection.main
  if (empty) return null
  const start = from + leadingSpace(view.state.sliceDoc(from, to))
  // Side 1: a start at the end of a visual line is the next line's first character.
  const box = view.coordsAtPos(start, 1)
  if (!box) return null
  const element = elementAt(view, start)
  const style = element ? getComputedStyle(element) : null
  return {
    at: lookUpOrigin(box, style ? descentOf(style) : 0),
    font: style ? lookUpFont(style) : null,
  }
}

/** The element that holds the character at a position. */
function elementAt(view: EditorView, pos: number): Element | null {
  const { node, offset } = view.domAtPos(pos)
  // A position between an element's children is the start of the next one.
  const at = node instanceof Element ? (node.childNodes[offset] ?? node) : node
  return at instanceof Element ? at : at.parentElement
}

/** The descent of a computed style's font, in CSS pixels (a fifth of its size when unknown). */
function descentOf(style: CSSStyleDeclaration): number {
  const context = document.createElement('canvas').getContext('2d')
  if (context && style.font) {
    context.font = style.font
    const descent = context.measureText('x').fontBoundingBoxDescent
    if (Number.isFinite(descent) && descent > 0) return descent
  }
  return (parseFloat(style.fontSize) || 0) / 5
}
