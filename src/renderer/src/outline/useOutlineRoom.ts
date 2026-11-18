import { useLayoutEffect, useState, type RefObject } from 'react'
import { inspectorRoom } from './room'
import type { Mode } from '../viewModes'
import { INSPECTOR_PANE } from '../paneWidth'
import { usePaneResize } from '../paneResize'

/**
 * The inspector's width and resize edge, kept within the room the panes leave at their least width
 * (the token sizes are read from the page); `fits` is false when not even its minimum fits.
 */
export function useOutlineRoom(
  panes: RefObject<HTMLElement | null>,
  mode: Mode,
  note: string | undefined,
) {
  const [room, setRoom] = useState(INSPECTOR_PANE.max)
  const resize = usePaneResize({
    ...INSPECTOR_PANE,
    max: Math.max(INSPECTOR_PANE.min, Math.min(room, INSPECTOR_PANE.max)),
  })
  useLayoutEffect(() => {
    const el = panes.current
    if (!el) return
    const measure = () => {
      const style = getComputedStyle(el)
      const size = (name: string) => parseFloat(style.getPropertyValue(name)) || 0
      setRoom(inspectorRoom(el.clientWidth, mode, size('--size-pane-min-width')))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Another note may bring other panes, so they are observed again.
  }, [panes, mode, note])
  return { ...resize, fits: room >= INSPECTOR_PANE.min }
}
