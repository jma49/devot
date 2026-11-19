import { Compartment, Facet, Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

export type VimEditingMode = 'normal' | 'insert' | 'visual' | null
export const vimModeReport = Facet.define<(mode: VimEditingMode) => void>()

const vimTheme = EditorView.theme({
  '&.cm-editor .cm-fat-cursor': {
    background: 'var(--color-text-primary)',
    color: 'var(--color-surface-editor) !important',
  },
  '&:not(.cm-focused) .cm-fat-cursor': { outlineColor: 'var(--color-text-primary)' },
  '.cm-vim-panel': {
    background: 'var(--color-surface-editor)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-family-ui)',
  },
  '.cm-vim-panel input': { color: 'var(--color-text-primary)' },
  '.cm-vim-message': { color: 'var(--color-text-secondary) !important' },
  '.cm-searchMatch': { backgroundColor: 'var(--color-accent-selection)' },
})

const loadVim = async (): Promise<Extension> => {
  const { vim, getCM } = await import('@replit/codemirror-vim')
  return [
    vim(),
    ViewPlugin.define((view) => {
      const cm = getCM(view)!
      const scroller = view.dom.closest<HTMLElement>('.editor-scroll')
      const { getScrollInfo, scrollTo } = cm
      if (scroller) {
        // Vim's local coordinates start at the content, inside the note viewport's padding.
        const origin = () => {
          const content = view.contentDOM.getBoundingClientRect()
          const box = scroller.getBoundingClientRect()
          return {
            left: content.left - box.left + scroller.scrollLeft,
            top: content.top - box.top + scroller.scrollTop,
          }
        }
        cm.getScrollInfo = () => {
          const offset = origin()
          return {
            left: scroller.scrollLeft - offset.left,
            top: scroller.scrollTop - offset.top,
            height: scroller.scrollHeight,
            width: scroller.scrollWidth,
            clientHeight: scroller.clientHeight,
            clientWidth: scroller.clientWidth,
          }
        }
        cm.scrollTo = (x, y) => {
          const offset = origin()
          if (x != null) scroller.scrollLeft = x + offset.left
          if (y != null) scroller.scrollTop = y + offset.top
        }
      }
      const report = () => {
        const state = cm.state.vim
        const mode = state?.insertMode ? 'insert' : state?.visualMode ? 'visual' : 'normal'
        for (const listener of view.state.facet(vimModeReport)) listener(mode)
      }
      cm.on('vim-mode-change', report)
      report()
      return {
        destroy: () => {
          cm.getScrollInfo = getScrollInfo
          cm.scrollTo = scrollTo
          cm.off('vim-mode-change', report)
          for (const listener of view.state.facet(vimModeReport)) listener(null)
        },
      }
    }),
  ]
}

export function vimMode(load: () => Promise<Extension> = loadVim): Extension {
  const slot = new Compartment()
  const plugin = ViewPlugin.fromClass(
    class {
      private pending: Promise<Extension> | null

      constructor(view: EditorView) {
        const request = load()
        this.pending = request
        void request.then(
          (extension) => {
            if (this.pending !== request) return
            this.pending = null
            view.dispatch({ effects: slot.reconfigure(Prec.highest([extension, vimTheme])) })
          },
          () => {
            if (this.pending !== request) return
            this.pending = null
            console.warn('W_EDITOR_VIM_LOAD_FAILED')
          },
        )
      }

      destroy() {
        this.pending = null
      }
    },
  )
  return [slot.of([]), plugin]
}
