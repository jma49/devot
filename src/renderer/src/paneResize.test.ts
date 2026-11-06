// @vitest-environment happy-dom
import { act, type KeyboardEvent, type PointerEvent } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook, unmountAll } from '../../../tests/support/render-hook'
import { restoreLocalStorage, useMemoryLocalStorage } from '../../../tests/support/local-storage'
import { BOARD_PANE, fittedBoardWidth } from './paneWidth'
import { usePaneResize } from './paneResize'

beforeEach(useMemoryLocalStorage)
afterEach(unmountAll)
afterAll(restoreLocalStorage)

const fitted = fittedBoardWidth(4)
const saved = () => localStorage.getItem(BOARD_PANE.key)

function pointer(clientX: number) {
  return {
    button: 0,
    clientX,
    pointerId: 1,
    preventDefault() {},
    currentTarget: { setPointerCapture() {} },
  } as unknown as PointerEvent<HTMLDivElement>
}

function key(name: string) {
  return { key: name, preventDefault() {} } as unknown as KeyboardEvent<HTMLDivElement>
}

function board() {
  return renderHook(({ shown }: { shown: number }) => usePaneResize(BOARD_PANE, shown), {
    props: { shown: fitted },
  })
}

function drag(hook: ReturnType<typeof board>, from: number, to: number) {
  act(() => hook.current.edge.onPointerDown(pointer(from)))
  act(() => hook.current.edge.onPointerMove(pointer(to)))
  act(() => hook.current.edge.onPointerUp(pointer(to)))
}

describe('the resize edge of a fitted pane', () => {
  it('shows the fitted width until the user sets one, and follows it when it changes', () => {
    const hook = board()
    expect(hook.current.width).toBe(fitted)
    hook.rerender({ shown: fittedBoardWidth(5) })
    expect(hook.current.width).toBe(fittedBoardWidth(5))
    expect(saved()).toBeNull()
  })

  it('stores nothing for a press that does not move', () => {
    const hook = board()
    drag(hook, 300, 300)
    expect(saved()).toBeNull()
    expect(hook.current.width).toBe(fitted)
  })

  it('stores the dragged width, clamped to the pane', () => {
    const hook = board()
    drag(hook, 300, 340)
    expect(hook.current.width).toBe(fitted + 40)
    expect(saved()).toBe(String(fitted + 40))
    drag(hook, 300, 300 + BOARD_PANE.max)
    expect(saved()).toBe(String(BOARD_PANE.max))
  })

  it('keeps a width the user set when a later press does not move', () => {
    const hook = board()
    drag(hook, 300, 340)
    drag(hook, 500, 500)
    expect(saved()).toBe(String(fitted + 40))
  })

  it('forgets the width on a double-click, back to the fitted one', () => {
    const hook = board()
    drag(hook, 300, 340)
    act(() => hook.current.edge.onDoubleClick())
    expect(saved()).toBeNull()
    expect(hook.current.width).toBe(fitted)
  })

  it('forgets the width on Enter, back to the fitted one', () => {
    const hook = board()
    act(() => hook.current.edge.onKeyDown(key('ArrowRight')))
    expect(saved()).toBe(String(fitted + 10))
    act(() => hook.current.edge.onKeyDown(key('Enter')))
    expect(saved()).toBeNull()
    expect(hook.current.width).toBe(fitted)
  })
})
