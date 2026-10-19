// The table bar: while the caret is in a Markdown table, a floating bar above
// the caret's row runs the table commands (format, align, move, add, delete).
// It shows while the editor has the keyboard focus, one caret and no selection
// are in the table, no completion list is open, and Settings > Editing >
// Toolbar is on.
import { completionStatus } from '@codemirror/autocomplete'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view'
import { Fragment } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { command, type CommandId } from '../commands/registry'
import { t } from '../i18n'
import type { IconName } from '../icons/symbols'
import { barsMayShow } from './barRules'
import {
  BAR_GAP,
  barContent,
  FloatButton,
  FloatSeparator,
  floatTheme,
  NOTCH_X,
  useFloatTip,
} from './floating'
import type { Align } from './table'
import { TABLE_COMMANDS, inTable, tableBarStatus, type TableCommandId } from './tableCommands'
import { commandTip, type Tip } from './toolbarButtons'
import { releaseBarFocus, toolbarOff, toolbarState, toolbarStateExtension } from './toolbarState'

export type TableBarId = Extract<
  TableCommandId,
  | 'format'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'alignNone'
  | 'moveRowUp'
  | 'moveRowDown'
  | 'moveColumnLeft'
  | 'moveColumnRight'
  | 'insertRowBelow'
  | 'insertColumnRight'
  | 'deleteRow'
  | 'deleteColumn'
>

export interface TableBarButton {
  id: TableBarId
  command: CommandId
  icon: IconName
}

const button = (id: TableBarId): TableBarButton => ({
  id,
  command: `table.${id}` as CommandId,
  icon: `table.${id}` as IconName,
})

export const TABLE_BAR_GROUPS: readonly (readonly TableBarButton[])[] = (
  [
    ['format'],
    ['alignLeft', 'alignCenter', 'alignRight', 'alignNone'],
    ['moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight'],
    ['insertRowBelow', 'insertColumnRight'],
    ['deleteRow', 'deleteColumn'],
  ] as const
).map((group) => group.map(button))

const label = (b: TableBarButton) => t(command(b.command).label)

export function tableBarTip(b: TableBarButton): Tip {
  return commandTip(b.command, label(b))
}

/**
 * Where the bar goes: the start of the caret's row, or null when it must not
 * show (not focused, toolbar off, text or several carets selected, a completion
 * list open, caret outside a table).
 */
export function tableBarAt(state: EditorState): { pos: number } | null {
  if (!barsMayShow(state) || state.facet(toolbarOff)) return null
  const { ranges } = state.selection
  if (ranges.length > 1 || !ranges[0]!.empty || completionStatus(state) === 'active') return null
  if (!inTable(state)) return null
  return { pos: state.doc.lineAt(state.selection.main.head).from }
}

const ALIGN_OF: Partial<Record<TableBarId, Align>> = {
  alignLeft: 'left',
  alignCenter: 'center',
  alignRight: 'right',
  alignNone: 'none',
}

function press(view: EditorView, id: TableBarId) {
  const tr = TABLE_COMMANDS[id](view.state)
  if (tr) view.dispatch(tr)
  view.focus()
}

function TableBar({ view }: { view: EditorView }) {
  const tip = useFloatTip(view)
  const status = tableBarStatus(view.state)
  return (
    <>
      <div role="toolbar" aria-label={t('tableBar.label')} className="cm-float-buttons">
        {TABLE_BAR_GROUPS.map((group, n) => (
          <Fragment key={group[0]!.id}>
            {n > 0 && <FloatSeparator />}
            {group.map((b) => (
              <FloatButton
                key={b.id}
                label={label(b)}
                icon={b.icon}
                tip={tableBarTip(b)}
                disabled={status?.disabled.has(b.id)}
                pressed={
                  ALIGN_OF[b.id] === undefined ? undefined : ALIGN_OF[b.id] === status?.align
                }
                onShowTip={tip.show}
                onHideTip={tip.hide}
                onPress={() => {
                  tip.hide()
                  press(view, b.id)
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

function createBar(view: EditorView): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-float-bar cm-table-bar'
  const root = createRoot(barContent(dom))
  const render = () => root.render(<TableBar view={view} />)
  // At most the editor's width (through the CSSOM: the production CSP allows
  // no style attributes); a narrower editor scrolls the buttons sideways.
  const fit = (width: number) => {
    const max = `${Math.max(0, Math.floor(width))}px`
    if (dom.style.maxWidth === max) return false
    dom.style.maxWidth = max
    return true
  }
  return {
    dom,
    mount: () => {
      fit(view.dom.getBoundingClientRect().width)
      flushSync(render)
    },
    positioned: (space) => {
      if (fit(space.right - space.left)) view.requestMeasure()
    },
    update: (update) => {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.reconfigured)
      )
        render()
    },
    offset: { x: -NOTCH_X, y: BAR_GAP },
    resize: false,
    destroy: () => {
      releaseBarFocus(view, dom)
      queueMicrotask(() => root.unmount())
    },
  }
}

const barTooltip = showTooltip.compute(
  [toolbarState, toolbarOff, 'selection', 'doc'],
  (state): Tooltip | null => {
    const at = tableBarAt(state)
    return at ? { pos: at.pos, above: true, create: createBar } : null
  },
)

const theme = EditorView.theme({
  '.cm-tooltip.cm-table-bar': { width: 'max-content' },
  '.cm-table-bar .cm-float-buttons': { overflowX: 'auto', scrollbarWidth: 'none' },
  '.cm-table-bar .cm-float-buttons::-webkit-scrollbar': { display: 'none' },
})

export const tableToolbar: Extension = [toolbarStateExtension, barTooltip, floatTheme, theme]
