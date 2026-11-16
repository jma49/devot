// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { notesLoaded } from '../externalChanges'
import { LIBRARY_REDRAW_MS, libraryWrote, useLibraryTurn } from './libraryTurn'

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

const loaded = () => act(() => void window.dispatchEvent(notesLoaded(['a'])))
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

describe('useLibraryTurn', () => {
  it('turns once a burst of changes settles, and only while watching', () => {
    vi.useFakeTimers()
    const turn = renderHook(useLibraryTurn, { props: true })
    loaded()
    act(libraryWrote)
    wait(LIBRARY_REDRAW_MS - 1)
    expect(turn.current).toBe(0)
    wait(1)
    expect(turn.current).toBe(1)
    turn.rerender(false)
    loaded()
    wait(LIBRARY_REDRAW_MS)
    expect(turn.current).toBe(1)
  })

  it('drops a waiting turn when it stops watching', () => {
    vi.useFakeTimers()
    const turn = renderHook(useLibraryTurn, { props: true })
    loaded()
    turn.rerender(false)
    wait(LIBRARY_REDRAW_MS)
    expect(turn.current).toBe(0)
  })
})
