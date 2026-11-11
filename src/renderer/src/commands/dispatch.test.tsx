// @vitest-environment happy-dom
import { act, useLayoutEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', true))

const { useMenuEvent } = await import('./dispatch')

afterEach(() => unmountAll())

it('runs the handler of the render on screen for a menu event that follows a change at once', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const seen: number[] = []
  // The sidebar's menu item toggles what the last render showed. A second pick right after the
  // first one's change was on screen ran the handler of the render before it, and undid nothing.
  const hook = renderHook(
    () => {
      const [count, setCount] = useState(0)
      useMenuEvent('devot://probe', 'devot:probe', () => seen.push(count))
      useLayoutEffect(() => {
        if (count === 1) window.dispatchEvent(new CustomEvent('devot:probe'))
      }, [count])
      return setCount
    },
    { props: undefined },
  )
  act(() => hook.current(1))
  expect(seen).toEqual([1])
})
