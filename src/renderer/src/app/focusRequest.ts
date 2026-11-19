import { useEffect, useRef, useState, type RefObject } from 'react'
import { areaTargets, type Area } from '../areas'
import type { EditorHandle } from '../editor/handle'

const AREA_ASK_MS = 1000

export type FocusRequest =
  | { kind: 'area'; area: Area }
  /** `start`: the caret at the start of the body. */
  | { kind: 'title' | 'body'; id: string; start?: boolean }

interface Asked {
  request: FocusRequest
  at: number
  seq: number
}

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
  // State, not a ref: an earlier render's effect that React runs late must not see the request.
  const [asked, setAsked] = useState<Asked>()
  const asks = useRef(0)
  const waiting = useRef<number>(undefined)
  const requestFocus = (request: FocusRequest) => {
    asks.current += 1
    waiting.current = asks.current
    setAsked({ request, at: performance.now(), seq: asks.current })
  }
  // A requested keyboard move, once the window has rendered what it needs: an area, or a note's title/body once that note is open (a loading editor takes it itself, `editNote`).
  const moveFocus = () => {
    if (!asked || asked.seq !== waiting.current) return
    const { request } = asked
    if (request.kind === 'area') {
      // The area may show on a pass of its own (a sidebar the same click
      // shows): the ask stays for the passes of the next second, and a pass
      // after that drops it, so a later render cannot carry it out.
      const fresh = performance.now() - asked.at < AREA_ASK_MS
      const go = fresh ? areaTargets(editorRef.current)[request.area] : undefined
      if (!go && fresh) return
      waiting.current = undefined
      return go?.()
    }
    // The note opened before the request was made; another one opened since.
    waiting.current = undefined
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
