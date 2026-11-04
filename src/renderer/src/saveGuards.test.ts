import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerAsked } from './saveGuards'
import { createQuitGuard } from './saving'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string) => Promise<void>>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))

afterEach(() => {
  tauri.invoke.mockReset()
})

describe('answerAsked', () => {
  it('lets a quit go on after a save, running the last steps first', async () => {
    const steps: string[] = []
    tauri.invoke.mockImplementation(async (cmd) => void steps.push(cmd))
    const held = vi.fn<() => void>()
    await answerAsked('quit', createQuitGuard(), Promise.resolve(), held, async () => {
      steps.push('before')
    })
    expect(steps).toEqual(['before', 'app_exit_ready'])
    expect(held).not.toHaveBeenCalled()
  })

  it('calls off the first close whose save fails and lets the next go on without it', async () => {
    tauri.invoke.mockResolvedValue()
    const guard = createQuitGuard()
    const held = vi.fn<() => void>()
    const before = vi.fn<() => Promise<void>>().mockResolvedValue()

    await answerAsked('close', guard, Promise.reject(new Error('E_STORAGE_SQLITE')), held, before)
    expect(held).toHaveBeenCalledOnce()
    expect(before).not.toHaveBeenCalled()
    expect(tauri.invoke).toHaveBeenLastCalledWith('note_window_close_cancel', undefined, undefined)

    await answerAsked('close', guard, Promise.reject(new Error('E_STORAGE_SQLITE')), held, before)
    expect(held).toHaveBeenCalledOnce()
    expect(before).toHaveBeenCalledOnce()
    expect(tauri.invoke).toHaveBeenLastCalledWith('note_window_close_ready', undefined, undefined)
  })

  it('holds a failed quit with the quit command', async () => {
    tauri.invoke.mockResolvedValue()
    const held = vi.fn<() => void>()
    await answerAsked('quit', createQuitGuard(), Promise.reject(new Error('E_X')), held)
    expect(held).toHaveBeenCalledOnce()
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith('app_exit_cancel', undefined, undefined)
  })

  it('lets a window with nothing to save go, whatever the guard held before', async () => {
    tauri.invoke.mockResolvedValue()
    const guard = createQuitGuard()
    const held = vi.fn<() => void>()
    await answerAsked('close', guard, undefined, held)
    expect(held).not.toHaveBeenCalled()
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith(
      'note_window_close_ready',
      undefined,
      undefined,
    )
  })
})
