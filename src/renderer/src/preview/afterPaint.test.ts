import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { afterPaint } from './afterPaint'

let callbacks: Map<number, FrameRequestCallback>
let id: number
const frame = () => {
  const next = [...callbacks.values()]
  callbacks.clear()
  for (const callback of next) callback(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  callbacks = new Map()
  id = 0
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    callbacks.set(++id, run)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => callbacks.delete(key))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('leaves a paint opportunity before doing the work once', () => {
  const run = vi.fn<() => void>()
  afterPaint(run)
  frame()
  expect(run).not.toHaveBeenCalled()
  frame()
  expect(run).toHaveBeenCalledOnce()
  vi.runAllTimers()
  expect(run).toHaveBeenCalledOnce()
})

it('cancels both a pending frame and the hidden-window fallback', () => {
  const run = vi.fn<() => void>()
  const cancel = afterPaint(run)
  frame()
  cancel()
  frame()
  vi.runAllTimers()
  expect(run).not.toHaveBeenCalled()
})

it('finishes in a hidden window without animation frames', () => {
  const run = vi.fn<() => void>()
  afterPaint(run)
  vi.runAllTimers()
  frame()
  expect(run).toHaveBeenCalledOnce()
})

it('clears its scheduled work before a callback throws', () => {
  afterPaint(() => {
    throw new Error('E_TEST')
  })
  frame()
  expect(frame).toThrow('E_TEST')
  expect(callbacks.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
