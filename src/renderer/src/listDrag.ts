import type { NoteStatus } from '../../core/storage'
import { noteCount } from './format'

export const DRAG_CARD_TITLES = 4

export function dragCardLines(titles: readonly string[], locale: string): string[] {
  if (titles.length > DRAG_CARD_TITLES) return [noteCount(titles.length, locale)]
  return [...titles]
}

/** The badge on a dragged board card: how many notes the drag carries, when it carries more than one. */
export function dragCardBadge(count: number, locale: string): string | undefined {
  return count > 1 ? new Intl.NumberFormat(locale).format(count) : undefined
}

function showAsDragImage(holder: HTMLElement, dataTransfer: DataTransfer) {
  document.body.append(holder)
  dataTransfer.setDragImage(holder, 0, 0)
  setTimeout(() => holder.remove(), 0)
}

function dragHolder(): HTMLDivElement {
  // The holder's padding is the gap between the pointer and the card.
  const holder = document.createElement('div')
  holder.className = 'drag-card-holder'
  holder.setAttribute('aria-hidden', 'true')
  return holder
}

/**
 * Sets a copy of a board card as the drag's image, lifted off the board,
 * with `dragCardBadge` in its corner when the drag carries several notes.
 * The copy is drawn off screen at the card's width, as `setDragCard` draws its card,
 * in a holder marked with the card's `column`, so the column's card rules reach it.
 */
export function setBoardDragCard(
  dataTransfer: DataTransfer,
  card: HTMLElement,
  count: number,
  locale: string,
  column: NoteStatus,
): void {
  if (typeof dataTransfer.setDragImage !== 'function') return
  const holder = dragHolder()
  holder.classList.add(`status-${column}`)
  const copy = card.cloneNode(true) as HTMLElement
  for (const name of ['id', 'aria-selected', 'data-open', 'data-dragging', 'tabindex']) {
    copy.removeAttribute(name)
  }
  copy.classList.add('drag-card-copy')
  copy.style.width = `${card.getBoundingClientRect().width}px`
  const badge = dragCardBadge(count, locale)
  if (badge) {
    const mark = document.createElement('span')
    mark.className = 'drag-card-count'
    mark.textContent = badge
    copy.append(mark)
  }
  holder.append(copy)
  showAsDragImage(holder, dataTransfer)
}

/**
 * Sets the card as the drag's image: `lines` in a small floating card that
 * sits a little right of and below the pointer. The card is drawn off screen
 * for the browser to take its picture, then removed.
 */
export function setDragCard(dataTransfer: DataTransfer, lines: readonly string[]): void {
  if (lines.length === 0 || typeof dataTransfer.setDragImage !== 'function') return
  const holder = dragHolder()
  const card = document.createElement('div')
  card.className = 'drag-card'
  for (const line of lines) {
    const item = document.createElement('div')
    item.className = 'drag-card-line'
    item.textContent = line
    card.append(item)
  }
  holder.append(card)
  showAsDragImage(holder, dataTransfer)
}
