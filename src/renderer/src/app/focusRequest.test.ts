// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import type { EditorHandle } from '../editor/handle'
import { useFocusRequest, useRequestedFocus } from './focusRequest'

afterEach(() => {
  vi.restoreAllMocks()
  unmountAll()
  document.body.replaceChildren()
})

function focusing(props: Parameters<typeof useFocusRequest>[0]) {
  const request = useFocusRequest(props)
  useRequestedFocus(request)
  return request
}

function titleField(value: string) {
  const field = document.createElement('input')
  field.value = value
  document.body.append(field)
  return field
}

function inertSidebarRow() {
  const sidebar = document.createElement('nav')
  sidebar.dataset.devotPart = 'sidebar'
  sidebar.inert = true
  const row = document.createElement('div')
  row.dataset.sidebarRow = ''
  row.tabIndex = 0
  sidebar.append(row)
  document.body.append(sidebar)
  return { sidebar, row }
}

const noEditor = { current: null as EditorHandle | null }

describe('useFocusRequest', () => {
  it("puts the caret at the end of the open note's title once the window renders", () => {
    const field = titleField('Groceries')
    const hook = renderHook(focusing, {
      props: { editorRef: noEditor, titleRef: { current: field }, selected: 'n1' },
    })
    act(() => hook.current.requestFocus({ kind: 'title', id: 'n1' }))
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe('Groceries'.length)
  })

  it('leaves a request to the render that carries it, not to an earlier render whose effect runs late', () => {
    const titleRef = { current: null as HTMLInputElement | null }
    const hook = renderHook(focusing, {
      props: { editorRef: noEditor, titleRef, selected: 'n1' },
    })
    // The effect of a render from before the request: React runs a pending one before the next render.
    const earlier = hook.current.moveFocus
    const field = titleField('Gamma')
    act(() => {
      hook.current.requestFocus({ kind: 'title', id: 'n1' })
      earlier()
      titleRef.current = field
    })
    expect(document.activeElement).toBe(field)
  })

  it('does a request once, not again on a later render', () => {
    const field = titleField('Groceries')
    const props = { editorRef: noEditor, titleRef: { current: field }, selected: 'n1' }
    const hook = renderHook(focusing, { props })
    act(() => hook.current.requestFocus({ kind: 'title', id: 'n1' }))
    field.blur()
    hook.rerender({ ...props })
    expect(document.activeElement).not.toBe(field)
  })

  it('drops a request for a note another one replaced meanwhile', () => {
    const field = titleField('Other')
    const props = { editorRef: noEditor, titleRef: { current: field }, selected: 'n2' }
    const hook = renderHook(focusing, { props })
    act(() => hook.current.requestFocus({ kind: 'title', id: 'n1' }))
    expect(document.activeElement).not.toBe(field)
    hook.rerender({ ...props, selected: 'n1' })
    expect(document.activeElement).not.toBe(field)
  })

  it('focuses an area that shows on a later render within the second', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const { sidebar, row } = inertSidebarRow()
    const props = { editorRef: noEditor, titleRef: { current: null }, selected: undefined }
    const hook = renderHook(focusing, { props })
    act(() => hook.current.requestFocus({ kind: 'area', area: 'sidebar' }))
    expect(document.activeElement).not.toBe(row)
    now.mockReturnValue(500)
    sidebar.inert = false
    hook.rerender({ ...props })
    expect(document.activeElement).toBe(row)
  })

  it('drops an area request whose area did not show within its second', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const { sidebar, row } = inertSidebarRow()
    const props = { editorRef: noEditor, titleRef: { current: null }, selected: undefined }
    const hook = renderHook(focusing, { props })
    act(() => hook.current.requestFocus({ kind: 'area', area: 'sidebar' }))
    now.mockReturnValue(5000)
    sidebar.inert = false
    hook.rerender({ ...props })
    expect(document.activeElement).not.toBe(row)
  })
})
