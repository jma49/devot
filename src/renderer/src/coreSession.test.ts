// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Core } from './core-client'
import { useCoreSession, useQuitAndClose } from './coreSession'
import { EXIT_CANCELLED_EVENT } from './exitCancelled'
import { CLOSE_EVENT } from './saveGuards'
import { createQuitGuard } from './saving'
import { renderHook, settle, unmountAll } from '../../../tests/support/render-hook'
import { mockTauri } from '../../../tests/support/tauri-events'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

const QUIT_EVENTS = [
  'devot://flush-before-exit',
  'devot://background-idle-check',
  EXIT_CANCELLED_EVENT,
]

let tauri: ReturnType<typeof mockTauri>
afterEach(() => {
  unmountAll()
  tauri.clear()
})

function fakeCore(saved: boolean) {
  return {
    stopImport: vi.fn<() => Promise<void>>(async () => {}),
    flush: vi.fn<() => Promise<void>>(() =>
      saved ? Promise.resolve() : Promise.reject(new Error('E_SAVE')),
    ),
    mirrorStop: vi.fn<() => Promise<void>>(async () => {}),
    syncFlush: vi.fn<() => Promise<void>>(async () => {}),
  }
}

function setup({ primary = true, saved = true } = {}) {
  const core = fakeCore(saved)
  const props = {
    core: core as unknown as Core,
    coreRef: { current: core as unknown as Core },
    primary,
    quitGuard: createQuitGuard(),
    closeGuard: createQuitGuard(),
    saveNow: vi.fn<() => void>(),
    markShownSeen: vi.fn<(options?: { reload?: boolean }) => Promise<void>>(async () => {}),
    setSaveNoticeDismissed: vi.fn<(dismissed: boolean) => void>(),
    setQuitHeld: vi.fn<(held: boolean) => void>(),
    setCloseHeld: vi.fn<(held: boolean) => void>(),
  }
  return { core, props }
}

describe('useCoreSession', () => {
  it('starts again on a retry, without the failure', () => {
    tauri = mockTauri()
    const hook = renderHook(useCoreSession, { props: undefined })
    act(() => hook.current.setStartFailure('E_CORE_START'))
    act(() => hook.current.retryStart())
    expect(hook.current.startFailure).toBeUndefined()
    expect(hook.current.startAttempt).toBe(1)
  })
})

describe('useQuitAndClose', () => {
  it('stops the quit listeners that register after the window unmounted', async () => {
    tauri = mockTauri()
    tauri.hold()
    const { props } = setup()
    const hook = renderHook(useQuitAndClose, { props })
    await settle()
    hook.unmount()
    tauri.release()
    await settle()
    for (const event of QUIT_EVENTS) expect(tauri.listening(event)).toBe(0)
  })

  it('keeps one listener for each quit event under StrictMode', async () => {
    tauri = mockTauri()
    tauri.hold()
    const { props } = setup()
    renderHook(useQuitAndClose, { props, strict: true })
    await settle()
    tauri.release()
    await settle()
    for (const event of QUIT_EVENTS) expect(tauri.listening(event)).toBe(1)
  })

  it('calls the quit off when its save fails', async () => {
    tauri = mockTauri()
    const { core, props } = setup({ saved: false })
    renderHook(useQuitAndClose, { props })
    await settle()
    tauri.emit('devot://flush-before-exit')
    await settle()
    expect(props.saveNow).toHaveBeenCalled()
    expect(tauri.invoked).toEqual(['app_exit_cancel'])
    expect(props.setQuitHeld).toHaveBeenCalledWith(true)
    expect(core.mirrorStop).not.toHaveBeenCalled()
    expect(core.syncFlush).not.toHaveBeenCalled()
  })

  it('lets the quit go on once the save succeeds', async () => {
    tauri = mockTauri()
    const { core, props } = setup()
    renderHook(useQuitAndClose, { props })
    await settle()
    tauri.emit('devot://flush-before-exit')
    await settle()
    expect(tauri.invoked).toEqual(['app_exit_ready'])
    expect(props.markShownSeen).toHaveBeenCalledWith({ reload: false })
    expect(core.mirrorStop).toHaveBeenCalled()
    expect(core.syncFlush).toHaveBeenCalled()
    expect(props.setQuitHeld).not.toHaveBeenCalled()
  })

  it('calls a secondary window close off when its save fails', async () => {
    tauri = mockTauri()
    const { props } = setup({ primary: false, saved: false })
    renderHook(useQuitAndClose, { props })
    await settle()
    window.dispatchEvent(new Event(CLOSE_EVENT))
    await settle()
    expect(props.saveNow).toHaveBeenCalled()
    expect(tauri.invoked).toEqual(['note_window_close_cancel'])
    expect(props.setCloseHeld).toHaveBeenCalledWith(true)
  })

  it('closes a secondary window once its save succeeds', async () => {
    tauri = mockTauri()
    const { props } = setup({ primary: false })
    renderHook(useQuitAndClose, { props })
    await settle()
    window.dispatchEvent(new Event(CLOSE_EVENT))
    await settle()
    expect(tauri.invoked).toEqual(['note_window_close_ready'])
    expect(props.setCloseHeld).not.toHaveBeenCalled()
  })

  it('stops the close listener that registers after the window unmounted', async () => {
    tauri = mockTauri()
    tauri.hold()
    const { props } = setup({ primary: false })
    const hook = renderHook(useQuitAndClose, { props })
    await settle()
    hook.unmount()
    tauri.release()
    await settle()
    expect(tauri.listening('devot://note-window-close')).toBe(0)
    window.dispatchEvent(new Event(CLOSE_EVENT))
    await settle()
    expect(props.saveNow).not.toHaveBeenCalled()
  })
})
