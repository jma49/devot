// The selection toolbar: a CodeMirror tooltip above the selection whose
// buttons run the format commands, inline formats first, then block formats.
// CodeMirror positions it through the CSSOM and styles it with constructed
// sheets, so it works under the production CSP; React renders the buttons
// into the tooltip.
import { syntaxTree } from '@codemirror/language'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  showTooltip,
  type Command,
  type KeyBinding,
  type Rect,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { formatKeyRan } from '../commands/formatMenu'
import { editorFormatKeys } from '../commands/registry'
import { headingTitle, titleWithKey } from '../commands/titles'
import { registryKeys } from './registryKeys'
import type { ShowAlertMenu } from './alertMenu'
import { formatCommand, formatState, type ToolbarFormat } from './formats'
import { hideToolbar, toolbarState, toolbarStateExtension, toolbarVisible } from './toolbarState'

interface ButtonSpec {
  id: ToolbarFormat
  label: MessageKey
  title: MessageKey
  icon: IconName
}

/**
 * A button's tooltip with its key in effect: the format command's (the
 * headings' range for Heading); the Alert pop-up has none.
 */
function toolbarTitle(b: ButtonSpec): string {
  if (b.id === 'heading') return headingTitle()
  if (b.id === 'alert') return t(b.title)
  return titleWithKey(b.title, `format.${b.id}`)
}

const INLINE_BUTTONS: ButtonSpec[] = [
  { id: 'heading', label: 'format.heading', title: 'format.headingTitle', icon: 'format.heading' },
  { id: 'bold', label: 'format.bold', title: 'format.boldTitle', icon: 'format.bold' },
  { id: 'italic', label: 'format.italic', title: 'format.italicTitle', icon: 'format.italic' },
  {
    id: 'strikethrough',
    label: 'format.strikethrough',
    title: 'format.strikethroughTitle',
    icon: 'format.strikethrough',
  },
  {
    id: 'highlight',
    label: 'format.highlight',
    title: 'format.highlightTitle',
    icon: 'format.highlight',
  },
  { id: 'link', label: 'format.link', title: 'format.linkTitle', icon: 'format.link' },
  { id: 'code', label: 'format.code', title: 'format.codeTitle', icon: 'format.code' },
]

const BLOCK_BUTTONS: ButtonSpec[] = [
  {
    id: 'codeBlock',
    label: 'format.codeBlock',
    title: 'format.codeBlockTitle',
    icon: 'format.codeBlock',
  },
  {
    id: 'bulletList',
    label: 'format.bulletList',
    title: 'format.bulletListTitle',
    icon: 'format.bulletList',
  },
  {
    id: 'numberedList',
    label: 'format.numberedList',
    title: 'format.numberedListTitle',
    icon: 'format.numberedList',
  },
  {
    id: 'taskList',
    label: 'format.taskList',
    title: 'format.taskListTitle',
    icon: 'format.taskList',
  },
  { id: 'quote', label: 'format.quote', title: 'format.quoteTitle', icon: 'format.quote' },
  { id: 'alert', label: 'format.alert', title: 'format.alertTitle', icon: 'format.alert' },
]

interface ToolbarProps {
  view: EditorView
  state: EditorState
  showAlertMenu: ShowAlertMenu
}

function FormatToolbar({ view, state, showAlertMenu }: ToolbarProps) {
  const active = formatState(state)
  const button = (b: ButtonSpec) => (
    <button
      key={b.id}
      type="button"
      className="cm-format-button"
      // Mouse only: focus stays in the editor so the selection stays.
      tabIndex={-1}
      aria-label={t(b.label)}
      aria-pressed={active[b.id]}
      // The Alert button opens a pop-up to pick the kind.
      aria-haspopup={b.id === 'alert' ? 'menu' : undefined}
      title={toolbarTitle(b)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        if (b.id === 'alert') void showAlertMenu(view, e.currentTarget)
        else formatCommand(b.id)(view)
      }}
    >
      <Icon name={b.icon} size="sm" />
    </button>
  )
  return (
    <div
      role="toolbar"
      aria-label={t('format.toolbar')}
      className="cm-format-buttons"
      data-devot-part="format-toolbar"
    >
      {INLINE_BUTTONS.map(button)}
      <div role="separator" aria-orientation="vertical" className="cm-format-separator" />
      {BLOCK_BUTTONS.map(button)}
    </div>
  )
}

/**
 * The selection's box: from the top of its first line to the bottom of its
 * last, so the toolbar goes above or below it, never over it.
 */
function selectionRect(view: EditorView): Rect | null {
  const { from, to } = view.state.selection.main
  const start = view.coordsAtPos(from, 1)
  const end = view.coordsAtPos(to, -1)
  if (!start && !end) return null
  const left = start?.left ?? end?.left ?? 0
  return {
    left,
    right: left,
    // A start scrolled out of view: only the space below the end is free.
    top: start ? Math.min(start.top, end?.top ?? start.top) : -Infinity,
    bottom: end ? Math.max(end.bottom, start?.bottom ?? end.bottom) : (start?.bottom ?? 0),
  }
}

