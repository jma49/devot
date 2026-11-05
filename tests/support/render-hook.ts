// Hook tests run under happy-dom (`// @vitest-environment happy-dom` in the test file).
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted = new Set<() => void>()

/** Unmounts what the test left mounted, so its listeners do not hear the next test. */
export function unmountAll() {
  for (const unmount of [...mounted]) unmount()
}

export function renderHook<P, R>(
  hook: (props: P) => R,
  { props, strict = false }: { props: P; strict?: boolean },
) {
  const result: { current: R | undefined } = { current: undefined }
  function Probe({ shown }: { shown: P }) {
    result.current = hook(shown)
    return null
  }
  const root = createRoot(document.createElement('div'))
  const render = (shown: P) => {
    const probe = createElement(Probe, { shown })
    root.render(strict ? createElement(StrictMode, null, probe) : probe)
  }
  act(() => render(props))
  const unmount = () => {
    if (mounted.delete(unmount)) act(() => root.unmount())
  }
  mounted.add(unmount)
  return {
    get current(): R {
      return result.current as R
    },
    rerender: (next: P) => act(() => render(next)),
    unmount,
  }
}

/** Lets pending promise callbacks and the renders they start run. */
export const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
