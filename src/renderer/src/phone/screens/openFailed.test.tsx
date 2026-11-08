// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { BODY } from '../../../../core'
import { invoke } from '../../ipc'
import { readCurrentLicence } from '../../licence'
import { PhoneApp } from '../PhoneApp'
import { closeGate } from '../requireEditing'
import type { ScreensNotice } from './message'
import type { ScreensHandlers } from './ops'
import { setTestCore, testCore } from '../testShell'

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

beforeEach(async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? PRO : undefined,
  )
  await readCurrentLicence()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    closeGate()
    root.unmount()
  })
  setTestCore(null)
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function swift(op: keyof ScreensHandlers, args: Record<string, unknown> = {}) {
  await act(async () => {
    await bridge.handlers[op]!(args)
  })
}

const editorText = () =>
  [...document.querySelectorAll('.phone-editor-host .editor')]
    .map((el) => el.shadowRoot?.textContent ?? el.textContent ?? '')
    .join('')

describe('a note the iPhone editor cannot open', () => {
  it('never leaves the note shown before on screen, and says it could not be opened', async () => {
    localStorage.clear()
    const { notes } = testCore()
    const first = await notes.create('First', null)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, (await notes.open(first)).state)
    const before = Y.encodeStateVector(doc)
    doc.getText(BODY).insert(0, 'Shopping list')
    await notes.applyUpdate(first, Y.encodeStateAsUpdate(doc, before))
    const second = await notes.create('Second', null)
    await notes.flush()
    const stored = JSON.parse(localStorage.getItem('devot.test.notes')!) as {
      id: string
      ydoc: number[]
    }[]
    for (const note of stored) if (note.id === second) note.ydoc = [255, 0, 255, 0]
    localStorage.setItem('devot.test.notes', JSON.stringify(stored))
    // A core that reads the notes from storage, as the app does at launch.
    setTestCore(testCore().core)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await act(async () => root.render(<PhoneApp />))
    await vi.waitFor(() => expect(bridge.handlers['editor.show']).toBeDefined())
    await swift('tabs.show', { tab: 'notes' })
    await swift('editor.show', { noteId: first })
    await vi.waitFor(() => expect(editorText()).toContain('Shopping list'))
    await swift('editor.hide')
    await swift('editor.show', { noteId: second })

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('W_NOTE_OPEN_FAILED', second, expect.any(String)),
    )
    expect(editorText()).not.toContain('Shopping list')
    expect(document.querySelector('.phone-editor-host [role="status"]')?.textContent).toBe(
      'This note could not be opened.',
    )
  })
})
