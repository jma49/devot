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
  [...shownStack().querySelectorAll(':scope > .phone-layer:not([data-away])')].map((layer) =>
    layer.querySelector('section')?.getAttribute('aria-label'),
  )
const webTabBar = () => host.querySelector('nav[aria-label="Tabs"]')
const lastNotice = () => bridge.notices.at(-1)
const libraryRow = (name: string) =>
  [...shownStack().querySelectorAll<HTMLButtonElement>('.phone-grouped-open')].find(
    (row) => row.querySelector('.phone-grouped-label')?.textContent === name,
  ) ?? null
const button = (label: string) =>
  shownStack().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

async function start() {
  await act(async () => root.render(<PhoneApp />))
  await vi.waitFor(() => expect(screens()).toEqual(['Library']))
  await act(async () => {})
}

async function swift(op: 'tabs.show' | 'tabs.popToRoot', tab: string) {
  await act(async () => {
    await bridge.handlers[op]!({ tab })
  })
}

async function tap(target: HTMLElement | null) {
  await act(async () => target!.click())
}

describe('the page under the native tab bar', () => {
  it('draws no tab bar or New Note circle of its own', async () => {
    await start()
    expect(webTabBar()).toBeNull()
    expect(host.querySelector('.phone-compose')).toBeNull()
    expect(lastNotice()).toStrictEqual({
      notice: 'tabs.state',
      tab: 'library',
      barHidden: false,
      attention: false,
    })
  })

  it('keeps its own tab bar and circle when the native screens are not installed', async () => {
    bridge.installed = false
    await start()
    expect(webTabBar()).not.toBeNull()
    expect(host.querySelector('.phone-compose')).not.toBeNull()
    expect(bridge.notices).toStrictEqual([])
  })

  it('shows the tab Swift asks for, keeping every stack mounted', async () => {
    await start()
    const library = shownStack().querySelector('section')!
    await swift('tabs.show', 'notes')
    expect(screens()).toEqual(['All Notes'])
    expect(library.isConnected).toBe(true)
    await swift('tabs.show', 'library')
    expect(shownStack().querySelector('section')).toBe(library)
    expect(lastNotice()).toMatchObject({ tab: 'library' })
  })

  it('tells Swift when the page changes tab itself', async () => {
    await start()
    await tap(libraryRow('All Notes'))
    expect(screens()).toEqual(['All Notes'])
    expect(lastNotice()).toMatchObject({ tab: 'notes', barHidden: false })
  })

  it('never pops a stack when Swift shows the tab already shown', async () => {
    await shell.books.create('Work', null)
    await start()
    await vi.waitFor(() => expect(libraryRow('Work')).not.toBeNull())
    await tap(libraryRow('Work'))
    expect(screens()).toEqual(['Library', 'Work'])
    await swift('tabs.show', 'library')
    expect(screens()).toHaveLength(2)
    await swift('tabs.popToRoot', 'library')
    expect(screens()).toEqual(['Library'])
  })

  it('hides the bar while a note is pushed and shows it again once it is popped', async () => {
    await shell.notes.create('Plans', null)
    await start()
    await swift('tabs.show', 'notes')
    await vi.waitFor(() => expect(shownStack().querySelector('.phone-note-open')).not.toBeNull())
    await tap(shownStack().querySelector<HTMLButtonElement>('.phone-note-open'))
    expect(lastNotice()).toMatchObject({ tab: 'notes', barHidden: true })
    await tap(button('Back'))
    expect(lastNotice()).toMatchObject({ tab: 'notes', barHidden: false })
  })

  it('hides the bar while search covers the page', async () => {
    await start()
    await tap(button('Search'))
    expect(lastNotice()).toMatchObject({ barHidden: true })
  })

  it('offers New Note in the list capsule, where the circle offered it', async () => {
    await start()
    expect(button('New Note')).not.toBeNull()
    await swift('tabs.show', 'settings')
    expect(button('New Note')).toBeNull()
    await swift('tabs.show', 'notes')
    expect(button('New Note')).not.toBeNull()
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

  it('hide the bar over a note or a cover, and keep it over a pushed list or pane', () => {
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
    const settings = navigate(first, { type: 'selectTab', tab: 'settings' })
    const pane = navigate(settings, { type: 'push', screen: 'pane', pane: 'sync' })
    expect(tabsState(pane, false, false)).toMatchObject({ tab: 'settings', barHidden: false })
  })
})
