import { expect, it, vi } from 'vitest'
import { unlistenLater } from './windowEvents'

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

it('stops a listener that is already made when cleaned up', async () => {
  const stop = vi.fn<() => void>()
  const cleanup = unlistenLater(Promise.resolve(stop))
  await settled()
  expect(stop).not.toHaveBeenCalled()
  cleanup()
  expect(stop).toHaveBeenCalledOnce()
})

it('stops a listener made after the cleanup as soon as it arrives', async () => {
  const stop = vi.fn<() => void>()
  let give: (stop: () => void) => void = () => {}
  const cleanup = unlistenLater(new Promise((resolve) => (give = resolve)))
  cleanup()
  give(stop)
  await settled()
  expect(stop).toHaveBeenCalledOnce()
})

it('tells `failed` when the listener could not be made', async () => {
  const failed = vi.fn<(e: unknown) => void>()
  unlistenLater(Promise.reject(new Error('E_LISTEN')), failed)
  await settled()
  expect(failed).toHaveBeenCalledOnce()
})
