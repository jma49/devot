// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEMPLATES_BOOK_ID } from '../../../core/templatesBook'
import { invoke } from '../ipc'
import { readCurrentLicence } from '../licence'
import { closePurchase } from '../purchaseSheet'
import { initialNavigation, navigate, type PhoneRoute } from './navigation'
import { listUnderNewNote, newNoteOffered, newNotesLeft } from './newNote'
import { PhoneApp } from './PhoneApp'
import { closeGate } from './requireEditing'
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
const ENDED = { ...RUNNING, trial: { ...RUNNING.trial, state: 'ended', endsAt: Date.now() - 1 } }

let host: HTMLDivElement
let root: Root
let licence: unknown
let shell: ReturnType<typeof testCore>

beforeEach(async () => {
  localStorage.clear()
  shownEditors.length = 0
  licence = RUNNING
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? licence : undefined,
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
const compose = () => host.querySelector<HTMLButtonElement>('.phone-compose')!
const tab = (name: string) =>
  host.querySelector<HTMLButtonElement>(`nav[aria-label="Tabs"] button[aria-label="${name}"]`)!
const currentTab = () =>
  host
    .querySelector('nav[aria-label="Tabs"] button[aria-current="page"]')
    ?.getAttribute('aria-label')
const libraryRow = (name: string) =>
  [...shownStack().querySelectorAll<HTMLButtonElement>('.phone-grouped-open')].find(
    (row) => row.querySelector('.phone-grouped-label')?.textContent === name,
  )!

async function start() {
  await act(async () => root.render(<PhoneApp />))
  await vi.waitFor(() => expect(screens()).toEqual(['Library']))
}

async function tap(button: HTMLElement) {
  await act(async () => button.click())
}

async function newNote() {
  const before = (await shell.core.listWithTemplates()) as {
    notes: unknown[]
    templates: unknown[]
  }
  await tap(compose())
  await vi.waitFor(async () => {
    const after = (await shell.core.listWithTemplates()) as typeof before
    expect(after.notes.length + after.templates.length).toBe(
      before.notes.length + before.templates.length + 1,
    )
    expect(screens().at(-1)).toBe('Untitled')
  })
}

describe('where New Note is offered', () => {
  const route = (screen: PhoneRoute['screen']): PhoneRoute => ({ id: 1, screen })

  it('makes a note from a list or the Library root, a template from Templates, and nothing elsewhere', () => {
    expect(
      newNoteOffered('notes', route('root'), { view: { kind: 'all' }, status: 'active' }),
    ).toBe('note')
    expect(newNoteOffered('library', route('root'), null)).toBe('note')
    expect(
      newNoteOffered('library', route('list'), { view: { kind: 'templates' }, status: 'all' }),
    ).toBe('template')
    expect(
      newNoteOffered('library', route('list'), { view: { kind: 'trash' }, status: 'all' }),
    ).toBeNull()
    expect(newNoteOffered('activity', route('root'), null)).toBeNull()
    expect(newNoteOffered('settings', route('root'), null)).toBeNull()
    expect(newNoteOffered('library', route('note'), null)).toBeNull()
  })

  it('slides a list in under the editor only where the one shown would not list the note', () => {
    const all = { view: { kind: 'all' as const }, status: 'all' as const }
    expect(listUnderNewNote(all, 'note', null)).toBeNull()
    expect(listUnderNewNote({ ...all, status: 'active' }, 'note', null)).toEqual({ kind: 'all' })
    expect(
      listUnderNewNote({ view: { kind: 'book', id: 'b' }, status: 'all' }, 'note', 'b'),
    ).toBeNull()
    expect(
      listUnderNewNote({ view: { kind: 'tag', id: 't' }, status: 'all' }, 'note', 'b'),
    ).toEqual({
      kind: 'book',
      id: 'b',
    })
    expect(listUnderNewNote(null, 'note', null)).toEqual({ kind: 'all' })
    expect(
      listUnderNewNote({ view: { kind: 'templates' }, status: 'all' }, 'template', null),
    ).toBeNull()
  })

  it('counts a new note as left only once no tab shows it', () => {
    const made = navigate(initialNavigation(), {
      type: 'newNoteShown',
      listView: null,
      noteId: 'n1',
    })
    const elsewhere = navigate(made, { type: 'selectTab', tab: 'settings' })
    expect(newNotesLeft(made, elsewhere)).toEqual([])
    const back = navigate(made, { type: 'pop' })
    expect(newNotesLeft(made, back)).toEqual(['n1'])
  })
})

describe('New Note in the shell', () => {
  it('makes an empty note with status none and pushes its editor, the keyboard taken in the tap', async () => {
    await start()
    await tap(libraryRow('All Notes'))
    await vi.waitFor(() => expect(screens()).toEqual(['All Notes']))
    await newNote()
    expect(currentTab()).toBe('Notes')
    expect(screens()).toEqual(['All Notes', 'Untitled'])
    const [note] = (await shell.core.listWithTemplates()).notes
    expect(note).toMatchObject({ title: '', bookId: null, status: 'none', pinned: false })
    expect(document.activeElement?.hasAttribute('data-keyboard-proxy')).toBe(true)
  })

  it('gives the body the keyboard and what was typed once the push has landed', async () => {
    await start()
    await newNote()
    const editor = shownEditors.find((e) => e.noteId === shownEditors.at(-1)?.noteId)!
    for (const key of ['H', 'i'])
      window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }))
    expect(editor.focused).toBe(0)
    const layer = shownStack().querySelector(':scope > .phone-layer:last-of-type')!
    await act(async () => layer.dispatchEvent(new Event('transitionend')))
    expect(editor.focused).toBe(1)
    expect(editor.typed.map((k) => k.key)).toEqual(['H', 'i'])
  })

  const proxy = () => host.querySelector<HTMLTextAreaElement>('[data-keyboard-proxy]')!
  const land = async () => {
    const layer = shownStack().querySelector(':scope > .phone-layer:last-of-type')!
    await act(async () => layer.dispatchEvent(new Event('transitionend')))
  }
  const heldCreate = () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const create = shell.notes.create.bind(shell.notes)
    const spy = vi.spyOn(shell.notes, 'create').mockImplementation(async (...args) => {
      await held
      return create(...args)
    })
    return { spy, release: () => act(async () => release()) }
  }

  it('makes one note for a second tap while the first is still being made', async () => {
    await start()
    const { spy, release } = heldCreate()
    await tap(compose())
    await tap(compose())
    await release()
    await vi.waitFor(() => expect(screens()).toEqual(['Library', 'All Notes', 'Untitled']))
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await shell.core.listWithTemplates()).notes).toHaveLength(1)
  })

  it('pushes nothing and keeps no note when the tab changed before the note was made', async () => {
    await start()
    const { spy, release } = heldCreate()
    await tap(compose())
    await tap(tab('Activity'))
    await release()
    await vi.waitFor(async () => {
      expect(spy).toHaveBeenCalledTimes(1)
      expect((await shell.core.listWithTemplates()).notes).toEqual([])
    })
    expect(currentTab()).toBe('Activity')
    expect(screens()).toEqual(['Activity'])
    await tap(tab('Library'))
    expect(screens()).toEqual(['Library'])
  })

  it('types a composition the hidden field holds only once it is committed', async () => {
    await start()
    await newNote()
    const editor = shownEditors.at(-1)!
    const field = proxy()
    act(() => {
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      field.value = 'nihao'
    })
    await land()
    expect(editor.focused).toBe(1)
    expect(editor.typed).toEqual([])
    act(() => {
      field.value = '\u4f60\u597d'
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    await vi.waitFor(() => expect(editor.typed.map((k) => k.key).join('')).toBe('\u4f60\u597d'))
    expect(field.value).toBe('')
  })

  it('leaves nothing in the hidden field for the next note when a note is not made', async () => {
    await start()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let fail = () => {}
    vi.spyOn(shell.notes, 'create').mockImplementationOnce(
      () => new Promise((_, reject) => (fail = () => reject(new Error('E_STORAGE_FULL')))),
    )
    await tap(compose())
    proxy().value = 'stale'
    await act(async () => fail())
    expect(proxy().value).toBe('')
    await newNote()
    await land()
    expect(shownEditors.at(-1)!.typed).toEqual([])
  })

  it('from the Library root and a status list, slides All Notes in under it on the same tab', async () => {
    await start()
    await newNote()
    expect(currentTab()).toBe('Library')
    expect(screens()).toEqual(['Library', 'All Notes', 'Untitled'])
    await tap(tab('Library'))
    await tap(libraryRow('Active'))
    await vi.waitFor(() => expect(currentTab()).toBe('Notes'))
    await newNote()
    expect(currentTab()).toBe('Notes')
    expect(screens()).toEqual(['All Notes', 'All Notes', 'Untitled'])
  })

  it("from a tag list slides the note's notebook in under it, and a notebook list keeps it", async () => {
    const work = await shell.books.create('Work', null)
    const tagged = await shell.notes.create('Tagged', null)
    await shell.tags.addToNote(tagged, 'idea')
    await shell.notes.flush()
    await start()
    await tap(libraryRow('idea'))
    await vi.waitFor(() => expect(screens()).toEqual(['Library', 'idea']))
    await newNote()
    expect(screens()).toEqual(['Library', 'idea', 'All Notes', 'Untitled'])
    await tap(tab('Library'))
    await vi.waitFor(async () =>
      expect((await shell.core.listWithTemplates()).notes.map((n) => n.title)).toEqual(['Tagged']),
    )
    await tap(libraryRow('Work'))
    await vi.waitFor(() => expect(screens()).toEqual(['Library', 'Work']))
    await newNote()
    expect(screens()).toEqual(['Library', 'Work', 'Untitled'])
    const made = (await shell.core.listWithTemplates()).notes.filter((n) => n.title === '')
    expect(made.map((n) => n.bookId)).toEqual([work])
  })

  it('makes a template from Templates, and offers nothing in the Trash or Search', async () => {
    await start()
    await tap(libraryRow('Templates'))
    await vi.waitFor(() => expect(screens()).toEqual(['Library', 'Templates']))
    expect(compose().getAttribute('aria-label')).toBe('New Template')
    await newNote()
    const { templates } = await shell.core.listWithTemplates()
    expect(templates.map((n) => n.bookId)).toEqual([TEMPLATES_BOOK_ID])
    expect(screens()).toEqual(['Library', 'Templates', 'Untitled'])
    await tap(tab('Library'))
    await tap(libraryRow('Trash'))
    await vi.waitFor(() => expect(compose().hasAttribute('data-hidden')).toBe(true))
    await tap(tab('Library'))
    await vi.waitFor(() => expect(compose().hasAttribute('data-hidden')).toBe(false))
    await tap(
      host.querySelector<HTMLButtonElement>('section[aria-label="Library"] [aria-label="Search"]')!,
    )
    await vi.waitFor(() => expect(compose().hasAttribute('data-hidden')).toBe(true))
  })
})

