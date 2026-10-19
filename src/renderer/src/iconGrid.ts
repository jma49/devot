/**
 * The cell the arrow keys move to in a grid of `count` cells, `columns` to a
 * row, from `at`; undefined for any other key. Left and Right step one cell,
 * Up and Down a row; Home and End go to the first and last cell. It never
 * leaves the grid.
 */
export function gridStep(
  key: string,
  at: number,
  count: number,
  columns: number,
): number | undefined {
  if (count === 0) return undefined
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i))
  switch (key) {
    case 'ArrowLeft':
      return clamp(at - 1)
    case 'ArrowRight':
      return clamp(at + 1)
    case 'ArrowUp':
      return at - columns >= 0 ? at - columns : at
    case 'ArrowDown':
      return at + columns < count ? at + columns : at
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return undefined
  }
}

export function columnsOf(grid: HTMLElement | null): number {
  const cells = grid ? [...grid.children] : []
  const top = (cells[0] as HTMLElement | undefined)?.offsetTop
  const n = cells.findIndex((c) => (c as HTMLElement).offsetTop !== top)
  return n === -1 ? Math.max(1, cells.length) : n
}
