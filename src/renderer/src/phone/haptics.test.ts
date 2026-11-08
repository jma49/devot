import { afterEach, expect, it, vi } from 'vitest'
import { invoke } from '../ipc'
import { haptic, routeHaptics } from './haptics'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))

afterEach(() => routeHaptics(null))

it('hands each haptic to the native screens', () => {
  const played = vi.fn<(kind: string) => void>()
  routeHaptics(played)
  haptic('warning')
  expect(played).toHaveBeenCalledExactlyOnceWith('warning')
})

it('plays none without the native screens and asks Rust for nothing', () => {
  haptic('selection')
  expect(vi.mocked(invoke)).not.toHaveBeenCalled()
})
