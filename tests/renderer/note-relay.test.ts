// A window must hear the relay before its core asks for what it lacks (`want`): the answer comes
// back on the event the page listens to, and Tauri registers a listener only after an IPC round.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relayLink } from '../../src/renderer/src/noteRelay'
import type { WireRelay } from '../../src/renderer/src/noteRelayWire'

type Handler = (event: { payload: WireRelay }) => void

const tauri = vi.hoisted(() => ({
  handlers: [] as Handler[],
  register: undefined as ((ok: boolean) => void) | undefined,
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    listen: (_event: string, handler: Handler) =>
      new Promise<() => void>((resolve, reject) => {
        tauri.register = (ok) => {
          if (!ok) return reject(new Error('denied'))
          tauri.handlers.push(handler)
          resolve(() => {
            tauri.handlers = tauri.handlers.filter((h) => h !== handler)
          })
        }
      }),
  }),
}))

vi.mock('../../src/renderer/src/ipc', () => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
}))

const want: WireRelay = { kind: 'want', noteId: 'n1', data: '' }

beforeEach(() => {
  vi.stubGlobal('DEVOT_UI_TEST', false)
  tauri.handlers = []
  tauri.register = undefined
})
afterEach(() => vi.unstubAllGlobals())

async function track<T>(work: Promise<T>) {
  let done = false
  void work.finally(() => (done = true)).catch(() => {})
  await vi.waitFor(() => expect(tauri.register).toBeDefined())
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { work, done: () => done }
}

describe('relayLink', () => {
  it('resolves its listen only once the listener is registered', async () => {
    const heard: WireRelay[] = []
    const listening = await track(relayLink('note-n1').listen((m) => heard.push(m)))
    expect(listening.done()).toBe(false)
    tauri.register?.(true)
    const stop = await listening.work
    tauri.handlers.forEach((h) => h({ payload: want }))
    expect(heard).toEqual([want])
    stop()
    expect(tauri.handlers).toEqual([])
  })

  it('resolves even when the listener cannot be registered, so the window still opens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const listening = await track(relayLink('main').listen(() => {}))
    tauri.register?.(false)
    const stop = await listening.work
    expect(() => stop()).not.toThrow()
    expect(warn).toHaveBeenCalledWith('W_NOTE_RELAY_LISTEN_FAILED')
    warn.mockRestore()
  })
})
