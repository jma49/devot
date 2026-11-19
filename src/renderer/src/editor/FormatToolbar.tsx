// The selection toolbar: a CodeMirror tooltip above the selection's start (below the selection only where the editor has no room above) whose
// buttons run the format commands, in three groups: inline formats and the
// link, code, then block formats; the AI button (Edit with AI) ends it. CodeMirror positions it through the CSSOM
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
import type { ShowAiMenu } from './aiMenu'
import {
  BAR_END,
  BAR_GAP,
  barContent,
  BUTTON_SIZE,
  FloatButton,
  FloatSeparator,
  floatTheme,
  NOTCH_X,
  SEPARATOR_WIDTH,
  useFloatTip,
} from './floating'
import { formatCommand, formatState, selectionHasLink, type ToolbarFormat } from './formats'
import { openLinkDialog } from './LinkDialog'
import { TOOLBAR_GROUPS, toolbarTip } from './toolbarButtons'
import { anchorRect, notchOffset } from './toolbarPlacement'
import { breaksBefore, planRows } from './toolbarRows'
import { popupBox } from './theme'
import {
  barFocusIsFree,
  hideToolbar,
  releaseBarFocus,
  toolbarOff,
  toolbarState,
  toolbarStateExtension,
  toolbarVisible,
} from './toolbarState'

interface ToolbarProps {
  view: EditorView
  state: EditorState
  showAlertMenu: ShowAlertMenu
  showAiMenu: ShowAiMenu | undefined
  /** The groups (counted from the second) that start a new row. */
  breaks: ReadonlySet<number>
}

function headingFromToolbar(view: EditorView) {
  if (!formatCommand('heading')(view)) return
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  view.dispatch({
    selection: EditorSelection.cursor(line.to),
    scrollIntoView: true,
  })
}

type ShowMenu = (view: EditorView, anchor: Element) => Promise<void>

/** Focus goes back to the editor after the menu, unless it is elsewhere now (the user may have gone to another field). */
function popUp(view: EditorView, button: HTMLElement, show: ShowMenu) {
  const bar = button.closest('.cm-float-bar')
  void show(view, button).finally(() => {
    if (view.dom.isConnected && barFocusIsFree(bar ?? button)) view.focus()
  })
}

