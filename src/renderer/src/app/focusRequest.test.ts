// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import type { EditorHandle } from '../editor/handle'
import { useFocusRequest, useRequestedFocus } from './focusRequest'

afterEach(() => {
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

  it('drops a request for a note another one replaced meanwhile', () => {
    const field = titleField('Other')
    const props = { editorRef: noEditor, titleRef: { current: field }, selected: 'n2' }
    const hook = renderHook(focusing, { props })
    act(() => hook.current.requestFocus({ kind: 'title', id: 'n1' }))
    expect(document.activeElement).not.toBe(field)
    hook.rerender({ ...props, selected: 'n1' })
    expect(document.activeElement).not.toBe(field)
  })
})
