import { noteCount } from './format'

export const DRAG_CARD_TITLES = 4

export function dragCardLines(titles: readonly string[], locale: string): string[] {
  if (titles.length > DRAG_CARD_TITLES) return [noteCount(titles.length, locale)]
  return [...titles]
}

/**
 * Sets the card as the drag's image: `lines` in a small floating card that
 * sits a little right of and below the pointer. The card is drawn off screen
 * for the browser to take its picture, then removed.
 */
export function setDragCard(dataTransfer: DataTransfer, lines: readonly string[]): void {
  if (lines.length === 0 || typeof dataTransfer.setDragImage !== 'function') return
  // The holder's padding is the gap between the pointer and the card.
  const holder = document.createElement('div')
  holder.className = 'drag-card-holder'
  holder.setAttribute('aria-hidden', 'true')
  const card = document.createElement('div')
  card.className = 'drag-card'
  for (const line of lines) {
    const item = document.createElement('div')
    item.className = 'drag-card-line'
    item.textContent = line
    card.append(item)
  }
  holder.append(card)
  document.body.append(holder)
  dataTransfer.setDragImage(holder, 0, 0)
  setTimeout(() => holder.remove(), 0)
}
