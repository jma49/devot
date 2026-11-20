// @vitest-environment happy-dom
import { act, type KeyboardEvent, type PointerEvent } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook, unmountAll } from '../../../tests/support/render-hook'
import { restoreLocalStorage, useMemoryLocalStorage } from '../../../tests/support/local-storage'
import { BOARD_PANE, INSPECTOR_PANE, SIDEBAR_PANE, fittedBoardWidth } from './paneWidth'
import { usePaneResize } from './paneResize'

beforeEach(useMemoryLocalStorage)
afterEach(unmountAll)
afterAll(restoreLocalStorage)

const fitted = fittedBoardWidth(4)
const saved = () => localStorage.getItem(BOARD_PANE.key)

function pointer(clientX: number, renderedWidth?: number) {
  return {
    button: 0,
    clientX,
    pointerId: 1,
    preventDefault() {},
    currentTarget: {
      setPointerCapture() {},
      parentElement: { getBoundingClientRect: () => ({ width: renderedWidth }) },
    },
  } as unknown as PointerEvent<HTMLDivElement>
}

function key(name: string, renderedWidth?: number) {
  return {
    key: name,
    preventDefault() {},
    currentTarget: { parentElement: { getBoundingClientRect: () => ({ width: renderedWidth }) } },
  } as unknown as KeyboardEvent<HTMLDivElement>
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

it('resizes the inspector from its leading edge and resets its width', () => {
  const hook = renderHook(() => usePaneResize(INSPECTOR_PANE), { props: {} })
  act(() => hook.current.edge.onPointerDown(pointer(300)))
  act(() => hook.current.edge.onPointerMove(pointer(250)))
  expect(hook.current.width).toBe(270)
  act(() => hook.current.edge.onPointerUp(pointer(320)))
  expect(hook.current.width).toBe(200)
  act(() => hook.current.edge.onDoubleClick())
  expect(hook.current.width).toBe(220)
})

describe('a sidebar clamped below its saved width', () => {
  const sidebar = () => {
    localStorage.setItem(SIDEBAR_PANE.key, '500')
    return renderHook(() => usePaneResize(SIDEBAR_PANE), { props: {} })
  }

  it('starts dragging from the rendered width, not the saved width', () => {
    const hook = sidebar()
    act(() => hook.current.edge.onPointerDown(pointer(204, 204)))
    act(() => hook.current.edge.onPointerMove(pointer(184, 204)))
    act(() => hook.current.edge.onPointerUp(pointer(184, 204)))
    expect(hook.current.width).toBe(184)
    expect(localStorage.getItem(SIDEBAR_PANE.key)).toBe('184')
  })

  it('keeps the saved width when a drag ends where it started', () => {
    const hook = sidebar()
    act(() => hook.current.edge.onPointerDown(pointer(204, 204)))
    act(() => hook.current.edge.onPointerMove(pointer(184, 204)))
    act(() => hook.current.edge.onPointerUp(pointer(204, 184)))
    expect(hook.current.width).toBe(500)
    expect(localStorage.getItem(SIDEBAR_PANE.key)).toBe('500')
  })

  it('starts keyboard resizing from the rendered width', () => {
    const hook = sidebar()
    act(() => hook.current.edge.onKeyDown(key('ArrowLeft', 204)))
    expect(hook.current.width).toBe(194)
    expect(localStorage.getItem(SIDEBAR_PANE.key)).toBe('194')
  })
})
