// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { LICENCE_UNKNOWN, type LicenceSnapshot } from '../licence'
import { useLicenceClock } from './licenceClock'

const DAY = 24 * 60 * 60 * 1000
const trial = (endsAt: number | null): LicenceSnapshot => ({
  ...LICENCE_UNKNOWN,
  gated: true,
  trial: { state: 'running', endsAt, code: null, source: 'keychain' },
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(DAY / 2)
})

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

it('moves on when the trial drops a day', () => {
  const clock = renderHook(useLicenceClock, { props: trial(10 * DAY) })
  expect(clock.current).toBe(DAY / 2)
  act(() => vi.advanceTimersByTime(DAY / 2 - 1))
  expect(clock.current).toBe(DAY / 2)
  act(() => vi.advanceTimersByTime(1))
  expect(clock.current).toBe(DAY)
  act(() => vi.advanceTimersByTime(DAY))
  expect(clock.current).toBe(2 * DAY)
})

it('reads the time again when the app comes back to the foreground', () => {
  const clock = renderHook(useLicenceClock, { props: trial(null) })
  vi.setSystemTime(3 * DAY)
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(clock.current).toBe(3 * DAY)
})

it('sets no timer while nothing in the row depends on the time, and leaves none behind', () => {
  const quiet = renderHook(useLicenceClock, { props: trial(null) })
  expect(vi.getTimerCount()).toBe(0)
  quiet.unmount()
  renderHook(useLicenceClock, { props: trial(10 * DAY) }).unmount()
  expect(vi.getTimerCount()).toBe(0)
})
