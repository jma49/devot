// The selection toolbar: a CodeMirror tooltip above the selection's start (below the selection only where the editor has no room above) whose
// buttons run the format commands, in three groups: inline formats and the
// link, code, then block formats. CodeMirror positions it through the CSSOM
// and styles it with constructed sheets, so it works under the production
// CSP; React renders the buttons into the tooltip.
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, Prec, type EditorState, type Extension } from '@codemirror/state'
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
import { Fragment } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { t } from '../i18n'
import { formatKeyRan } from '../commands/formatMenu'
import { editorFormatKeys } from '../commands/registry'
import { registryKeys } from './registryKeys'
import type { ShowAlertMenu } from './alertMenu'
import { BAR_GAP, FloatButton, FloatSeparator, floatTheme, NOTCH_X, useFloatTip } from './floating'
import { formatCommand, formatState, selectionHasLink, type ToolbarFormat } from './formats'
import { openLinkDialog } from './LinkDialog'
import { TOOLBAR_GROUPS, toolbarTip } from './toolbarButtons'
import { anchorRect, notchOffset } from './toolbarPlacement'
import {
  hideToolbar,
  toolbarOff,
  toolbarState,
  toolbarStateExtension,
  toolbarVisible,
} from './toolbarState'

interface ToolbarProps {
  view: EditorView
  state: EditorState
  showAlertMenu: ShowAlertMenu
}

/** Heading from the toolbar: one level up, then the caret goes to the end of the line. */
function headingFromToolbar(view: EditorView) {
  if (!formatCommand('heading')(view)) return
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  view.dispatch({ selection: EditorSelection.cursor(line.to), scrollIntoView: true })
}

function press(view: EditorView, id: ToolbarFormat, button: HTMLElement, props: ToolbarProps) {
  if (id === 'alert') void props.showAlertMenu(view, button)
  else if (id === 'heading') headingFromToolbar(view)
  // A link already selected is removed; otherwise the dialog asks for its address.
  else if (id === 'link' && !selectionHasLink(view.state)) openLinkDialog(view)
  else formatCommand(id)(view)
}

function FormatToolbar(props: ToolbarProps) {
  const { view, state } = props
  const active = formatState(state)
  const tip = useFloatTip(view)
  return (
    <>
      <div
        role="toolbar"
        aria-label={t('format.toolbar')}
        className="cm-float-buttons"
        data-devot-part="format-toolbar"
      >
        {TOOLBAR_GROUPS.map((group, n) => (
          <Fragment key={group[0]!.id}>
            {n > 0 && <FloatSeparator />}
            {group.map((b) => (
              <FloatButton
                key={b.id}
                label={t(b.label)}
                icon={b.icon}
                tip={toolbarTip(b)}
                pressed={active[b.id]}
                // The Alert button opens a pop-up to pick the kind.
                popup={b.id === 'alert'}
                onShowTip={tip.show}
                onHideTip={tip.hide}
                onPress={(el) => {
                  tip.hide()
                  press(view, b.id, el, props)
                }}
              />
            ))}
          </Fragment>
        ))}
      </div>
      {tip.bubble}
    </>
  )
}

/**
 * The editor's box, which scrolls and clips its popups (see the note
 * editor's tooltip space): the visible area the selection's start must be in.
 */
function visibleArea(view: EditorView): Rect {
  const root = view.dom.getRootNode()
  return (root instanceof ShadowRoot ? root.host : view.dom).getBoundingClientRect()
}

function createToolbar(view: EditorView, showAlertMenu: ShowAlertMenu): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-float-bar cm-format-toolbar'
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
  // The notch follows the anchor when the bar is held back at an edge.
  let anchorX = 0
  const aimNotch = () => {
    const box = dom.getBoundingClientRect()
    const x = notchOffset(anchorX, box.left, box.width, NOTCH_X)
    dom.style.setProperty('--float-notch-x', `${x}px`)
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
      aimNotch()
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
    // The line box at the selection's start; null (scrolled out of the
    // editor's box) makes CodeMirror hide the bar until it scrolls back in.
    getCoords: (pos) => {
      const anchor = anchorRect(
        view.coordsAtPos(pos, 1),
        view.coordsAtPos(view.state.selection.main.to, -1),
        visibleArea(view),
      )
      anchorX = anchor?.left ?? anchorX
      return anchor as Rect
    },
    // The notch points at the selection's start, a little away from its line.
    offset: { x: -NOTCH_X, y: BAR_GAP },
    resize: false,
    // Unmount outside CodeMirror's (and possibly React's) update.
    destroy: () => queueMicrotask(() => root.unmount()),
  }
}

const toolbarTooltip = (showAlertMenu: ShowAlertMenu) => {
  const create = (view: EditorView) => createToolbar(view, showAlertMenu)
  return showTooltip.compute(
    [toolbarState, toolbarOff, 'selection', 'doc'],
    (state): Tooltip | null =>
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
    // Its own width, not what is left right of the selection; at most the
    // editor's (set when placed). A narrower editor (a split pane) keeps the
    // buttons on one row and scrolls them sideways.
    width: 'max-content',
  },
  '.cm-format-toolbar .cm-float-buttons': { overflowX: 'auto', scrollbarWidth: 'none' },
  '.cm-format-toolbar .cm-float-buttons::-webkit-scrollbar': { display: 'none' },
})

/**
 * The selection toolbar and the format shortcuts, for the note editor.
 * `showAlertMenu` opens the pop-up of the Alert button.
 */
export function formatToolbar(showAlertMenu: ShowAlertMenu): Extension {
  return [toolbarStateExtension, toolbarTooltip(showAlertMenu), formatKeys(), floatTheme, theme]
}
