// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '../../ipc'
import { readCurrentLicence } from '../../licence'
import { closePurchase } from '../../purchaseSheet'
import { initialNavigation, navigate } from '../navigation'
import { PhoneApp } from '../PhoneApp'
import { closeGate } from '../requireEditing'
import { setTestCore, shownEditors, testCore } from '../testShell'
import type { ScreensNotice } from './message'
import type { ScreensHandlers } from './ops'
import { tabHandlers, tabsState } from './tabs'

vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: true }))
const bridge = vi.hoisted(() => ({
  installed: true,
  handlers: {} as ScreensHandlers,
  notices: [] as ScreensNotice[],
}))
vi.mock('./bridge', () => ({
  startScreensBridge: (handlers: ScreensHandlers) => {
    bridge.handlers = handlers
    return {
      installed: Promise.resolve(bridge.installed),
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
  bridge.installed = true
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
  [...shownStack().querySelectorAll(':scope > .phone-layer:not([data-away]) > section')].map(
    (section) => section.getAttribute('aria-label'),
  )
const lastNotice = () => bridge.notices.at(-1)

async function start() {
  await act(async () => root.render(<PhoneApp />))
  await vi.waitFor(() => expect(bridge.handlers['tabs.show']).toBeDefined())
  await act(async () => {})
}

async function swift(op: 'tabs.show', args: object) {
  await act(async () => {
    await bridge.handlers[op]!({ ...args })
  })
}

describe('the page under the native tab bar', () => {
  it('draws no tab bar, New Note, list or search of its own', async () => {
    await shell.notes.create('Plans', null)
    await start()
    await vi.waitFor(() =>
      expect(lastNotice()).toStrictEqual({
        notice: 'tabs.state',
        tab: 'library',
        barHidden: false,
        attention: false,
      }),
    )
    for (const tab of ['library', 'notes']) {
      await swift('tabs.show', { tab })
      expect(shownStack().querySelector('section')).toBeNull()
    }
    expect(host.querySelector('nav[aria-label="Tabs"]')).toBeNull()
    expect(
      host.querySelector('button[aria-label="New Note"], button[aria-label="Search"]'),
    ).toBeNull()
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('without the native screens opens on Activity and tells Swift nothing', async () => {
    bridge.installed = false
    await start()
    await vi.waitFor(() => expect(screens()).toEqual(['Activity']))
    expect(host.querySelector('nav[aria-label="Tabs"]')).toBeNull()
    expect(bridge.notices).toStrictEqual([])
  })

  it('shows the tab Swift asks for, keeping every stack mounted, and leaves Activity to Swift', async () => {
    await start()
    await swift('tabs.show', { tab: 'activity' })
    const activity = shownStack()
    expect(activity.querySelector('section')).toBeNull()
    await swift('tabs.show', { tab: 'settings' })
    expect(shownStack()).not.toBe(activity)
    expect(activity.isConnected).toBe(true)
    await swift('tabs.show', { tab: 'activity' })
    expect(shownStack()).toBe(activity)
    expect(lastNotice()).toMatchObject({ tab: 'activity' })
  })

  it('keeps the shown stack when Swift shows the tab already shown', async () => {
    await start()
    await swift('tabs.show', { tab: 'activity' })
    const activity = shownStack()
    const notices = bridge.notices.length
    await swift('tabs.show', { tab: 'activity' })
    expect(shownStack()).toBe(activity)
    expect(bridge.notices).toHaveLength(notices)
  })
})

describe('the tab operations', () => {
  it('run a known tab and refuse anything else', async () => {
    const shown: string[] = []
    const handlers = tabHandlers({
      show: (tab) => shown.push(`show ${tab}`),
      popToRoot: (tab) => shown.push(`root ${tab}`),
    })
    await expect(handlers['tabs.show']!({ tab: 'activity' })).resolves.toStrictEqual({})
    await expect(handlers['tabs.popToRoot']!({ tab: 'notes' })).resolves.toStrictEqual({})
    await expect(handlers['tabs.show']!({ tab: 'search' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
    expect(shown).toStrictEqual(['show activity', 'root notes'])
  })

  it('hide the bar over a note or a cover, and keep it over a pushed list', () => {
    const first = initialNavigation()
    expect(tabsState(first, false, true)).toStrictEqual({
      tab: 'library',
      barHidden: false,
      attention: true,
    })
    const list = navigate(first, { type: 'push', screen: 'list', view: { kind: 'all' } })
    expect(tabsState(list, false, false).barHidden).toBe(false)
    expect(tabsState(list, true, false).barHidden).toBe(true)
    const note = navigate(list, { type: 'push', screen: 'note', noteId: 'n1' })
    expect(tabsState(note, false, false).barHidden).toBe(true)
  })
})
