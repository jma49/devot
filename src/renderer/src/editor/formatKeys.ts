// Tells the Format menu which formats do nothing where the caret is. The
// menu offers a format's key only where the format applies (see
// `commands/formatMenu.ts`), so a key such as Cmd+I reaches the editor's other
// bindings in code. The caret moves and text changes in bursts, so this waits
// for them to pause; only a change in the answer is reported.
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { inertFormats, type FormatId } from './formats'

/** How long the caret and text stay still before the formats are tried. */
export const INERT_DELAY_MS = 150

/**
 * Reports the formats that do nothing at the selection to `report`, now and
 * after each pause in editing or selecting; an empty list when the editor
 * goes away.
 */
export function formatKeyAvailability(report: (inert: readonly FormatId[]) => void): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private timer: ReturnType<typeof setTimeout> | undefined
      private last = ''

      constructor(private readonly view: EditorView) {
        this.schedule()
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged) this.schedule()
      }

      private schedule() {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.run(), INERT_DELAY_MS)
      }

      private run() {
        const inert = inertFormats(this.view.state)
        const key = inert.join(',')
        if (key === this.last) return
        this.last = key
        report(inert)
      }

      destroy() {
        clearTimeout(this.timer)
        if (this.last !== '') report([])
      }
    },
  )
}
