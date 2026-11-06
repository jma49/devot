// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import type { Core } from '../core-client'
import { useTitleRename } from './useTitleRename'

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

function renaming(selected: string | undefined = 'n1') {
  const setTitle = vi.fn<(title: string) => void>()
  const retitleListed = vi.fn<(id: string, named: string) => void>()
  const setCoreTitle = vi.fn<(id: string, title: string) => Promise<void>>(async () => {})
  const core = { setTitle: setCoreTitle } as unknown as Core
  const props: Parameters<typeof useTitleRename>[0] = { core, selected, setTitle, retitleListed }
  return {
    hook: renderHook(useTitleRename, { props }),
    props,
    setTitle,
    retitleListed,
    setCoreTitle,
  }
}

describe('useTitleRename', () => {
  it('saves each title typed, and lists it once typing pauses', () => {
    vi.useFakeTimers()
    const { hook, setTitle, retitleListed, setCoreTitle } = renaming()
    hook.current('Gro')
    hook.current('Groceries')
    expect(setTitle).toHaveBeenLastCalledWith('Groceries')
    expect(setCoreTitle).toHaveBeenLastCalledWith('n1', 'Groceries')
    expect(retitleListed).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(retitleListed).toHaveBeenCalledExactlyOnceWith('n1', 'Groceries')
  })

  it('keeps a pasted title to one line', () => {
    const { hook, setCoreTitle } = renaming()
    hook.current('first\nsecond')
    expect(setCoreTitle.mock.calls[0]?.[1]).not.toContain('\n')
  })

  it("lists the last note's typed title at once when another note is renamed", () => {
    vi.useFakeTimers()
    const { hook, props, retitleListed } = renaming('n1')
    hook.current('One')
    hook.rerender({ ...props, selected: 'n2' })
    hook.current('Two')
    expect(retitleListed).toHaveBeenCalledExactlyOnceWith('n1', 'One')
  })

  it('renames nothing with no note open', () => {
    const { hook, props, setCoreTitle } = renaming()
    hook.rerender({ ...props, selected: undefined })
    hook.current('Lost')
    expect(setCoreTitle).not.toHaveBeenCalled()
  })
})
