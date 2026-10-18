// The link tooltip: while the caret is anywhere in a link to a note or an
// https address (`[text](address)`, `<address>` or a bare one), a floating bar
// over the link has one button, Open Note or Open URL, with the key of the
// Open Link command. Under the line instead when the caret's line is in a
// table, where the table bar takes the place above. It shows while the editor
// has the keyboard focus, one caret and no selection are set, no completion
// list is open, and the user has not just typed or pressed Escape.
import { completionStatus } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { noteIdOf } from '../../../core/links'
import { t } from '../i18n'
import { barsMayShow } from './barRules'
import { BAR_GAP, barContent, FloatButton, floatTheme, NOTCH_X, useFloatTip } from './floating'
import { linkAt, openLinkAtCaret } from './lineCommands'
import { inTable } from './tableCommands'
import { commandTip } from './toolbarButtons'
import { releaseBarFocus, toolbarState, toolbarStateExtension } from './toolbarState'

export interface LinkTip {
  /** The link's range; the bar stands over its start. */
  from: number
  to: number
  href: string
  /** Whether the link is to a note (Open Note) or an address (Open URL). */
  note: boolean
  /** Under the line, because the table bar is above it. */
  below: boolean
}

/** Whether the caret's link is an image's address (the image bar is for those). */
function inImage(state: EditorState, pos: number): boolean {
  for (const side of [-1, 1] as const) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n.parent; n = n.parent) {
      if (n.name === 'Image') return true
    }
  }
  return false
}

/** The tooltip the caret's place calls for; null where there is none. */
export function linkTipAt(state: EditorState): LinkTip | null {
  if (!barsMayShow(state) || state.field(toolbarState, false)?.hidden) return null
  const { ranges } = state.selection
  if (ranges.length > 1 || !ranges[0]!.empty || completionStatus(state) === 'active') return null
  const head = ranges[0]!.head
  if (inImage(state, head)) return null
  const link = linkAt(state, head)
  if (!link) return null
  const note = noteIdOf(link.href) !== undefined
  if (!note && !/^https:\/\//i.test(link.href)) return null
  return { from: link.from, to: link.to, href: link.href, note, below: inTable(state) }
}

function LinkBar({ view, note }: { view: EditorView; note: boolean }) {
  const tip = useFloatTip(view)
  const label = t(note ? 'linkTip.openNote' : 'linkTip.openUrl')
  return (
    <>
      <div role="toolbar" aria-label={t('linkTip.label')} className="cm-float-buttons">
        <FloatButton
          label={label}
          icon="format.link"
          tip={commandTip('edit.openLink', label)}
          onShowTip={tip.show}
          onHideTip={tip.hide}
          onPress={() => {
            tip.hide()
            openLinkAtCaret(view)
            view.focus()
          }}
        />
      </div>
      {tip.bubble}
    </>
  )
}

function createBar(view: EditorView): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-float-bar cm-link-tip'
  const root = createRoot(barContent(dom))
  const render = (state: EditorState) => {
    const tip = linkTipAt(state)
    // Re-rendered for the link the caret is in now; the tooltip goes away without one.
    if (tip) root.render(<LinkBar view={view} note={tip.note} />)
  }
  return {
    dom,
    mount: () => flushSync(() => render(view.state)),
    update: (update) => {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((x) => x.reconfigured)
      )
        render(update.state)
    },
    offset: { x: -NOTCH_X, y: BAR_GAP },
    destroy: () => {
      releaseBarFocus(view, dom)
      queueMicrotask(() => root.unmount())
    },
  }
}

const barTooltip = showTooltip.compute(
  [toolbarState, 'selection', 'doc'],
  (state): Tooltip | null => {
    const tip = linkTipAt(state)
    return tip ? { pos: tip.from, above: !tip.below, create: createBar } : null
  },
)

const theme = EditorView.theme({ '.cm-tooltip.cm-link-tip': { width: 'max-content' } })

/** The link tooltip, for the note editor. */
export const linkTooltip: Extension = [toolbarStateExtension, barTooltip, floatTheme, theme]
