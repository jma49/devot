// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAG_CARD_TITLES, dragCardBadge, dragCardLines, setBoardDragCard } from './listDrag'

describe('the drag card', () => {
  it('lists up to four titles, one per line', () => {
    expect(DRAG_CARD_TITLES).toBe(4)
    expect(dragCardLines(['A'], 'en')).toEqual(['A'])
    expect(dragCardLines(['A', 'B', 'C', 'D'], 'en')).toEqual(['A', 'B', 'C', 'D'])
  })

  it('shows only the count for more than four notes', () => {
    expect(dragCardLines(['A', 'B', 'C', 'D', 'E'], 'en')).toEqual(['5 notes'])
  })

  it('shows nothing for no notes', () => {
    expect(dragCardLines([], 'en')).toEqual([])
  })
})

describe('the dragged board card’s badge', () => {
  it('counts the notes a drag of several carries', () => {
    expect(dragCardBadge(3, 'en')).toBe('3')
    expect(dragCardBadge(1200, 'en')).toBe('1,200')
  })

  it('is not shown for one note', () => {
    expect(dragCardBadge(1, 'en')).toBeUndefined()
    expect(dragCardBadge(0, 'en')).toBeUndefined()
  })
})

describe('the dragged board card', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  function boardCard() {
    const card = document.createElement('li')
    card.className = 'card'
    card.id = 'card-n1'
    card.setAttribute('aria-selected', 'true')
    card.setAttribute('data-open', '')
    card.setAttribute('data-dragging', '')
    card.setAttribute('tabindex', '0')
    card.innerHTML = '<span class="card-title">Garden plan</span>'
    document.body.append(card)
    return card
  }

  function drag(count: number, column: 'active' | 'dropped' = 'active') {
    vi.useFakeTimers()
    const setDragImage = vi.fn<(image: Element, x: number, y: number) => void>()
    setBoardDragCard({ setDragImage } as unknown as DataTransfer, boardCard(), count, 'en', column)
    const holder = setDragImage.mock.calls[0]?.[0] as HTMLElement
    return { setDragImage, holder, copy: holder.querySelector<HTMLElement>('.drag-card-copy') }
  }

  it('is a copy of the card, hidden from assistive technology and drawn while the drag starts', () => {
    const { holder, copy } = drag(1)
    expect(holder.getAttribute('aria-hidden')).toBe('true')
    expect(holder.isConnected).toBe(true)
    expect(copy?.querySelector('.card-title')?.textContent).toBe('Garden plan')
    vi.runAllTimers()
    expect(holder.isConnected).toBe(false)
  })

  it('drops the card’s identity and state, so the copy looks like a card at rest', () => {
    const { copy } = drag(1)
    for (const name of ['id', 'aria-selected', 'data-open', 'data-dragging', 'tabindex']) {
      expect(copy?.hasAttribute(name)).toBe(false)
    }
  })

  it('shows the count badge only for several notes', () => {
    expect(drag(1).copy?.querySelector('.drag-card-count')).toBeNull()
    vi.runAllTimers()
    expect(drag(3).copy?.querySelector('.drag-card-count')?.textContent).toBe('3')
  })

  it('carries its column’s status, so a Dropped card keeps its secondary title', () => {
    expect(drag(1, 'dropped').holder.classList.contains('status-dropped')).toBe(true)
  })
})
