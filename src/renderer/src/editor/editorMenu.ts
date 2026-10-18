// The note editor's context menu: a native menu for a right-click in the
// text (or the menu key at the caret). Links get Open Link and Copy Link
// Address; a selection gets Look Up and New Note from Selection; the rest is
// the usual edit items and Speech. Cut, Copy, Paste and Select All are the
// system's own items, which act on the web view.
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
import { lookUpLabel, lookUpSelection } from '../textServices'
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
