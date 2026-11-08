// @vitest-environment happy-dom
import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../../core/storage'
import type { EditorHandle } from '../editor/handle'
import { invoke } from '../ipc'
import { readCurrentLicence, useLicence } from '../licence'
import { closePurchase } from '../purchaseSheet'
import { PhoneGate } from './PhoneProSheet'
import { PhoneNote } from './PhoneNote'
import { closeGate } from './requireEditing'
import type { PhoneStore } from './usePhoneData'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('DEVOT_UI_TEST', true)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const shownEditors: { readOnly: boolean | undefined; noKeyboard: boolean | undefined }[] = []
// Like NoteEditor, the stand-in takes its lock from props in an effect, after the render.
let editorLocked = false
let loadedText = ''
const toggled: { at: number; locked: boolean }[] = []
const handle = {
  toggleTask: vi.fn<(at: number) => void>((at) => {
    toggled.push({ at, locked: editorLocked })
  }),
  suggest: vi.fn<() => void>(),
}

vi.mock('../NoteEditor', () => ({
  NoteEditor: (props: {
    readOnly?: boolean
    noKeyboard?: boolean
    onLoaded: (text: string) => void
    handleRef: { current: EditorHandle | null }
  }) => {
    shownEditors.push({ readOnly: props.readOnly, noKeyboard: props.noKeyboard })
    const loaded = useRef(false)
    useEffect(() => {
      editorLocked = props.readOnly === true
    }, [props.readOnly])
    useEffect(() => {
      if (loaded.current) return
      loaded.current = true
      props.handleRef.current = handle as unknown as EditorHandle
      props.onLoaded(loadedText)
    })
    return <div className="cm-editor" />
  },
}))

vi.mock('../preview/Preview', () => ({
  Preview: (props: { onToggleTask?: (at: number) => void }) => (
    <input
      type="checkbox"
      aria-label="Task"
      data-task-at="3"
      onClick={() => props.onToggleTask?.(3)}
    />
  ),
}))

const NOTE: NoteSummary = {
  id: 'n1',
  title: '',
  createdAt: 0,
  updatedAt: 0,
  bodyVersion: 0,
  bookId: null,
  status: 'none',
  pinned: false,
  tagIds: [],
}

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
let current: unknown
let writes: string[]
let refuse: string | null

const write =
  (name: string) =>
  async (..._args: unknown[]) => {
    if (refuse) throw new Error(refuse)
    writes.push(name)
    return 't1'
  }

const store = (): PhoneStore =>
  ({
    core: {
      setTitle: write('title'),
      setBook: write('notebook'),
      setStatus: write('status'),
      addTag: write('tag'),
      removeTag: write('untag'),
      history: async () => [],
      backlinks: async () => [],
      listBooks: async () => [],
      read: async () => ({ bookId: null }),
      search: async () => ({ found: [] }),
    },
    notes: [NOTE],
    templates: [],
    books: [],
    tags: [],
    savedSearches: [],
    trash: [],
    lastBackup: null,
    loadedAt: 0,
    refresh: async () => {},
    onTakenIn: () => () => {},
  }) as unknown as PhoneStore

function Screen(props: { store: PhoneStore }) {
  const licence = useLicence()
  return (
    <>
      <PhoneNote store={props.store} noteId="n1" onBack={() => {}} />
      <PhoneGate licence={licence} onOpenLicence={() => {}} />
    </>
  )
}

beforeEach(() => {
  loadedText = ''
  writes = []
  refuse = null
  shownEditors.length = 0
  handle.toggleTask.mockClear()
  toggled.length = 0
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? current : undefined,
  )
  host = document.createElement('div')
  host.className = 'phone-app'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    closeGate()
    closePurchase()
    root.unmount()
  })
  host.remove()
  document.body.innerHTML = ''
  vi.mocked(invoke).mockReset()
  vi.restoreAllMocks()
})

async function open(licence: unknown) {
  current = licence
  await readCurrentLicence()
  await act(async () => root.render(<Screen store={store()} />))
}

