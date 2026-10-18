// A slider whose value applies while it is dragged: it is stored at most once
// per DRAG_SAVE_MS, and the last value once the drag stops, so every window
// follows the drag without each step being stored and sent. The slider shows
// the dragged value until the stored one catches up; otherwise it shows the
// stored value (also after a change made elsewhere).
import { useEffect, useRef, useState } from 'react'

/** How often a dragged slider stores its value. */
export const DRAG_SAVE_MS = 100

export interface ThrottledStore {
  /** Stores `value` now, or once DRAG_SAVE_MS has passed since the last store. */
  push(value: number): void
  /** Stores a value still waiting, at once. */
  flush(): void
  cancel(): void
}

export function throttledStore(
  store: (value: number) => void,
  now: () => number = Date.now,
): ThrottledStore {
  let last = -Infinity
  let waiting: { timer: ReturnType<typeof setTimeout>; value: number } | null = null
  const send = (value: number) => {
    waiting = null
    last = now()
    store(value)
  }
  return {
    push(value) {
      if (waiting) clearTimeout(waiting.timer)
      waiting = null
      const wait = DRAG_SAVE_MS - (now() - last)
      if (wait <= 0) send(value)
      else waiting = { timer: setTimeout(() => send(value), wait), value }
    },
    flush() {
      if (!waiting) return
      clearTimeout(waiting.timer)
      send(waiting.value)
    },
    cancel() {
      if (waiting) clearTimeout(waiting.timer)
      waiting = null
    },
  }
}

export function useDraggedNumber({
  stored,
  store,
}: {
  stored: number
  store: (value: number) => void
}) {
  const [dragged, setDragged] = useState<number | null>(null)
  const dragging = useRef(false)
  // Made once: `store` stores a value the same way on every render.
  const [saver] = useState(() => throttledStore(store))
  useEffect(() => () => saver.cancel(), [saver])
  // Once the drag is over, the next stored value (the last one sent, or a
  // change made elsewhere) is what the slider shows.
  useEffect(() => {
    if (!dragging.current) setDragged(null)
  }, [stored])

  return {
    value: dragged ?? stored,
    drag(value: number) {
      dragging.current = true
      setDragged(value)
      saver.push(value)
    },
    release() {
      if (!dragging.current) return
      dragging.current = false
      saver.flush()
    },
  }
}
