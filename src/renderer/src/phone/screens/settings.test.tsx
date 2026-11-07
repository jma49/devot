// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '../../ipc'
import { readCurrentLicence } from '../../licence'
import { closePurchase } from '../../purchaseSheet'
import { PhoneApp } from '../PhoneApp'
import { closeGate, requireEditing } from '../requireEditing'
import { setTestCore, shownEditors, testCore } from '../testShell'
import type { ScreensNotice } from './message'
import type { ScreensHandlers } from './ops'
import { settingsHandlers } from './settings'

vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: true }))
const bridge = vi.hoisted(() => ({
  handlers: {} as ScreensHandlers,
  notices: [] as ScreensNotice[],
}))
vi.mock('./bridge', () => ({
  startScreensBridge: (handlers: ScreensHandlers) => {
    bridge.handlers = handlers
    return {
      installed: Promise.resolve(true),
      notify: (notice: ScreensNotice) => bridge.notices.push(notice),
      stop: () => {},
    }
  },
}))
vi.mock('../../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.0.0' }))
vi.mock('../usePhoneData', async () => ({
  usePhoneData: (await import('../testShell')).useTestPhoneData,
}))
vi.mock('../../NoteEditor', async () => ({ NoteEditor: (await import('../testShell')).TestEditor }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const PRO = {
  gated: false,
  state: 'valid',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: null,
  activation: null,
  appStore: null,
}

let host: HTMLDivElement
let root: Root
let shell: ReturnType<typeof testCore>

beforeEach(async () => {
  localStorage.clear()
  shownEditors.length = 0
  bridge.handlers = {}
  bridge.notices = []
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? PRO : undefined,
  )
  await readCurrentLicence()
  shell = testCore()
  setTestCore(shell.core)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    closeGate()
    closePurchase()
    root.unmount()
  })
  setTestCore(null)
  host.remove()
  document.body.innerHTML = ''
  vi.mocked(invoke).mockReset()
  vi.restoreAllMocks()
})

const shownStack = () => host.querySelector('.phone-stack:not([hidden])')!
const screens = () =>
  [...shownStack().querySelectorAll(':scope > .phone-layer:not([data-away])')].map((layer) =>
    layer.querySelector('section')?.getAttribute('aria-label'),
  )

async function start() {
  await act(async () => root.render(<PhoneApp />))
  await vi.waitFor(() => expect(screens()).toEqual(['Library']))
  await act(async () => {})
}

async function swift(
  op: 'tabs.show' | 'tabs.popToRoot' | 'settings.showPane' | 'settings.notebooks',
  args = {},
) {
  let result: unknown
  await act(async () => {
    result = await bridge.handlers[op]!(args)
  })
  return result
}

describe('the page under the native Settings', () => {
  it('shows a pane Swift asks for over the Settings root, under the native bar', async () => {
    await start()
    await swift('tabs.show', { tab: 'settings' })
    await swift('settings.showPane', { pane: 'appearance' })
    await vi.waitFor(() => expect(screens()).toEqual(['Settings', 'Appearance']))
    const pane = shownStack().querySelector('section[aria-label="Appearance"]')!
    expect(pane.querySelector('.phone-topbar')).toBeNull()
    expect(pane.querySelector('.phone-scroll')?.hasAttribute('data-native-bar')).toBe(true)
  })

  it('keeps the pane it shows when Swift asks again, so a tab switch loses nothing in it', async () => {
    await start()
    await swift('tabs.show', { tab: 'settings' })
    await swift('settings.showPane', { pane: 'appearance' })
    await vi.waitFor(() => expect(screens()).toEqual(['Settings', 'Appearance']))
    const pane = shownStack().querySelector('section[aria-label="Appearance"]')
    await swift('tabs.show', { tab: 'library' })
    await swift('settings.showPane', { pane: 'appearance' })
    expect(screens()).toEqual(['Settings', 'Appearance'])
    expect(shownStack().querySelector('section[aria-label="Appearance"]')).toBe(pane)
  })

  it('lets the pane go when Swift pops back to the Settings root', async () => {
    await start()
    await swift('tabs.show', { tab: 'settings' })
    await swift('settings.showPane', { pane: 'appearance' })
    await vi.waitFor(() => expect(screens()).toEqual(['Settings', 'Appearance']))
    await swift('tabs.popToRoot', { tab: 'settings' })
    await vi.waitFor(() => expect(screens()).toEqual(['Settings']))
  })

  it('lists the notebooks in Library order for Default Notebook', async () => {
    const work = await shell.books.create('Work', null)
    await shell.books.create('Plans', work)
    await shell.books.create('Home', null)
    await start()
    const result = (await swift('settings.notebooks')) as {
      notebooks: { id: string; name: string; depth: number }[]
    }
    expect(result.notebooks.map(({ name, depth }) => [name, depth])).toEqual([
      ['Work', 0],
      ['Plans', 1],
      ['Home', 0],
    ])
  })

  it('opens License in Swift for the Pro sheet instead of in the page', async () => {
    const ended = { state: 'ended', endsAt: Date.now() - 1, code: null, source: 'keychain' }
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === 'licence_get' ? { ...PRO, gated: true, state: 'none', trial: ended } : undefined,
    )
    await readCurrentLicence()
    await start()
    await act(async () => requireEditing({ op: 'newNote', id: null }, () => {}))
    const enterKey = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (b) => b.textContent === 'Enter License Key',
      )
    await vi.waitFor(() => expect(enterKey()).toBeDefined())
    await act(async () => enterKey()!.click())
    expect(bridge.notices.filter((notice) => notice.notice === 'settings.open')).toStrictEqual([
      { notice: 'settings.open', pane: 'licence', focusKey: true },
    ])
    expect(screens()).toEqual(['Library'])
  })
})

describe('the Settings operations', () => {
  it('take only the panes the page still draws', async () => {
    const shown: string[] = []
    const handlers = settingsHandlers({
      showPane: (pane) => shown.push(pane),
      notebooks: () => [],
    })
    await expect(handlers['settings.showPane']!({ pane: 'appearance' })).resolves.toStrictEqual({})
    for (const args of [
      { pane: 'sync' },
      { pane: 'licence' },
      { pane: 'appearance', anchor: 'pairing' },
    ])
      await expect(handlers['settings.showPane']!(args)).rejects.toThrow('E_SCREENS_ARGS_INVALID')
    await expect(handlers['settings.notebooks']!({})).resolves.toStrictEqual({ notebooks: [] })
    expect(shown).toStrictEqual(['appearance'])
  })
})
