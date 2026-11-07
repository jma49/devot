// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BODY } from '../../../core'
import { invoke } from '../ipc'
import { readCurrentLicence } from '../licence'
import { PhoneApp } from './PhoneApp'
import { setTestCore, shownEditors, testCore } from './testShell'

vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: true }))
vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.0.0' }))
vi.mock('./usePhoneData', async () => ({
  usePhoneData: (await import('./testShell')).useTestPhoneData,
}))
vi.mock('../NoteEditor', async () => ({ NoteEditor: (await import('./testShell')).TestEditor }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const RUNNING = {
  gated: true,
  state: 'none',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: { state: 'running', endsAt: Date.now() + 86_400_000, code: null, source: 'keychain' },
  activation: null,
  appStore: null,
}

let host: HTMLDivElement
let root: Root
let shell: ReturnType<typeof testCore>

beforeEach(async () => {
  localStorage.clear()
  shownEditors.length = 0
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? RUNNING : undefined,
  )
  await readCurrentLicence()
  shell = testCore()
  setTestCore(shell.core)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<PhoneApp />))
  await vi.waitFor(() => {
    if (screens().join() !== 'Library') throw new Error('the Library is not shown yet')
  })
  await tap(tab('Notes'))
})

afterEach(() => {
  act(() => root.unmount())
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
const tab = (name: string) =>
  host.querySelector<HTMLButtonElement>(`nav[aria-label="Tabs"] button[aria-label="${name}"]`)!
const noteScreen = () => shownStack().querySelector('section.phone-screen:has(.cm-editor)')!
const rows = () => [...host.querySelectorAll('section[aria-label="All Notes"] .phone-note-row')]
const stored = async () => (await shell.core.listWithTemplates()).notes

async function tap(button: HTMLElement) {
  await act(async () => button.click())
}

async function newNote(): Promise<string> {
  await tap(host.querySelector<HTMLButtonElement>('.phone-compose')!)
  await vi.waitFor(async () => {
    expect(await stored()).toHaveLength(1)
    expect(screens()).toEqual(['All Notes', 'Untitled'])
  })
  return (await stored())[0]!.id
}

async function back() {
  await tap(noteScreen().querySelector<HTMLButtonElement>('button[aria-label="Back"]')!)
}

describe('a new note left untouched', () => {
  it('is deleted for good when Back leaves it, with no row and nothing in the Trash', async () => {
    await newNote()
    await back()
    await vi.waitFor(async () => expect(await stored()).toEqual([]))
    expect(screens()).toEqual(['All Notes'])
    expect(rows()).toEqual([])
    expect(await shell.core.listTrash()).toEqual([])
  })

  it('is kept when a tab switch leaves it on screen, and goes when that tab pops to its root', async () => {
    const id = await newNote()
    await tap(tab('Settings'))
    await tap(tab('Notes'))
    expect(screens()).toEqual(['All Notes', 'Untitled'])
    expect((await stored()).map((n) => n.id)).toEqual([id])
    await tap(tab('Notes'))
    await vi.waitFor(async () => expect(await stored()).toEqual([]))
  })
})

describe('a new note with anything in it', () => {
  it('is kept once a character is typed, even when it is deleted again, and its row is marked', async () => {
    const id = await newNote()
    const editor = shownEditors.find((e) => e.noteId === id)!
    act(() => editor.text('a'))
    act(() => editor.text(''))
    await back()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect((await stored()).map((n) => n.id)).toEqual([id])
    expect(rows()[0]?.hasAttribute('data-arrived')).toBe(true)
  })

  it('is kept once a title is typed', async () => {
    const id = await newNote()
    const title = noteScreen().querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(title, 'P')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await back()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect((await stored()).map((n) => n.id)).toEqual([id])
  })

  it('is kept once a chip is changed', async () => {
    const id = await newNote()
    const chips = noteScreen().querySelectorAll<HTMLButtonElement>('.phone-chip-target')
    await tap(chips[1]!)
    const active = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"]:not([inert]) button'),
    ].find((b) => b.textContent?.includes('Active'))!
    await tap(active)
    await back()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect((await stored()).map((n) => [n.id, n.status])).toEqual([[id, 'active']])
  })

  it('is kept, and the refusal logged by its code, when storage finds a body sync wrote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = await newNote()
    const opened = await shell.notes.open(id)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, opened.state)
    const before = Y.encodeStateVector(doc)
    doc.getText(BODY).insert(0, 'From the Mac')
    await shell.notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
    await back()
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('W_PHONE_DISCARD_REFUSED code=E_NOTE_NOT_TRASHED'),
    )
    expect((await stored()).map((n) => n.id)).toEqual([id])
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
  })
})