function press(view: EditorView, id: ToolbarFormat, button: HTMLElement, props: ToolbarProps) {
  // Focus goes back to the editor: a screen reader's press focused the button.
  if (id === 'alert') popUp(view, button, props.showAlertMenu)
  else if (id === 'heading') headingFromToolbar(view)
  // A link already selected is removed; otherwise the dialog asks for its address
  // (and gives focus back to the editor when it closes).
  else if (id === 'link' && !selectionHasLink(view.state)) return openLinkDialog(view)
  else formatCommand(id)(view)
  if (id !== 'alert') view.focus()
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
            {n > 0 && <FloatSeparator broken={props.breaks.has(n)} />}
            {group.map((b) => (
              <FloatButton
                key={b.id}
                label={t(b.label)}
                icon={b.icon}
                tip={toolbarTip(b)}
                pressed={active[b.id]}
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
        {props.showAiMenu ? (
          <>
            <FloatSeparator broken={props.breaks.has(TOOLBAR_GROUPS.length)} />
            <FloatButton
              label={t('aiEdit.button')}
              icon="format.ai"
              tip={{ title: t('aiEdit.button') }}
              popup
              onShowTip={tip.show}
              onHideTip={tip.hide}
              onPress={(el) => {
                tip.hide()
                if (props.showAiMenu) popUp(view, el, props.showAiMenu)
              }}
            />
          </>
        ) : null}
      </div>
      {tip.bubble}
    </>
  )
}

/** The editor's box: the visible area the selection's start must be in. */
function visibleArea(view: EditorView): Rect {
  const root = view.dom.getRootNode()
  return (root instanceof ShadowRoot ? root.host : view.dom).getBoundingClientRect()
}

function createToolbar(
  view: EditorView,
  showAlertMenu: ShowAlertMenu,
  showAiMenu: ShowAiMenu | undefined,
): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-float-bar cm-format-toolbar'
  const root = createRoot(barContent(dom))
  let breaks: ReadonlySet<number> = new Set()
  const render = (state: EditorState) =>
    root.render(
      <FormatToolbar
        view={view}
        state={state}
        showAlertMenu={showAlertMenu}
        showAiMenu={showAiMenu}
        breaks={breaks}
      />,
    )
  const groupWidths = [
    ...TOOLBAR_GROUPS.map((group) => group.length * BUTTON_SIZE),
    ...(showAiMenu ? [BUTTON_SIZE] : []),
  ]
  // Through the CSSOM (the production CSP allows no style attributes). The
  // buttons wrap between groups, never past the editor's width, and the bar is
  // as wide as its widest row; a bar that fits keeps one row at its own width.
  let layout = ''
  let rowsKey = ''
  const fit = (space: { left: number; right: number }) => {
    const width = Math.max(0, Math.floor(space.right - space.left))
    const plan = planRows(groupWidths, SEPARATOR_WIDTH, width - 2 * BAR_END)
    const key = `${width} ${plan.rows.join()} ${plan.width}`
    if (key === layout) return { resized: false, rewrapped: false }
    layout = key
    const rewrapped = plan.rows.join() !== rowsKey
    rowsKey = plan.rows.join()
    const wrapped = plan.rows.length > 1
    breaks = breaksBefore(plan.rows)
    dom.style.maxWidth = `${width}px`
    dom.style.width = wrapped ? `${plan.width + 2 * BAR_END}px` : ''
    dom.toggleAttribute('data-wrapped', wrapped)
    if (wrapped) dom.style.setProperty('--float-rows', String(plan.rows.length))
    else dom.style.removeProperty('--float-rows')
    return { resized: true, rewrapped }
  }
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
      fit(popupBox(view))
      flushSync(() => render(view.state))
    },
    // The editor's width changed (a resized window): wrap again and place it anew.
    positioned: (space) => {
      const { resized, rewrapped } = fit(space)
      if (rewrapped) flushSync(() => render(view.state))
      if (resized) view.requestMeasure()
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
    offset: { x: -NOTCH_X, y: BAR_GAP },
    resize: false,
    // Unmount outside CodeMirror's (and possibly React's) update.
    destroy: () => {
      releaseBarFocus(view, dom)
      queueMicrotask(() => root.unmount())
    },
  }
}

const toolbarTooltip = (showAlertMenu: ShowAlertMenu, showAiMenu: ShowAiMenu | undefined) => {
  const create = (view: EditorView) => createToolbar(view, showAlertMenu, showAiMenu)
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
    // editor's (set when placed).
    width: 'max-content',
  },
  // Too many buttons for one row: the rows are `size.float-toolbar-height` each,
  // wrapped between groups, and a separator at a break stands across the bar as
  // the line break. Its width is set when placed.
  '.cm-tooltip.cm-float-bar.cm-format-toolbar[data-wrapped]': {
    height: 'auto',
    paddingBlock: '0',
  },
  '.cm-format-toolbar[data-wrapped] .cm-float-content': { display: 'block', width: '100%' },
  '.cm-format-toolbar[data-wrapped] .cm-float-buttons': { flexWrap: 'wrap', width: '100%' },
  '.cm-format-toolbar[data-wrapped] .cm-float-button': {
    marginBlock: 'var(--size-float-toolbar-end)',
  },
  '.cm-format-toolbar .cm-float-separator[data-break]': {
    flexBasis: '100%',
    height: '0',
    margin: '0',
    border: '0',
  },
})

/** The selection toolbar and the format shortcuts; `showAlertMenu` opens the Alert button's pop-up, `showAiMenu` (the AI button, left out without it) the AI presets. */
export function formatToolbar(showAlertMenu: ShowAlertMenu, showAiMenu?: ShowAiMenu): Extension {
  return [
    toolbarStateExtension,
    toolbarTooltip(showAlertMenu, showAiMenu),
    formatKeys(),
    floatTheme,
    theme,
  ]
}
