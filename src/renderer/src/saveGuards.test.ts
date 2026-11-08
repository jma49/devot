import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createMirrorRunner,
  createNoteService,
  observeWrites,
  type MirrorRunner,
} from '../../core'
import { folderHost } from '../../../tests/support/mirror-host'
import { tempSqliteAdapter } from '../../../tests/support/sqlite-adapter'
import { tempDir } from '../../../tests/support/temp-dirs'
import { answerAsked, quitAnswers, quitRound } from './saveGuards'
import { createQuitGuard } from './saving'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<void>>(),
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
    await answerAsked({ round: 3 }, createQuitGuard(), Promise.resolve(), held, async () => {
      steps.push('before')
    })
    expect(steps).toEqual(['before', 'app_exit_ready'])
    expect(tauri.invoke).toHaveBeenCalledWith('app_exit_ready', { round: 3 }, undefined)
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

  it('holds a failed quit with the quit command and its round', async () => {
    tauri.invoke.mockResolvedValue()
    const held = vi.fn<() => void>()
    await answerAsked({ round: 2 }, createQuitGuard(), Promise.reject(new Error('E_X')), held)
    expect(held).toHaveBeenCalledOnce()
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith('app_exit_cancel', { round: 2 }, undefined)
  })

  it('goes no further with a quit called off while it saved: it stops nothing and answers nothing', async () => {
    tauri.invoke.mockResolvedValue()
    const held = vi.fn<() => void>()
    const before = vi.fn<() => Promise<void>>().mockResolvedValue()
    await answerAsked(
      { round: 1, calledOff: () => true },
      createQuitGuard(),
      Promise.resolve(),
      held,
      before,
    )
    expect(before).not.toHaveBeenCalled()
    expect(held).not.toHaveBeenCalled()
    expect(tauri.invoke).not.toHaveBeenCalled()
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

describe('quitAnswers', () => {
  it('answers one quit at a time, and starts what a call-off ends only after the answer it ends', async () => {
    const answers = quitAnswers()
    const steps: string[] = []
    let saved: () => void = () => {}
    const saving = new Promise<void>((resolve) => (saved = resolve))
    const first = answers.asked(1, async (asked) => {
      steps.push('save 1')
      await saving
      steps.push(asked.calledOff?.() ? 'called off 1' : 'ready 1')
    })
    const restarted = answers.calledOff(1, () => void steps.push('restart'))
    const second = answers.asked(2, async (asked) => {
      steps.push(asked.calledOff?.() ? 'called off 2' : 'save 2')
    })
    await Promise.resolve()
    expect(steps).toEqual(['save 1'])
    saved()
    await Promise.all([first, restarted, second])
    expect(steps).toEqual(['save 1', 'called off 1', 'restart', 'save 2'])
  })

  it('keeps the mirror running for a quit called off while this window stops it', async () => {
    tauri.invoke.mockResolvedValue()
    const sqlite = tempSqliteAdapter('devot-quit-mirror-')
    let runner: MirrorRunner | undefined
    const storage = observeWrites(sqlite, (ids) => runner?.touch(ids))
    const notes = createNoteService({
      storage,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const host = folderHost(sqlite, tempDir('devot-quit-mirror-folder-'))
    const mirror = createMirrorRunner({ storage, host, untitled: 'Untitled', delayMs: 5 })
    runner = mirror
    mirror.reconcile()
    await mirror.idle()

    // Another window's save failed: the call-off reaches this window once it has begun its last steps.
    const answers = quitAnswers()
    let restarted: Promise<unknown> = Promise.resolve()
    await answers.asked(1, (asked) =>
      answerAsked(
        asked,
        createQuitGuard(),
        Promise.resolve(),
        () => {},
        async () => {
          restarted = answers.calledOff(1, () => mirror.reconcile())
          await mirror.stop()
        },
      ),
    )
    await restarted
    await mirror.idle()
    host.clear()

    const id = await notes.create('Kept', null)
    await notes.setBody(id, 'Still mirrored.\n')
    await notes.release(id)
    await notes.flush()
    await mirror.idle()
    expect(host.log.written).toContain('Kept.md')
    await mirror.stop()
    sqlite.close()
  })

  it('goes on with the next answer after one that failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = quitAnswers()
    const next = vi.fn<() => Promise<void>>(async () => {})
    void answers.asked(1, () => Promise.reject(new Error('E_COMMAND_FAILED')))
    await answers.asked(2, next)
    expect(next).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('W_EXIT_ANSWER_FAILED', 'E_COMMAND_FAILED')
    warn.mockRestore()
  })
})

describe('quitRound', () => {
  it('reads the round Rust numbered the quit with, and nothing else', () => {
    expect(quitRound({ round: 4 })).toBe(4)
    for (const payload of [undefined, null, 4, {}, { round: 0 }, { round: 1.5 }, { round: '2' }]) {
      expect(quitRound(payload)).toBeUndefined()
    }
  })
})
