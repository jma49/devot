import { useEffect, useState, type RefObject } from 'react'
import type { Mode } from '../viewModes'
import { outlineFits } from './room'

/** Tracks the panes' width, which decides whether the outline has room (the token sizes are read from the page). */
export function useOutlineRoom(
  panes: RefObject<HTMLElement | null>,
  mode: Mode,
  note: string | undefined,
): boolean {
  const [fits, setFits] = useState(true)
  useEffect(() => {
    const el = panes.current
    if (!el) return
    const measure = () => {
      const style = getComputedStyle(el)
      const size = (name: string) => parseFloat(style.getPropertyValue(name)) || 0
      setFits(
        outlineFits(
          el.clientWidth,
          mode,
          size('--size-pane-min-width'),
          size('--size-outline-width'),
        ),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Another note may bring other panes, so they are observed again.
  }, [panes, mode, note])
  return fits
}
