// A quit that is called off after a window had already answered: Rust sends `devot://exit-cancelled`
// and every window starts its Markdown mirror again, since answering had stopped it (A039).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenExitCancelled, EXIT_CANCELLED_EVENT } from '../../src/renderer/src/exitCancelled'

const tauri = vi.hoisted(() => ({
  listen: vi.fn<(event: string, handler: () => void) => Promise<() => void>>(),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }))

afterEach(() => {
  vi.unstubAllGlobals()
  tauri.listen.mockReset()
})

describe('listenExitCancelled', () => {
  it('starts the window again when a held quit is called off', async () => {
    const stop = vi.fn<() => void>()
    let handler: (() => void) | undefined
    tauri.listen.mockImplementation((_event, h) => {
      handler = h
      return Promise.resolve(stop)
    })
    const restart = vi.fn<() => void>()

    const unlisten = await listenExitCancelled(restart)
    expect(tauri.listen).toHaveBeenCalledWith(EXIT_CANCELLED_EVENT, restart)
    handler?.()
    expect(restart).toHaveBeenCalledOnce()
    unlisten()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('resolves a no-op when the event cannot be heard, so the window still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tauri.listen.mockRejectedValue(new Error('E_TEST_LISTEN'))
    const restart = vi.fn<() => void>()

    const unlisten = await listenExitCancelled(restart)
    expect(() => unlisten()).not.toThrow()
    expect(restart).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('W_EXIT_CANCELLED_LISTEN_FAILED')
    warn.mockRestore()
  })
})