function createToolbar(view: EditorView, showAlertMenu: ShowAlertMenu): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-format-toolbar'
  const root = createRoot(dom)
  const render = (state: EditorState) =>
    root.render(<FormatToolbar view={view} state={state} showAlertMenu={showAlertMenu} />)
  // Through the CSSOM (the production CSP allows no style attributes).
  const fit = (width: number) => {
    const max = `${Math.max(0, Math.floor(width))}px`
    if (dom.style.maxWidth === max) return false
    dom.style.maxWidth = max
    return true
  }
  return {
    dom,
    // Rendered and sized before CodeMirror measures it, so it is placed by its real size.
    mount: () => {
      fit(view.dom.getBoundingClientRect().width)
      flushSync(() => render(view.state))
    },
    // The editor's width changed (a resized window): wrap again and place it anew.
    positioned: (space) => {
      if (fit(space.right - space.left)) view.requestMeasure()
    },
    update: (update) => {
      // A tree that reached further may settle buttons the parser had not
      // reached; rebound keys (a reconfigured editor) change the tooltips.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.reconfigured) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      )
        render(update.state)
    },
    // Null (nothing of the selection is drawn) makes CodeMirror hide it.
    getCoords: () => selectionRect(view) as Rect,
    resize: false,
    // Unmount outside CodeMirror's (and possibly React's) update.
    destroy: () => queueMicrotask(() => root.unmount()),
  }
}

const toolbarTooltip = (showAlertMenu: ShowAlertMenu) => {
  const create = (view: EditorView) => createToolbar(view, showAlertMenu)
  return showTooltip.compute([toolbarState, 'selection', 'doc'], (state): Tooltip | null =>
    toolbarVisible(state) ? { pos: state.selection.main.from, above: true, create } : null,
  )
}

const hide: Command = (view) => {
  if (!toolbarVisible(view.state)) return false
  view.dispatch({ effects: hideToolbar.of(null) })
  return true
}

// The format keys come from the command registry (the keys in effect). A
// key run here is noted, so the Format menu does not run it again (see
// commands/formatMenu.ts). Above the default keymap: Mod-i would otherwise
// select the parent syntax.
const formatKeys = registryKeys(() => {
  const bindings: KeyBinding[] = [
    ...editorFormatKeys().map(({ format, key }) => {
      const run = formatCommand(format)
      return {
        key,
        run: (view: EditorView) => {
          formatKeyRan(format)
          return run(view)
        },
        preventDefault: true,
      }
    }),
    { key: 'Escape', run: hide },
  ]
  return Prec.high(keymap.of(bindings))
})

const theme = EditorView.theme({
  '.cm-tooltip.cm-format-toolbar': {
    boxSizing: 'border-box',
    // Its own width, not what is left right of the selection; at most the
    // editor's (set when placed). A narrower editor (a split pane) keeps the
    // buttons on one row and scrolls them sideways.
    width: 'max-content',
    overflowX: 'auto',
    scrollbarWidth: 'none',
    padding: 'var(--space-1)',
    boxShadow: '0 0 0 0.5px var(--color-line-hairline), 0 2px 8px var(--color-line-hairline)',
  },
  '.cm-tooltip.cm-format-toolbar::-webkit-scrollbar': { display: 'none' },
  '.cm-format-buttons': { display: 'flex', gap: 'var(--space-1)' },
  '.cm-format-button': {
    display: 'flex',
    flexShrink: '0',
    alignItems: 'center',
    justifyContent: 'center',
    width: 'var(--size-field-height)',
    height: 'var(--size-field-height)',
    padding: '0',
    border: '0',
    borderRadius: 'var(--radius-button)',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
  },
  '.cm-format-button:hover': { background: 'var(--color-fill-track)' },
  '.cm-format-separator': {
    alignSelf: 'center',
    flexShrink: '0',
    width: '1px',
    height: 'var(--size-icon-sm)',
    margin: '0 var(--space-1)',
    background: 'var(--color-line-hairline)',
  },
  '.cm-format-button[aria-pressed="true"]': {
    background: 'var(--color-fill-row-selected-unemphasized)',
    color: 'var(--color-accent-text)',
  },
  // The app's icon rules do not reach into the editor's shadow root.
  '.cm-format-button .icon': {
    display: 'inline-block',
    width: 'var(--size-icon-sm)',
    height: 'var(--size-icon-sm)',
    backgroundColor: 'currentColor',
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
  },
})

/**
 * The selection toolbar and the format shortcuts, for the note editor.
 * `showAlertMenu` opens the pop-up of the Alert button.
 */
export function formatToolbar(showAlertMenu: ShowAlertMenu): Extension {
  return [toolbarStateExtension, toolbarTooltip(showAlertMenu), formatKeys(), theme]
}
