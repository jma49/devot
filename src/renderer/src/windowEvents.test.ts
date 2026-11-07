import { expect, it, vi } from 'vitest'
import { keepListening, unlistenLater } from './windowEvents'

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

it('stops every listener of a set made together', async () => {
  const stops = [vi.fn<() => void>(), vi.fn<() => void>()]
  const cleanup = unlistenLater(Promise.resolve(stops))
  await settled()
  cleanup()
  for (const stop of stops) expect(stop).toHaveBeenCalledOnce()
})

it('is ready once the listeners are kept, so work that needs them can follow', async () => {
  const stop = vi.fn<() => void>()
  const listening = keepListening(Promise.resolve(stop))
  const after = vi.fn<() => void>()
  void listening.ready.then(after)
  expect(after).not.toHaveBeenCalled()
  await settled()
  expect(after).toHaveBeenCalledOnce()
  expect(listening.stopped()).toBe(false)
  listening.stop()
  expect(listening.stopped()).toBe(true)
  expect(stop).toHaveBeenCalledOnce()
})

it('tells the work that follows when a cleanup came before the listeners', async () => {
  const stops = [vi.fn<() => void>(), vi.fn<() => void>()]
  let give: (made: (() => void)[]) => void = () => {}
  const listening = keepListening(new Promise((resolve) => (give = resolve)))
  const stoppedWhenReady = listening.ready.then(() => listening.stopped())
  listening.stop()
  give(stops)
  expect(await stoppedWhenReady).toBe(true)
  for (const stop of stops) expect(stop).toHaveBeenCalledOnce()
})

it('rejects ready when the listeners could not be made', async () => {
  const listening = keepListening(Promise.reject(new Error('E_LISTEN')))
  await expect(listening.ready).rejects.toThrow('E_LISTEN')
})
