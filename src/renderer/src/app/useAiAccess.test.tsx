// @vitest-environment happy-dom
import { act, type Dispatch, type ReactElement, type SetStateAction } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderHook, settle, unmountAll } from '../../../../tests/support/render-hook'
import { CHOOSE_AI_ACCESS, type AiAccessChange } from '../aiAccess'
import type { Core } from '../core-client'
import { LICENCE_REQUIRED } from '../licence'
import { useAiAccess } from './useAiAccess'

afterEach(() => {
  unmountAll()
  localStorage.clear()
})

function setUp(startEditing: boolean) {
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
  return {
    hook,
    writes,
    setChangeNotice,
    lock: () => hook.rerender(props(false)),
  }
}

/** What Settings > Integrations' Choose… leaves for the main window before focusing it. */
const askFromSettings = () =>
  act(() => {
    localStorage.setItem(CHOOSE_AI_ACCESS, '1')
    window.dispatchEvent(new Event('focus'))
  })

const apply = (dialog: ReactElement | null, changes: AiAccessChange[]) =>
  act(() =>
    (dialog as ReactElement<{ onApply: (c: AiAccessChange[]) => void }>).props.onApply(changes),
  )

it('says the change is locked, and opens no picker, when Settings asks while notes are read-only', () => {
  const { hook, setChangeNotice } = setUp(false)
  askFromSettings()
  expect(hook.current.dialog).toBeNull()
  expect(setChangeNotice).toHaveBeenCalledWith(LICENCE_REQUIRED)
  expect(localStorage.getItem(CHOOSE_AI_ACCESS)).toBeNull()
})

it('writes nothing and says why when the picker is applied after editing locked', async () => {
  const { hook, writes, setChangeNotice, lock } = setUp(true)
  askFromSettings()
  expect(hook.current.dialog).not.toBeNull()
  lock()
  apply(hook.current.dialog, [{ id: 'b1', on: true }])
  await settle()
  expect(hook.current.dialog).toBeNull()
  expect(writes).toEqual([])
  expect(setChangeNotice).toHaveBeenCalledWith(LICENCE_REQUIRED)
})

it('writes the change while notes may be changed', async () => {
  const { hook, writes, setChangeNotice } = setUp(true)
  askFromSettings()
  apply(hook.current.dialog, [{ id: 'b1', on: true }])
  await settle()
  expect(writes).toEqual([{ id: 'b1', on: true }])
  expect(setChangeNotice).not.toHaveBeenCalledWith(LICENCE_REQUIRED)
})
