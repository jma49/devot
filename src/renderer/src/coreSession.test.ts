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

function fakeCore(saved: boolean | Promise<void>) {
  return {
    holdImport: vi.fn<() => Promise<void>>(async () => {}),
    resumeImport: vi.fn<() => Promise<void>>(async () => {}),
    stopImport: vi.fn<() => Promise<void>>(async () => {}),
    flush: vi.fn<() => Promise<void>>(() =>
      typeof saved !== 'boolean'
        ? saved
        : saved
          ? Promise.resolve()
          : Promise.reject(new Error('E_SAVE')),
    ),
    mirrorStop: vi.fn<() => Promise<void>>(async () => {}),
    syncFlush: vi.fn<() => Promise<void>>(async () => {}),
  }
}

function setup({ primary = true, saved = true as boolean | Promise<void> } = {}) {
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
    flushListsNews: vi.fn<() => void>(),
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

  it('calls the quit off when its save fails, and lets the import it held go on', async () => {
    tauri = mockTauri()
    const { core, props } = setup({ saved: false })
    renderHook(useQuitAndClose, { props })
    await settle()
    tauri.emit('devot://flush-before-exit', { round: 1 })
    await settle()
    expect(props.saveNow).toHaveBeenCalled()
    expect(core.holdImport).toHaveBeenCalledBefore(core.flush)
    expect(tauri.calls).toEqual([['app_exit_cancel', { round: 1 }]])
    expect(props.setQuitHeld).toHaveBeenCalledWith(true)
    expect(core.resumeImport).toHaveBeenCalled()
    expect(core.stopImport).not.toHaveBeenCalled()
    expect(core.mirrorStop).not.toHaveBeenCalled()
    expect(core.syncFlush).not.toHaveBeenCalled()
  })

  it('lets the quit go on once the save succeeds, ending the import it held', async () => {
    tauri = mockTauri()
    const { core, props } = setup()
    renderHook(useQuitAndClose, { props })
    await settle()
    tauri.emit('devot://flush-before-exit', { round: 2 })
    await settle()
    expect(tauri.calls).toEqual([['app_exit_ready', { round: 2 }]])
    expect(core.holdImport).toHaveBeenCalledBefore(core.flush)
    expect(core.stopImport).toHaveBeenCalledBefore(core.mirrorStop)
    expect(core.resumeImport).not.toHaveBeenCalled()
    expect(props.markShownSeen).toHaveBeenCalledWith({ reload: false })
    expect(core.mirrorStop).toHaveBeenCalled()
    expect(core.syncFlush).toHaveBeenCalled()
    expect(props.setQuitHeld).not.toHaveBeenCalled()
  })

  it('lets the quit go on at once while the window has no core', async () => {
    tauri = mockTauri()
    const { props } = setup()
    renderHook(useQuitAndClose, {
      props: { ...props, core: undefined, coreRef: { current: undefined } },
    })
    await settle()
    tauri.emit('devot://flush-before-exit', { round: 1 })
    await settle()
    expect(tauri.calls).toEqual([['app_exit_ready', { round: 1 }]])
    expect(props.markShownSeen).not.toHaveBeenCalled()
  })

  it('answers an idle check with nothing unsaved while the window has no core', async () => {
    const answers: unknown[] = []
    tauri = mockTauri((cmd, args) => {
      if (cmd === 'background_idle_answer') answers.push(args['saved'])
      return null
    })
    const { props } = setup()
    renderHook(useQuitAndClose, {
      props: { ...props, core: undefined, coreRef: { current: undefined } },
    })
    await settle()
    tauri.emit('devot://background-idle-check')
    await settle()
    expect(answers).toEqual([true])
  })

  it('saves with the core the window adopted after it began to listen', async () => {
    tauri = mockTauri()
    const { core, props } = setup()
    const coreRef: { current: Core | undefined } = { current: undefined }
    renderHook(useQuitAndClose, { props: { ...props, core: undefined, coreRef } })
    await settle()
    coreRef.current = core as unknown as Core
    tauri.emit('devot://flush-before-exit', { round: 1 })
    await settle()
    expect(core.flush).toHaveBeenCalled()
    expect(tauri.calls).toEqual([['app_exit_ready', { round: 1 }]])
  })

  it('stops nothing for a quit another window calls off while this one saves, and lets its import go on', async () => {
    tauri = mockTauri()
    let saved: () => void = () => {}
    const { core, props } = setup({ saved: new Promise<void>((resolve) => (saved = resolve)) })
    renderHook(useQuitAndClose, { props })
    await settle()
    tauri.emit('devot://flush-before-exit', { round: 1 })
    await settle()
    tauri.emit(EXIT_CANCELLED_EVENT, { round: 1 })
    await settle()
    expect(core.resumeImport).not.toHaveBeenCalled()
    saved()
    await settle()
    expect(tauri.invoked).toEqual([])
    expect(core.stopImport).not.toHaveBeenCalled()
    expect(core.mirrorStop).not.toHaveBeenCalled()
    expect(core.resumeImport).toHaveBeenCalledOnce()
  })

  it('answers no quit whose event carries no round', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tauri = mockTauri()
    const { core, props } = setup()
    renderHook(useQuitAndClose, { props })
    await settle()
    tauri.emit('devot://flush-before-exit')
    await settle()
    expect(tauri.invoked).toEqual([])
    expect(core.holdImport).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('W_EXIT_ROUND_MISSING')
    warn.mockRestore()
  })

  it('calls a secondary window close off when its save fails, and lets its import go on', async () => {
    tauri = mockTauri()
    const { core, props } = setup({ primary: false, saved: false })
    renderHook(useQuitAndClose, { props })
    await settle()
    window.dispatchEvent(new Event(CLOSE_EVENT))
    await settle()
    expect(props.saveNow).toHaveBeenCalled()
    expect(tauri.invoked).toEqual(['note_window_close_cancel'])
    expect(props.setCloseHeld).toHaveBeenCalledWith(true)
    expect(core.holdImport).toHaveBeenCalledBefore(core.flush)
    expect(core.resumeImport).toHaveBeenCalled()
    expect(core.stopImport).not.toHaveBeenCalled()
  })

  it('closes a secondary window once its save succeeds, ending its import', async () => {
    tauri = mockTauri()
    const { core, props } = setup({ primary: false })
    renderHook(useQuitAndClose, { props })
    await settle()
    window.dispatchEvent(new Event(CLOSE_EVENT))
    await settle()
    expect(tauri.invoked).toEqual(['note_window_close_ready'])
    expect(props.setCloseHeld).not.toHaveBeenCalled()
    expect(core.stopImport).toHaveBeenCalled()
    expect(core.resumeImport).not.toHaveBeenCalled()
  })

  it('tells the other main windows of its writes before a secondary window closes', async () => {
    tauri = mockTauri()
    const { props } = setup({ primary: false })
    const order: string[] = []
    props.markShownSeen.mockImplementation(async () => void order.push('seen'))
    props.flushListsNews.mockImplementation(() => {
      order.push(`news after ${tauri.invoked.length} calls`)
    })
    renderHook(useQuitAndClose, { props })
    await settle()
    window.dispatchEvent(new Event(CLOSE_EVENT))
    await settle()
    expect(order).toEqual(['seen', 'news after 0 calls'])
    expect(tauri.invoked).toEqual(['note_window_close_ready'])
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
