// @vitest-environment happy-dom
import { act, type Dispatch, type ReactElement, type SetStateAction } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderHook, settle, unmountAll } from '../../../../tests/support/render-hook'
import type { AiAccessChange } from '../aiAccess'
import type { Core } from '../core-client'
import { LICENCE_REQUIRED } from '../licence'
import { useAiAccess } from './useAiAccess'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

/** Rust's side: whether Settings asked, and the main window's listener for its event. */
const rust = vi.hoisted(() => ({ asked: false, closed: 0, heard: [] as (() => void)[] }))

vi.mock('../ipc', () => ({
  invoke: vi.fn<(cmd: string) => Promise<boolean>>(async (cmd) => {
    if (cmd === 'ai_access_picker_closed') {
      rust.closed += 1
      return false
    }
    if (cmd !== 'ai_access_picker_take') throw new Error('E_UNEXPECTED_COMMAND')
    const asked = rust.asked
    rust.asked = false
    return asked
  }),
}))

vi.mock('../windowEvents', async (actual) => ({
  ...(await actual<typeof import('../windowEvents')>()),
  listenHere: async (_event: string, handler: () => void) => {
    rust.heard.push(handler)
    return () => {
      rust.heard = rust.heard.filter((h) => h !== handler)
    }
  },
}))

afterEach(() => {
  unmountAll()
  rust.asked = false
  rust.closed = 0
  rust.heard = []
})

async function setUp(startEditing: boolean) {
  const writes: AiAccessChange[] = []
  const core = {
    flush: async () => {},
    setBookAiAccess: async (id: string, on: boolean) => {
      writes.push({ id, on })
    },
  } as unknown as Core
  const setChangeNotice = vi.fn<Dispatch<SetStateAction<string | undefined>>>()
  const props = (editing: boolean) => ({
    core,
    editing,
    refresh: async () => {},
    reloadStarted: () => {},
    reloadDone: () => {},
    setChangeNotice,
    tree: [],
    counts: new Map<string, number>(),
  })
  const hook = renderHook(useAiAccess, { props: props(startEditing) })
  await settle()
  return {
    hook,
    writes,
    setChangeNotice,
    lock: () => hook.rerender(props(false)),
  }
}

/** What Settings' Choose… asks Rust for: Rust holds the ask and tells the main window. */
async function askFromSettings() {
  rust.asked = true
  act(() => {
    for (const heard of rust.heard) heard()
  })
  await settle()
}

const apply = (dialog: ReactElement | null, changes: AiAccessChange[]) =>
  act(() =>
    (dialog as ReactElement<{ onApply: (c: AiAccessChange[]) => void }>).props.onApply(changes),
  )

it('says the change is locked, and opens no picker, when Settings asks while notes are read-only', async () => {
  const { hook, setChangeNotice } = await setUp(false)
  await askFromSettings()
  expect(hook.current.dialog).toBeNull()
  expect(setChangeNotice).toHaveBeenCalledWith(LICENCE_REQUIRED)
  expect(rust.asked).toBe(false)
  expect(rust.closed).toBe(1)
})

it('opens the picker once per ask', async () => {
  const { hook } = await setUp(true)
  await askFromSettings()
  expect(hook.current.dialog).not.toBeNull()
  act(() => (hook.current.dialog as ReactElement<{ onCancel: () => void }>).props.onCancel())
  expect(hook.current.dialog).toBeNull()
  await settle()
  expect(rust.closed).toBe(1)
  // Another main window took this ask: the event alone opens nothing.
  act(() => {
    for (const heard of rust.heard) heard()
  })
  await settle()
  expect(hook.current.dialog).toBeNull()
})

it('opens the picker in a main window that starts after Settings asked', async () => {
  rust.asked = true
  const { hook } = await setUp(true)
  expect(hook.current.dialog).not.toBeNull()
  expect(rust.heard).toHaveLength(1)
})

it('writes nothing and says why when the picker is applied after editing locked', async () => {
  const { hook, writes, setChangeNotice, lock } = await setUp(true)
  await askFromSettings()
  expect(hook.current.dialog).not.toBeNull()
  lock()
  apply(hook.current.dialog, [{ id: 'b1', on: true }])
  await settle()
  expect(hook.current.dialog).toBeNull()
  expect(writes).toEqual([])
  expect(setChangeNotice).toHaveBeenCalledWith(LICENCE_REQUIRED)
})

it('writes the change while notes may be changed', async () => {
  const { hook, writes, setChangeNotice } = await setUp(true)
  await askFromSettings()
  apply(hook.current.dialog, [{ id: 'b1', on: true }])
  await settle()
  expect(writes).toEqual([{ id: 'b1', on: true }])
  expect(setChangeNotice).not.toHaveBeenCalledWith(LICENCE_REQUIRED)
})
