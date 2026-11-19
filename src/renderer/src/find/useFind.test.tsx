// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { NO_MATCHES, type FindTarget } from './target'
import { useFind } from './useFind'

afterEach(unmountAll)

const target = (): FindTarget => ({
  canReplace: false,
  search: vi.fn<FindTarget['search']>(),
  next: vi.fn<FindTarget['next']>(),
  previous: vi.fn<FindTarget['previous']>(),
  replace: vi.fn<FindTarget['replace']>(),
  replaceAll: vi.fn<FindTarget['replaceAll']>(),
  clear: vi.fn<FindTarget['clear']>(),
  status: () => NO_MATCHES,
  selectedText: () => '',
  owns: () => false,
  focus: vi.fn<FindTarget['focus']>(),
  subscribe: () => () => undefined,
})

describe('find while the preview registers', () => {
  it('keeps Cmd+F until the preview target arrives', () => {
    const hook = renderHook(
      (preview: FindTarget | null) =>
        useFind({ mode: 'preview', noteOpen: true, editing: true, editor: null, preview }),
      { props: null as FindTarget | null },
    )
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true }))
    })
    expect(hook.current.bar).not.toBeNull()
    const preview = target()
    hook.rerender(preview)
    expect(preview.search).toHaveBeenCalledWith(
      { query: '', regexp: false, caseSensitive: false },
      undefined,
    )
    hook.unmount()
    expect(preview.clear).toHaveBeenCalledOnce()
  })

  it('does not open before the editor registers', () => {
    const hook = renderHook(
      () => useFind({ mode: 'edit', noteOpen: true, editing: true, editor: null, preview: null }),
      { props: undefined },
    )
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true }))
    })
    expect(hook.current.bar).toBeNull()
  })

  it('does not open without a note', () => {
    const hook = renderHook(
      () =>
        useFind({ mode: 'preview', noteOpen: false, editing: true, editor: null, preview: null }),
      { props: undefined },
    )
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true }))
    })
    expect(hook.current.bar).toBeNull()
  })
})
