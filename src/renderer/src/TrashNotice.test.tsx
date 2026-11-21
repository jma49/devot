// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sizes } from './theme/tokens'
import { TrashNotice } from './TrashNotice'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STAYS = Number.parseFloat(sizes['motion.duration.notice-undo'])

function show(count: number) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onUndo = vi.fn<() => void>()
  const onDismiss = vi.fn<() => void>()
  act(() => root.render(<TrashNotice count={count} onUndo={onUndo} onDismiss={onDismiss} />))
  const notice = host.querySelector<HTMLElement>('.notice')!
  return {
    notice,
    onUndo,
    onDismiss,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

describe('TrashNotice', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('counts the notes and offers Undo', () => {
    const { notice, onUndo, unmount } = show(3)
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('Moved 3 notes to the Trash.')
    act(() => notice.querySelector<HTMLButtonElement>('button')!.click())
    expect(onUndo).toHaveBeenCalledOnce()
    unmount()
  })

  it('goes by itself once its time is up', () => {
    const { onDismiss, unmount } = show(1)
    act(() => vi.advanceTimersByTime(STAYS - 1))
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onDismiss).toHaveBeenCalledOnce()
    unmount()
  })

  it('stays while the pointer is on it and starts its time again when it leaves', () => {
    const { notice, onDismiss, unmount } = show(1)
    act(() => vi.advanceTimersByTime(STAYS - 100))
    act(() => notice.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    act(() => notice.dispatchEvent(new PointerEvent('pointerenter')))
    act(() => vi.advanceTimersByTime(STAYS * 2))
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => notice.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })))
    act(() => notice.dispatchEvent(new PointerEvent('pointerleave')))
    act(() => vi.advanceTimersByTime(STAYS))
    expect(onDismiss).toHaveBeenCalledOnce()
    unmount()
  })

  it('stays while the keyboard is in it', () => {
    const { notice, onDismiss, unmount } = show(1)
    act(() => notice.querySelector<HTMLButtonElement>('button')!.focus())
    act(() => vi.advanceTimersByTime(STAYS * 2))
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => notice.querySelector<HTMLButtonElement>('button')!.blur())
    act(() => vi.advanceTimersByTime(STAYS))
    expect(onDismiss).toHaveBeenCalledOnce()
    unmount()
  })
})
