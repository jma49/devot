import { useEffect, useRef, useState, type RefObject } from 'react'
import { areaTargets, type Area } from '../areas'
import type { EditorHandle } from '../editor/handle'

const AREA_ASK_MS = 1000

export type FocusRequest =
  | { kind: 'area'; area: Area }
  /** `start`: the caret at the start of the body. */
  | { kind: 'title' | 'body'; id: string; start?: boolean }

/** Keyboard moves asked for from events and timers, made once the window has rendered what they need (`useRequestedFocus`). */
export function useFocusRequest({
  editorRef,
  titleRef,
  selected,
}: {
  editorRef: RefObject<EditorHandle | null>
  titleRef: RefObject<HTMLInputElement | null>
  selected: string | undefined
}) {
  const focusAfter = useRef<FocusRequest>(undefined)
  const focusAskedAt = useRef(0)
  const [, setFocusAsked] = useState(0)
  const requestFocus = (request: FocusRequest) => {
    focusAfter.current = request
    focusAskedAt.current = performance.now()
    setFocusAsked((n) => n + 1)
  }
  // A requested keyboard move, once the window has rendered what it needs: an area, or a note's title/body once that note is open (a loading editor takes it itself, `editNote`).
  const moveFocus = () => {
    const request = focusAfter.current
    if (!request) return
    if (request.kind === 'area') {
      const go = areaTargets(editorRef.current)[request.area]
      // The area may show on a pass of its own (a sidebar the same click
      // shows): the ask stays for the passes of the next second.
      if (!go && performance.now() - focusAskedAt.current < AREA_ASK_MS) return
      focusAfter.current = undefined
      return go?.()
    }
    // The note opened before the request was made; another one opened since.
    focusAfter.current = undefined
    if (request.id !== selected) return
    if (request.kind === 'body') {
      return request.start ? editorRef.current?.focusStart() : editorRef.current?.focus()
    }
    const field = titleRef.current
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
  }
  return { requestFocus, moveFocus }
}

/** Makes the keyboard move asked for once the render it waited for has committed. */
export function useRequestedFocus({ moveFocus }: ReturnType<typeof useFocusRequest>) {
  useEffect(() => moveFocus())
}
