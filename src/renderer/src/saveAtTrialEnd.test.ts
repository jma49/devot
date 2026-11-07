// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, settle, unmountAll } from '../../../tests/support/render-hook'
import type { Core } from './core-client'
import { useSaveAtTrialEnd } from './saveGuards'

afterEach(unmountAll)

function trialEnd() {
  const calls: string[] = []
  const core = {
    flush: async (options: { versions: boolean }) => {
      calls.push(`flush versions=${options.versions}`)
    },
  } as unknown as Core
  const hook = renderHook(
    ({ editing, first }: { editing: boolean; first: () => void }) =>
      useSaveAtTrialEnd(editing, core, first),
    { props: { editing: true, first: () => calls.push('first 1') } },
  )
  return { calls, hook }
}

describe('useSaveAtTrialEnd', () => {
  it('runs the latest `first`, then saves with versions, when editing ends', async () => {
    const { calls, hook } = trialEnd()
    hook.rerender({ editing: true, first: () => calls.push('first 2') })
    await settle()
    expect(calls).toEqual([])
    hook.rerender({ editing: false, first: () => calls.push('first 3') })
    await settle()
    expect(calls).toEqual(['first 3', 'flush versions=true'])
  })

  it('saves nothing for a window that opens read-only', async () => {
    const calls: string[] = []
    const core = { flush: vi.fn<() => Promise<void>>() } as unknown as Core
    renderHook(() => useSaveAtTrialEnd(false, core, () => calls.push('first')), {
      props: undefined,
    })
    await settle()
    expect(calls).toEqual([])
    expect(core.flush).not.toHaveBeenCalled()
  })
})