const unlock = async () => {
  current = RUNNING
  await act(async () => void (await readCurrentLicence()))
}
const mode = () => host.querySelector('.phone-note-body')?.getAttribute('data-mode')
const named = (name: string) => host.querySelector<HTMLElement>(`[aria-label="${name}"]`)
const dialogNames = () =>
  [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-label'))
const tap = async (el: HTMLElement | null) => {
  await act(async () => el?.click())
}
const proSheetShown = async () =>
  vi.waitFor(() => expect(dialogNames()).toEqual(['Your trial has ended']))
const notNow = async () => {
  const button = [...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => b.textContent === 'Not Now',
  )
  await tap(button as HTMLElement)
  await vi.waitFor(() => expect(dialogNames()).toEqual([]))
}

describe('a note while editing is locked', () => {
  it('opens in Preview, an empty one too, and stays there', async () => {
    await open(ENDED)
    expect(mode()).toBe('preview')
    await tap(named('Edit'))
    await proSheetShown()
    expect(mode()).toBe('preview')
    await notNow()
    expect(mode()).toBe('preview')
  })

  it('keeps the editor read-only with no caret', async () => {
    await open(ENDED)
    expect(shownEditors.at(-1)).toEqual({ readOnly: true, noKeyboard: true })
  })

  it('opens an empty note in Edit while editing is allowed', async () => {
    await open(RUNNING)
    expect(mode()).toBe('edit')
    expect(shownEditors.at(-1)?.readOnly).toBe(false)
  })

  it('shows the sheet for a task checkbox and changes nothing', async () => {
    await open(ENDED)
    await tap(named('Task'))
    await proSheetShown()
    expect(handle.toggleTask).not.toHaveBeenCalled()
  })

  it('toggles the task once the unlock has reached the editor', async () => {
    await open(ENDED)
    await tap(named('Task'))
    await proSheetShown()
    await unlock()
    await vi.waitFor(() => expect(toggled).toEqual([{ at: 3, locked: false }]))
    expect(dialogNames()).toEqual([])
  })

  it('focuses the title once the unlock has made it editable', async () => {
    await open(ENDED)
    const title = named('Title') as HTMLTextAreaElement
    const focused: boolean[] = []
    const focus = title.focus.bind(title)
    vi.spyOn(title, 'focus').mockImplementation((options) => {
      focused.push(title.readOnly)
      focus(options)
    })
    await tap(title)
    await proSheetShown()
    focused.length = 0
    await unlock()
    await vi.waitFor(() => expect(focused).toEqual([false]))
    expect(document.activeElement).toBe(title)
  })

  it('toggles a task while editing is allowed', async () => {
    await open(RUNNING)
    await tap(named('Preview'))
    await tap(named('Task'))
    expect(handle.toggleTask).toHaveBeenCalledWith(3)
  })

  it('shows the sheet for the title and writes nothing', async () => {
    await open(ENDED)
    const title = named('Title') as HTMLTextAreaElement
    expect(title.readOnly).toBe(true)
    await tap(title)
    await proSheetShown()
    expect(writes).toEqual([])
  })

  it('opens no picker for the notebook, status or tag chips', async () => {
    await open(ENDED)
    const chips = [...host.querySelectorAll<HTMLElement>('.phone-chip-target')]
    expect(chips).toHaveLength(3)
    for (const chip of chips) {
      await tap(chip)
      await proSheetShown()
      await notNow()
    }
    expect(writes).toEqual([])
  })

  it('opens the pickers while editing is allowed', async () => {
    await open(RUNNING)
    await tap(host.querySelector<HTMLElement>('.phone-chip-target'))
    await vi.waitFor(() => expect(dialogNames()).toEqual(['Move to…']))
  })

  it('shows the sheet when a title saved on a stale state is refused', async () => {
    await open(RUNNING)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    refuse = 'E_LICENCE_REQUIRED'
    current = ENDED
    const title = named('Title') as HTMLTextAreaElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      set?.call(title, 'Plans')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await proSheetShown()
    expect(writes).toEqual([])
    expect(warn).toHaveBeenCalledWith('W_PHONE_WRITE_LOCKED op=title code=E_LICENCE_REQUIRED')
  })
})
