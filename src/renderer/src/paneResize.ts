// The drag and keyboard behaviour of a pane's resize edge, shared by the
// sidebar and the note list: pointer capture, arrow keys, Home/End, Enter
// and double-click to reset. The width is saved when a drag or key ends.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampPaneWidth, currentPaneWidthStore, paneWidthForKey, type PaneSpec } from './paneWidth'

export function usePaneResize(pane: PaneSpec) {
  const [width, setWidth] = useState(() => currentPaneWidthStore(pane).read())
  const resizing = useRef<{ x: number; width: number } | null>(null)
  const keep = (next: number) => {
    setWidth(next)
    currentPaneWidthStore(pane).write(next)
  }
  const dragged = (from: { x: number; width: number }, e: PointerEvent<HTMLDivElement>) =>
    clampPaneWidth(pane, from.width + e.clientX - from.x)

  const edge = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuenow': width,
    'aria-valuemin': pane.min,
    'aria-valuemax': pane.max,
    tabIndex: 0,
    onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const next = paneWidthForKey(pane, e.key, e.shiftKey, width)
      if (next === undefined) return
      e.preventDefault()
      keep(next)
    },
    onDoubleClick() {
      keep(pane.default)
    },
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      resizing.current = { x: e.clientX, width }
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      const from = resizing.current
      if (from) setWidth(dragged(from, e))
    },
    onPointerUp: end,
    onPointerCancel: end,
  }
  function end(e: PointerEvent<HTMLDivElement>) {
    const from = resizing.current
    if (!from) return
    resizing.current = null
    keep(dragged(from, e))
  }
  return { width, edge }
}
