// Hovering a link to a note in the editor shows the note's card (its title and
// the start of its body) over the link, after the app's tooltip delay. It
// stays out of the way of the floating bars: nothing shows while the
// selection toolbar, the table bar or the link tooltip is up.
import type { Extension } from '@codemirror/state'
import { EditorView, hoverTooltip } from '@codemirror/view'
import { noteIdOf } from '../../../core/links'
import { noteCardDom, noteCardTheme } from '../noteCard'
import type { LoadPreview } from '../notePreview'
import { sizes } from '../theme/tokens'
import { fadeIn } from './motion'
import { linkAt } from './lineCommands'
import { linkTipAt } from './linkTooltip'
import { tableBarAt } from './TableToolbar'
import { toolbarVisible } from './toolbarState'

const HOVER_MS = Number.parseFloat(sizes['motion.delay.tooltip'])

const theme = EditorView.theme({
  '.cm-tooltip.cm-note-card-tip': {
    border: '0',
    borderRadius: 'var(--radius-popover)',
    backgroundColor: 'var(--color-surface-popover)',
    boxShadow: '0 0 0 1px var(--color-line-hairline), var(--popover-shadow)',
    overflow: 'hidden',
    animation: fadeIn,
  },
})

/** The editor's hover cards of note links, filled by `load`. */
export function noteLinkHover(load: LoadPreview): Extension {
  return [
    hoverTooltip(
      async (view, pos, side) => {
        const state = view.state
        const link = linkAt(state, pos)
        const id = link ? noteIdOf(link.href) : undefined
        // `linkAt` also finds the link next to `pos`: the pointer must be over it.
        if (!link || !id || pos < link.from || pos > link.to) return null
        if ((pos === link.from && side < 0) || (pos === link.to && side > 0)) return null
        if (toolbarVisible(state) || tableBarAt(state) || linkTipAt(state)) return null
        // A failed load shows nothing; a note that is gone says so.
        const preview = await load(id).catch(() => undefined)
        if (preview === undefined) return null
        return {
          pos: link.from,
          end: link.to,
          above: true,
          create: () => {
            const dom = document.createElement('div')
            dom.className = 'cm-note-card-tip'
            dom.append(noteCardDom(preview))
            return { dom }
          },
        }
      },
      { hoverTime: HOVER_MS },
    ),
    theme,
    noteCardTheme,
  ]
}
