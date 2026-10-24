// A menu item, a deep link or an import is sent to one window; the event module's `listen` would hear
// it in every window, so the pages listen as their own window (windowEvents.ts).
import { expect, it, vi } from 'vitest'
import { listenHere } from '../../src/renderer/src/windowEvents'

const own = vi.hoisted(() => ({
  listen: vi.fn<(event: string, handler: () => void) => Promise<() => void>>(() =>
    Promise.resolve(() => {}),
  ),
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => own }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.reject(new Error('E_TEST_ANY_WINDOW')),
}))

it('listens on the page’s own window and hands back the way to stop', async () => {
  const stop = vi.fn<() => void>()
  own.listen.mockResolvedValueOnce(stop)
  const handler = vi.fn<() => void>()
  const unlisten = await listenHere('devot://show-palette', handler)
  expect(own.listen).toHaveBeenCalledWith('devot://show-palette', handler)
  unlisten()
  expect(stop).toHaveBeenCalledOnce()
})
