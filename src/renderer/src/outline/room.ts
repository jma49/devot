import type { ScrollPane } from '../preview/scrollSync'

export function scrollPreviewTo(pane: ScrollPane, line: number): void {
  pane.element.scrollTop = pane.offsetOf(line)
}

/** Whether the panes can give the outline its column and still keep every pane its least width. */
export function outlineFits(
  width: number,
  mode: 'edit' | 'split' | 'preview',
  paneMin: number,
  outline: number,
): boolean {
  return width >= paneMin * (mode === 'split' ? 2 : 1) + outline
}
