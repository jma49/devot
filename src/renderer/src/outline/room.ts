import type { ScrollPane } from '../preview/scrollSync'
import type { Mode } from '../viewModes'

export function scrollPreviewTo(pane: ScrollPane, line: number): void {
  pane.element.scrollTop = pane.offsetOf(line)
}

export function inspectorRoom(width: number, mode: Mode, paneMin: number): number {
  return width - paneMin * (mode === 'split' ? 2 : 1)
}
