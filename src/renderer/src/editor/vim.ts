import { Compartment, Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

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
  const { vim } = await import('@replit/codemirror-vim')
  return vim()
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
