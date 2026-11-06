// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { useSettingsChange } from './controls'

const store = vi.hoisted(() => ({ fails: undefined as string | undefined }))

vi.mock('../editorSettings', () => ({
  changeEditorSettings: vi.fn<() => Promise<void>>(async () => {
    if (store.fails) throw new Error(store.fails)
  }),
}))

afterEach(() => {
  unmountAll()
  store.fails = undefined
  vi.restoreAllMocks()
})

it('logs the code of a change that could not be stored, and clears it with the next that could', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const hook = renderHook(useSettingsChange, { props: undefined })
  store.fails = 'E_STORAGE_BUSY'
  await act(async () => hook.current[1]({ fontSize: 14 }))
  expect(hook.current[0]).toBe('E_STORAGE_BUSY')
  expect(warn).toHaveBeenCalledWith('W_EDITOR_SETTINGS_FAILED', 'E_STORAGE_BUSY')
  store.fails = undefined
  await act(async () => hook.current[1]({ fontSize: 14 }))
  expect(hook.current[0]).toBeUndefined()
})