describe('New Note while editing is locked', () => {
  const dialogs = () =>
    [...document.querySelectorAll('[role="dialog"]:not([inert])')].map((d) =>
      d.getAttribute('aria-label'),
    )

  it("opens the lock's sheet from the tap and makes nothing", async () => {
    licence = ENDED
    await readCurrentLicence()
    await start()
    await tap(compose())
    await vi.waitFor(() => expect(dialogs()).toEqual(['Your trial has ended']))
    expect((await shell.core.listWithTemplates()).notes).toEqual([])
    expect(screens()).toEqual(['Library'])
    expect(document.activeElement?.hasAttribute('data-keyboard-proxy')).toBe(false)
  })

  it('opens the same sheet in an App Store build, with no purchase outside the store', async () => {
    licence = {
      ...ENDED,
      trial: { ...ENDED.trial, source: 'purchase' },
      activation: { state: 'active', used: 1, limit: 3, expiresAt: null },
      appStore: { pro: false, code: null, takesKeys: false },
    }
    await readCurrentLicence()
    await start()
    await tap(compose())
    await vi.waitFor(() => expect(dialogs()).toEqual(['Your trial has ended']))
    const sheet = document.querySelector('[role="dialog"]:not([inert])')!.outerHTML
    expect(sheet).not.toMatch(/\/buy\b|devot\.online/)
    expect((await shell.core.listWithTemplates()).notes).toEqual([])
    expect(screens()).toEqual(['Library'])
  })

  it('pushes nothing when Rust refuses the note on a stale licence, and makes nothing after an unlock', async () => {
    await start()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const create = vi
      .spyOn(shell.notes, 'create')
      .mockImplementation(async () => Promise.reject(new Error('E_LICENCE_REQUIRED')))
    licence = ENDED
    await tap(compose())
    await vi.waitFor(() => expect(dialogs()).toEqual(['Your trial has ended']))
    expect(screens()).toEqual(['Library'])
    expect(document.activeElement?.hasAttribute('data-keyboard-proxy')).toBe(false)
    expect(document.body.textContent).not.toMatch(/\b[EWI]_[A-Z0-9_]+/)
    licence = RUNNING
    await act(async () => void (await readCurrentLicence()))
    expect(create).toHaveBeenCalledTimes(1)
    expect(screens()).toEqual(['Library'])
  })
})
