// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { useQuickTagNote } from './useQuickTagNote'

afterEach(unmountAll)

describe('useQuickTagNote', () => {
  it('keeps the popover on its note while that note stays open', () => {
    const hook = renderHook(useQuickTagNote, { props: 'a' as string | undefined })
    act(() => hook.current[1]('a'))
    hook.rerender('a')
    expect(hook.current[0]).toBe('a')
  })

  it('closes it for good when another note opens, so going back shows it closed', () => {
    const hook = renderHook(useQuickTagNote, { props: 'a' as string | undefined })
    act(() => hook.current[1]('a'))
    hook.rerender('b')
    expect(hook.current[0]).toBeUndefined()
    hook.rerender('a')
    expect(hook.current[0]).toBeUndefined()
  })

  it('closes it when no note is open', () => {
    const hook = renderHook(useQuickTagNote, { props: 'a' as string | undefined })
    act(() => hook.current[1]('a'))
    hook.rerender(undefined)
    expect(hook.current[0]).toBeUndefined()
  })
})
