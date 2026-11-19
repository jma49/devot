import type { ScrollPane } from '../preview/scrollSync'
import type { Mode } from '../viewModes'
import { whenComplete } from '../preview/complete'

export function scrollPreviewTo(pane: ScrollPane, line: number): void {
  whenComplete(pane.complete, () => {
    pane.element.scrollTop = pane.offsetOf(line)
  })
}

export function inspectorRoom(width: number, mode: Mode, paneMin: number): number {
  return width - paneMin * (mode === 'split' ? 2 : 1)
}
