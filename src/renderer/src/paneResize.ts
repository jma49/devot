// The drag and keyboard behaviour of a pane's resize edge, shared by the sidebar, the note list and
// the inspector: pointer capture, arrow keys, Home/End, Enter and double-click to reset. The width
// is saved when a drag or key ends; a reset forgets it, so the pane follows its default or `fitted`
// width again.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import {
  clampPaneWidth,
  currentPaneWidthStore,
  paneDirection,
  paneWidthForKey,
  shownPaneWidth,
  type PaneSpec,
} from './paneWidth'

export function usePaneResize(pane: PaneSpec, fitted?: number) {
  const [stored, setStored] = useState(() => currentPaneWidthStore(pane).stored())
  const width = shownPaneWidth(pane, stored, fitted)
  const resizing = useRef<{ x: number; width: number; stored: number | undefined } | null>(null)
  const displayedWidth = (edge: HTMLDivElement) =>
    edge.parentElement?.getBoundingClientRect().width || width
  const keep = (next: number) => {
    setStored(next)
    currentPaneWidthStore(pane).write(next)
  }
  const reset = () => {
    setStored(undefined)
    currentPaneWidthStore(pane).clear()
  }
  const dragged = (from: { x: number; width: number }, e: PointerEvent<HTMLDivElement>) =>
    clampPaneWidth(
      pane,
      from.width + (e.clientX - from.x) * paneDirection(pane, document.dir === 'rtl'),
    )

  const edge = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuenow': width,
    'aria-valuemin': pane.min,
    'aria-valuemax': pane.max,
    tabIndex: 0,
    onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const next = paneWidthForKey(
        pane,
        e.key,
        e.shiftKey,
        displayedWidth(e.currentTarget),
        document.dir === 'rtl',
      )
      if (next === undefined) return
      e.preventDefault()
      if (next === 'reset') reset()
      else keep(next)
    },
    onDoubleClick: reset,
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      resizing.current = { x: e.clientX, width: displayedWidth(e.currentTarget), stored }
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      const from = resizing.current
      if (from) setStored(dragged(from, e))
    },
    onPointerUp: end,
    onPointerCancel: end,
  }
  function end(e: PointerEvent<HTMLDivElement>) {
    const from = resizing.current
    if (!from) return
    resizing.current = null
    const next = dragged(from, e)
    // A press or a drag back to its start must not save the CSS-clamped width over the preference.
    if (next === from.width) setStored(from.stored)
    else keep(next)
  }
  return { width, edge }
}
