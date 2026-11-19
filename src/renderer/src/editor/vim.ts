import { Compartment, Facet, Prec, type Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView } from '@codemirror/view'

export type VimEditingMode = 'normal' | 'insert' | 'visual' | null
export const vimModeReport = Facet.define<(mode: VimEditingMode) => void>()

const loadVim = async (): Promise<Extension> => (await import('./vimExtension')).loadVim()

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
            view.dispatch({ effects: slot.reconfigure(Prec.highest(extension)) })
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
