// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Core } from '../core-client'
import { SYNC_CHANGED } from '../sync'
import type { PhoneStore } from './usePhoneData'
import { PhoneApp } from './PhoneApp'

// Some modules read it as they load.
vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: false }))
vi.mock('../ipc', () => ({ invoke: async () => undefined }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.0.0' }))
vi.mock('./usePhoneData', () => ({ usePhoneData: () => store }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const engine = {
  startSync: vi.fn<() => Promise<void>>(async () => {}),
  stopSync: vi.fn<() => Promise<void>>(async () => {}),
  syncTouch: vi.fn<() => Promise<void>>(async () => {}),
  syncFocused: vi.fn<() => Promise<void>>(async () => {}),
  syncFlush: vi.fn<() => Promise<void>>(async () => {}),
  syncReceived: vi.fn<() => Promise<void>>(async () => {}),
}

let store: PhoneStore

const syncIs = (enabled: boolean, transport = 'icloud') =>
  act(() => {
    window.dispatchEvent(
      new CustomEvent(SYNC_CHANGED, { detail: { enabled, transport, enrolled: true } }),
    )
  })

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('DEVOT_UI_TEST', false)
  store = {
    // What the shell asks of the core besides sync finds nothing.
    core: new Proxy(engine, {
      get: (target, key) => Reflect.get(target, key) ?? (async () => undefined),
    }) as unknown as Core,
    notes: [],
    templates: [],
    books: [],
    tags: [],
    savedSearches: [],
    trash: [],
    lastBackup: null,
    loadedAt: 0,
    refresh: async () => {},
    onTakenIn: () => () => {},
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  syncIs(false)
  for (const fn of Object.values(engine)) fn.mockClear()
})

const shown = () => act(() => root.render(<PhoneApp />))

it('runs the engine while sync is on, and stops it when sync is turned off', async () => {
  shown()
  syncIs(true)
  await vi.waitFor(() => expect(engine.startSync).toHaveBeenCalledTimes(1))
  expect(engine.startSync.mock.calls[0]?.at(-1)).toBe('icloud')
  syncIs(false)
  await vi.waitFor(() => expect(engine.stopSync).toHaveBeenCalledTimes(1))
})

it('starts the engine again when the transport changes', async () => {
  shown()
  syncIs(true, 'relay')
  await vi.waitFor(() => expect(engine.startSync).toHaveBeenCalledTimes(1))
  syncIs(true, 'icloud')
  await vi.waitFor(() => expect(engine.startSync).toHaveBeenCalledTimes(2))
  expect(engine.stopSync).toHaveBeenCalledTimes(1)
})

it('stops the engine when the phone shell goes', async () => {
  shown()
  syncIs(true)
  await vi.waitFor(() => expect(engine.startSync).toHaveBeenCalledTimes(1))
  act(() => root.unmount())
  root = createRoot(host)
  await vi.waitFor(() => expect(engine.stopSync).toHaveBeenCalledTimes(1))
})

it('syncs when the app comes back to the foreground', async () => {
  shown()
  syncIs(true)
  await vi.waitFor(() => expect(engine.startSync).toHaveBeenCalledTimes(1))
  const visibility = vi.spyOn(document, 'visibilityState', 'get')
  visibility.mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(engine.syncFocused).not.toHaveBeenCalled()
  visibility.mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(engine.syncFocused).toHaveBeenCalledTimes(1)
  visibility.mockRestore()
})

it('pushes what waits to be pushed when the app goes to the background', async () => {
  shown()
  syncIs(true)
  await vi.waitFor(() => expect(engine.startSync).toHaveBeenCalledTimes(1))
  const visibility = vi.spyOn(document, 'visibilityState', 'get')
  visibility.mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.waitFor(() => expect(engine.syncFlush).toHaveBeenCalledTimes(1))
  window.dispatchEvent(new Event('pagehide'))
  await vi.waitFor(() => expect(engine.syncFlush).toHaveBeenCalledTimes(2))
  visibility.mockRestore()
})

it('runs no engine in the UI tests’ build, which has no Rust storage or socket', async () => {
  vi.stubGlobal('DEVOT_UI_TEST', true)
  shown()
  syncIs(true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(engine.startSync).not.toHaveBeenCalled()
})
