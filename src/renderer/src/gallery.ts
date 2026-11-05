// The note list as a gallery: cards of one size in rows, as many across as the
// pane fits. Every card has the same height, so where a card sits and which
// cards show follow from its index alone, and a gallery of thousands renders
// only the rows near the part that shows.

/** Rows rendered before the gallery has been measured. */
const FIRST_ROWS = 8

/** How many cards of at least `minWidth`, `gap` apart, fit across `width`; never fewer than one. */
export function galleryColumns(width: number, minWidth: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)))
}

/** The zoom that fits a page laid out at `pageWidth` into a card `width` wide less its `inset` (cell and sheet padding). */
export function galleryScale(width: number, inset: number, pageWidth: number): number {
  return Math.max(0, width - inset) / pageWidth
}

export function galleryPlace(index: number, columns: number): { row: number; column: number } {
  return { row: Math.floor(index / columns), column: index % columns }
}

/**
 * How far below the top of the scrolled content the grid starts, from the
 * client rectangles of the scroller and the grid: an offset parent outside
 * the scroller would count what sits above it too.
 */
export function galleryGridTop(
  scroller: { top: number; scrollTop: number; clientTop: number },
  grid: { top: number },
): number {
  return grid.top - scroller.top - scroller.clientTop + scroller.scrollTop
}

/** The scroll offset that shows the card at `index` whole, moving as little as it can; a card of the first row shows the top of the gallery. */
export function galleryReveal(
  index: number,
  columns: number,
  rowStep: number,
  cardHeight: number,
  view: { gridTop: number; scrollTop: number; height: number },
): number {
  const { row } = galleryPlace(index, columns)
  const top = row === 0 ? 0 : view.gridTop + row * rowStep
  if (top < view.scrollTop) return top
  const bottom = view.gridTop + row * rowStep + cardHeight
  if (bottom > view.scrollTop + view.height) return bottom - view.height
  return view.scrollTop
}

/**
 * The card an arrow key moves to from `at`, among `count` cards `columns`
 * across, or undefined where it stops: Left and Right go one card on (into
 * the next row at a row's end), Up and Down a row. Down from a row whose
 * next row is too short for that column goes to the last card.
 */
export function galleryStep(
  at: number,
  count: number,
  columns: number,
  key: string,
  rtl = false,
): number | undefined {
  if (count === 0 || at < 0 || at >= count) return undefined
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
  const back = rtl ? 'ArrowRight' : 'ArrowLeft'
  let to: number | undefined
  if (key === forward) to = at + 1
  else if (key === back) to = at - 1
  else if (key === 'ArrowUp') to = at - columns
  else if (key === 'ArrowDown') {
    const lastRow = Math.floor((count - 1) / columns)
    if (Math.floor(at / columns) < lastRow) to = Math.min(at + columns, count - 1)
  }
  return to !== undefined && to >= 0 && to < count ? to : undefined
}

/**
 * The indexes of the cards to render, in order: the rows of `view` (offsets
 * from the grid's top) and `overscan` beyond it on each side, rows
 * `rowStep` apart, and the cards of `kept` wherever they are. Before the
 * gallery is measured (`view` null), its first rows.
 */
export function galleryWindow(
  count: number,
  columns: number,
  rowStep: number,
  view: { top: number; height: number } | null,
  overscan: number,
  kept: readonly number[],
): number[] {
  if (count === 0) return []
  const rows = Math.ceil(count / columns)
  let first = 0
  let last = Math.min(rows, FIRST_ROWS) - 1
  if (view && rowStep > 0) {
    first = Math.max(0, Math.floor((view.top - overscan) / rowStep))
    last = Math.min(rows - 1, Math.ceil((view.top + view.height + overscan) / rowStep) - 1)
  }
  const from = first * columns
  const to = Math.min(count, (last + 1) * columns)
  const extra = kept.filter(
    (i) => Number.isInteger(i) && i >= 0 && i < count && (i < from || i >= to),
  )
  const shown: number[] = []
  for (let i = from; i < to; i += 1) shown.push(i)
  if (extra.length === 0) return shown
  return [...new Set([...shown, ...extra])].sort((a, b) => a - b)
}
